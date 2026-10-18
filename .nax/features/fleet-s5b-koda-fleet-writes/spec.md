# SPEC: Fleet S5b-2b-2 — Koda Fleet Write Tools (dispatch, requeue, cancel)

## Summary

S5b-2b-1 (`fleet-s5b-koda-write-tools`, PR #298) added the ticket and knowledge write tools on the S5b-2a
pending-action machinery. This feature adds the three fleet write tools, the second half of S5b-2b (umbrella row 6,
ruling 2b-R1):

- `koda_dispatch_job` dispatches one RUN or PLAN job on one of the project's repositories, with a required cost cap.
- `koda_requeue_job` requeues one CRASHED, FAILED or CANCELLED job of the project.
- `koda_cancel_job` cancels one active job of the project.

Like every write tool, each call is previewed and proposed, never executed. The user approves or rejects it on the
thread card or in the inbox. An approved action runs the same `FleetJobsService` method the fleet routes call, as the
requester. When the service refuses at approval time (an open PR, a duplicate active job, a paused budget, a job whose
state moved), the action is `FAILED` with a one-line reason the agent and the user can read.

Umbrella design `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R4, S5b-R6; §7; §10
row 6). Machinery: `.nax/features/fleet-s5b-koda-actions/spec.md` (2a-1) and
`.nax/features/fleet-s5b-koda-write-tools/spec.md` (2b-1), whose error classes and executor mappings this feature
reuses unchanged.

## Motivation

S5b-R4 puts fleet dispatch in scope for the assistant, and the umbrella's example asks include "plan this spec" and
"re-run the job that crashed". Today a thread can read jobs (`koda_list_jobs`, `koda_get_job`) but cannot start, retry
or stop one: the user has to leave the thread for the fleet page.

The machinery is complete. A write tool is a descriptor, a parser, a preview and an execute
(`apps/api/src/fleet/assistant/assistant-tool.types.ts`). The executor already maps a preview's `ToolInputError` to
`invalid_input: <reason>` and an `execute`'s `ToolActionError` to a `FAILED` action carrying its text
(`assistant-tool.executor.ts`, `proposeWrite` and `executeAction`). What is missing is the three tools, and a way to
turn the fleet services' 409 and 400 refusals into that text: today any `AppException` other than not-found that an
`execute` throws becomes `error: <tool> failed`, which hides why a dispatch did not happen.

## Design

### Rulings that bind every story

Accepted by the user 2026-10-17 (design doc §9.110), stated here as 2b2 rulings:

- **2b2-R1** `koda_dispatch_job` calls `FleetJobsService.dispatch` directly and does **not** bind the job to the
  thread: no `threadId` option. The thread hand-off path (`opts.threadId`) locks an idle thread, and the calling
  thread is never idle while its turn runs, so it would always answer `threads.busy`.
- **2b2-R2** `maxCostUsd` is required. The tool has no default cost.
- **2b2-R3** A RUN whose tickets already have an open VCS PR fails the action. The tool has no `acknowledgeOpenPr`
  input; the user dispatches from the fleet page to override.
- **2b2-R4** `koda_requeue_job` and `koda_cancel_job` both need the CASL ability `update` `FleetJob`. Cancel calls the
  service with `canOperate: true`; the route's own-job path for a requester without that ability is not exposed. For
  human roles this changes nothing: only DEVELOPER and ADMIN hold `create` `FleetJob`, and both hold `update`.
- **2b2-R5** A THREAD job is never requeued or cancelled through a tool. A thread session ends through end-session, as
  the requeue route already enforces (`fleet-jobs.service.ts`, `requeue`).
- **2b2-R6** `koda_dispatch_job` takes no `pinnedRunnerId`, `selectorLabels`, `approvalTimeoutSec` or
  `acknowledgeOpenPr`. They keep the defaults `normalizeDispatch` applies.

Drafting decisions (2b2-D*):

- **2b2-D1 — Descriptors.** `FLEET_WRITE_TOOL_DESCRIPTORS` is `[KODA_DISPATCH_JOB, KODA_REQUEUE_JOB, KODA_CANCEL_JOB]`,
  appended after `WRITE_TOOL_DESCRIPTORS` in `KODA_TOOL_DESCRIPTORS`. REPO and PROJECT threads get 22 descriptors,
  WORKSPACE 23 (`KODA_TOOL_LIMITS.maxTools` is 32). Each description says the job is started, requeued or cancelled
  "only after the user approves" and tells the agent "do not call this tool again" for the same request, matching the
  2b-1 wording. Every description stays at most 2000 characters once the WORKSPACE sentence is appended (the runner
  rejects the whole list otherwise, `apps/runner/src/supervisor/assign-parser.ts`).
- **2b2-D2 — Permissions.** `koda_dispatch_job`: `{ kind: 'ability', action: 'create', subject: 'FleetJob' }`, the
  tuple the dispatch route enforces. `koda_requeue_job` and `koda_cancel_job`:
  `{ kind: 'ability', action: 'update', subject: 'FleetJob' }` (2b2-R4).
- **2b2-D3 — Input bounds.** Checked by each tool's `parse`; a violation throws `ToolInputError(<field>)`:

  | Tool | Field | Rule |
  |---|---|---|
  | dispatch | `repo` | required; string matching `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (owner/name, as the knowledge tools spell it) |
  | dispatch | `command` | required; `RUN` or `PLAN` |
  | dispatch | `feature` | required; string of 1 to 128 characters (`normalizeDispatch` applies the nax feature-name rule at preview) |
  | dispatch | `maxCostUsd` | required; a finite number, at least 0.0001, at most 10000, at most 4 decimal places (the dispatch DTO's bounds), judged as `Number(x.toFixed(4)) === x` |
  | dispatch | `ref` | optional; string of 1 to 255 characters |
  | dispatch | `planFrom` | optional; string of 1 to 512 characters |
  | dispatch | `profiles` | optional; array of at most 8 strings, each 1 to 64 characters |
  | dispatch | `bashMode` | optional; `raw`, `gated` or `escalate` |
  | dispatch | `ticketRefs` | optional; array of 1 to 20 strings each matching `TICKET_REF` |
  | requeue, cancel | `jobId` | required; string of 1 to 64 characters |

- **2b2-D4 — Preview formats.** Every preview is masked with `maskSecrets`. Optional dispatch lines appear only when
  the input has the field, in this order:

  ```text
  Dispatch RUN in web:
  repo: acme/app @ trunk
  feature: add-auth
  max cost: $0.5
  plan from: docs/specs/add-auth.md
  profiles: native-ds, fast
  bash: escalate
  tickets: WEB-1, WEB-2
  ```

  The ref is the input `ref`, or the repository's default branch when absent. The cost is `String(maxCostUsd)`.

  ```text
  Requeue job j1 in web:
  RUN add-auth on acme/app @ trunk, now FAILED
  max cost: $0.5
  ```

  ```text
  Cancel job j1 in web:
  RUN add-auth on acme/app @ trunk, now RUNNING
  ```

  The requeue and cancel job line names the repository as `owner/name` through
  `KnowledgeIndexService.resolveProjectRepo(projectId, { repoId })`, or as the job's `repoId` when that answers null.
  The max-cost line shows the job's stored `maxCostUsd` string as it is.
- **2b2-D5 — Preview checks.** The preview is where a proposal is refused, so no action exists for a request that
  cannot run:
  - dispatch: the repository resolves through `resolveProjectRepo(ctx.projectId, { owner, name })`, else
    `NotFoundAppException` (the executor answers `not_found`). Then `normalizeDispatch(dto, repo.defaultBranch)` runs;
    its `ValidationAppException` becomes `ToolInputError(<its args.reason>)`.
  - requeue and cancel: the job is read through `FleetJobsService.get(ctx.projectId, jobId)`, so a job of another
    project answers `not_found`. A THREAD job throws `ToolInputError('command')` (2b2-R5); this check runs before the
    state check, so a THREAD job in any state answers `command`. Requeue refuses a state
    `canTransition(state, 'QUEUED', 'server')` rejects, and cancel a state `isTerminal` accepts, with
    `ToolInputError('state')`.
- **2b2-D6 — Execution.** `execute` runs as the requester:
  - dispatch: `FleetJobsService.dispatch(ctx.actor.id, ctx.projectId, dto, { ticketActor: { principal: ctx.actor,
    projectSlug: ctx.projectSlug } })`, with no `threadId` (2b2-R1). `dto` holds the resolved `repoId` and the input's
    other fields, absent fields left out. `execute` resolves the repository again; when it no longer resolves it
    throws `NotFoundAppException` before calling the service, so the action is `FAILED` with result `not_found`.
    Result: `dispatched <jobId>: <state> /<slug>/fleet/jobs/<jobId>`.
  - requeue: `FleetJobsService.requeue(ctx.actor.id, ctx.projectId, jobId)`. Result:
    `requeued <jobId>: <state> /<slug>/fleet/jobs/<jobId>`.
  - cancel: `FleetJobsService.cancel(ctx.actor.id, ctx.projectId, jobId, true)`. Result:
    `cancelled <jobId> /<slug>/fleet/jobs/<jobId>` when the answered state is `CANCELLED`, else
    `cancel requested for <jobId> (<state>) /<slug>/fleet/jobs/<jobId>` (the runner reports `CANCELLED` later).
  - The job id and state come from the service's answer (`DispatchResultDto.job` or `FleetJobDto`).
  - A refusal the service throws becomes `ToolActionError('<verb> refused: <text>')`, where `<verb>` is `dispatch`,
    `requeue` or `cancel` and `<text>` is `fleetWriteRefusal(error)`. When that answers null the error is rethrown,
    so `NotFoundAppException` still answers `not_found` and anything else `error: <tool> failed`.
- **2b2-D7 — Refusal text.** `fleetWriteRefusal(error: unknown): string | null`, in `tools/fleet-write-refusal.ts`,
  reads an `AppException`'s `prefix` and `args`:

  | Exception | `prefix` | Text |
  |---|---|---|
  | `ConflictAppException` | `fleet.jobState` | `job is <args.state>` |
  | `ConflictAppException` | `fleet.jobs` | `job <args.activeJobId> is already active for this feature` |
  | `ConflictAppException` | `fleet.dispatchOpenPr` | `open PR on <args.refs>` |
  | `BudgetPausedException` | `fleet.budgetPaused` | `budget paused for <args.scope>` |
  | `ConflictAppException` | `fleet.configRequeue` | `the config edit ended <args.outcome>` |
  | `ValidationAppException` | `fleet.dispatchInput` | `invalid <args.reason>` |
  | anything else | — | null |

- **2b2-D8 — Files.** One file per tool. A new provider `FleetWriteTools` (`tools/fleet-write-tools.ts`) registers the
  three in `onModuleInit`, injecting `AssistantToolRegistry`, `FleetJobsService` and `KnowledgeIndexService`, both of
  which `AssistantModule` already imports (`FleetJobsModule`, `KnowledgeModule`). `jobPath` moves from a private
  helper of `tools/fleet-tools.ts` to an export of `tools/tool-input.ts`, unchanged.

### Integration

Read-only — the feature calls these as they are:

- `FleetJobsService.dispatch(actorId, projectId, dto: DispatchFleetJobDto, opts)`, `requeue(actorId, projectId,
  jobId): Promise<DispatchResultDto>`, `cancel(actorId, projectId, jobId, canOperate): Promise<FleetJobDto>` and
  `get(projectId, id): Promise<FleetJobDto>` — `apps/api/src/fleet/jobs/fleet-jobs.service.ts`.
- `normalizeDispatch(dto, defaultBranch)` — throws `ValidationAppException({ reason }, 'fleet.dispatchInput')`
  (`fleet/jobs/dispatch-input.ts`).
- `canTransition(from, to, by)` and `isTerminal(state)` — `fleet/jobs/job-state.ts`. `isThreadKind(command)` —
  `fleet/common/thread-jobs.ts`.
- `KnowledgeIndexService.resolveProjectRepo(projectId, selector): Promise<KnowledgeRepoRef | null>`, where
  `KnowledgeRepoRef` has `id`, `owner`, `name` and `defaultBranch` (`fleet/knowledge/knowledge-index.service.ts`).
- `ConflictAppException` (`common/exceptions/conflict-app.exception.ts`), `BudgetPausedException`
  (`fleet/budgets/budget.exceptions.ts`), `ValidationAppException` and `AppException.prefix` / `.args`
  (`@nathapp/nestjs-common`).
- `ToolInputError`, `ToolActionError`, `AssistantTool` — `fleet/assistant/assistant-tool.types.ts`. `asRecord`,
  `TICKET_REF`, `maskSecrets` as in 2b-1.
- The pattern to mirror: `updateTicketTool` and `TicketWriteTools` (`fleet/assistant/tools/update-ticket-tool.ts`,
  `ticket-write-tools.ts`).

Changed — the baseline exists only to locate the code; the target is the interface to implement:

- `KODA_TOOL_DESCRIPTORS` (`koda-tool-descriptors.ts`)
  - Baseline: `[...TICKET, ...FLEET, ...KNOWLEDGE, ...ACTION, ...WRITE_TOOL_DESCRIPTORS]` (19 entries).
  - Target: the same with `...FLEET_WRITE_TOOL_DESCRIPTORS` appended last (22 entries), plus the exported constants
    `KODA_DISPATCH_JOB`, `KODA_REQUEUE_JOB`, `KODA_CANCEL_JOB` and `FLEET_WRITE_TOOL_DESCRIPTORS`.
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts`
  - Baseline: declares `jobPath` as a private module helper.
  - Target: imports `jobPath` from `tools/tool-input.ts`, which exports it with the same behaviour.

### Failure Handling

| Case | Behaviour |
|---|---|
| Requester lacks the tool's ability (VIEWER) | `forbidden: <tool> needs <action> FleetJob on <slug>`; no action (existing executor path) |
| Dispatch `repo` is not a repository of the project | `not_found`; no action |
| Requeue or cancel `jobId` is not a job of the project | `not_found`; no action |
| Input outside 2b2-D3 | `invalid_input: <field>`; no action |
| `normalizeDispatch` refuses the dispatch | `invalid_input: <reason>`; no action |
| Requeue or cancel of a THREAD job | `invalid_input: command`; no action |
| Job not requeueable, or already terminal, at proposal | `invalid_input: state`; no action |
| The service refuses at approval (open PR, duplicate active job, paused budget, state moved, config edit, invalid ticket) | `FAILED`, result `<verb> refused: <text>` (2b2-D7) |
| Any other error at approval | `FAILED`, result `error: <tool> failed` (existing mapping) |

## Out of Scope

- Binding a dispatched job to the calling thread, or reporting its progress or outcome back into the thread (2b2-R1).
- A default `maxCostUsd`, or a cost cap stricter than the dispatch DTO's bounds and the existing budget policies (2b2-R2).
- An `acknowledgeOpenPr` input; a RUN on a ticket with an open PR fails the action (2b2-R3).
- `pinnedRunnerId`, `selectorLabels` and `approvalTimeoutSec` inputs to `koda_dispatch_job` (2b2-R6).
- Cancelling a job through a tool on the strength of having requested it, without `update` `FleetJob` (2b2-R4).
- Requeueing or cancelling a THREAD job through a tool (2b2-R5).
- Dispatching CONFIG_EDIT, CONFIG_DRIFT or THREAD jobs; `koda_dispatch_job` takes `RUN` or `PLAN` only.
- Any web change: the thread card, the inbox panel and the system notes already render every write tool from its preview text.
- Changes to the runner, the fleet protocol or `FLEET_PROTOCOL_VERSION`.
- Editing a proposed action's input before deciding it (umbrella §12).
- Rate limiting dispatches beyond the 2a cap on pending actions per thread and the existing budget policies.
- Validating `ticketRefs` at preview; an unknown or unlinkable ticket fails the approved action with `dispatch refused: invalid ticket <ref>`.
- Richer `invalid_input` refusal text (koda #299).
- Placement details (the assigned runner id or misfits) in the action result.
- US-003 only: a requester without `create` `FleetJob` (a VIEWER) is refused by the existing executor ability path (2a); this feature adds no AC for it.
- US-003 only: an unknown `command` answers `invalid_input: command` from the parser; this feature adds no AC for it.
- US-003 only: a `maxCostUsd` below 0.0001, above 10000 or with more than 4 decimal places answers `invalid_input: maxCostUsd` from the parser (2b2-D3); this feature adds no AC for those bounds.
- US-003 only: a repository that stops resolving between proposal and approval fails the action with `not_found` (2b2-D6); this feature adds no AC for it.
- Restricting `koda_requeue_job` and `koda_cancel_job` to RUN and PLAN jobs; CONFIG_EDIT and CONFIG_DRIFT jobs are requeued and cancelled as the routes allow, and the preview names their command.
- US-004 only: a requester without `update` `FleetJob` (a VIEWER) is refused by the existing executor ability path (2a); this feature adds no AC for it.
- US-005 only: a requester without `update` `FleetJob` (a VIEWER) is refused by the existing executor ability path (2a); this feature adds no AC for it.
- US-004 only: a `jobId` of another project answers `not_found` through `FleetJobsService.get` and the existing executor preview mapping; this feature adds no `koda_requeue_job` AC for the not-found answer itself.
- US-005 only: a `jobId` of another project answers `not_found` through `FleetJobsService.get` and the existing executor preview mapping; this feature adds no `koda_cancel_job` AC for it.
- US-005 only: when the job's repository no longer resolves, the second preview line names the repository id instead of owner/name; this feature adds no `koda_cancel_job` AC for it.
- A job whose state moves between the preview check and the approval is refused by the service at approval; the window is not locked at proposal.

## Stories

1. **US-001: Fleet write descriptors and `jobPath`** — `Workdir: apps/api` — No dependencies.
2. **US-002: Fleet refusal text** — `Workdir: apps/api` — No dependencies.
3. **US-003: `koda_dispatch_job`** — `Workdir: apps/api` — Depends on US-001, US-002.
4. **US-004: `koda_requeue_job`** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: `koda_cancel_job`** — `Workdir: apps/api` — Depends on US-004.

- US-001 adds the three descriptors and moves `jobPath`. US-002 adds `fleetWriteRefusal`. Tool stories add only their
  tools.
- The tool stories run one after another, because each adds a registration test to `assistant.module.spec.ts`.
  US-003 creates `FleetWriteTools`; US-004 and US-005 register their tools in it (an additive edit to a file this
  feature creates, so it has no Modifies entry).
- Integration tests are one file per tool story. They enter at the runner tool route
  `POST /api/fleet/runner/jobs/:jobId/tools/<name>?leaseEpoch=<n>` and decide at
  `POST /api/projects/web/fleet/approvals/:approvalId/decide`, where `approvalId` is the stored `PendingAction`'s
  `approvalId`.
- The fixtures follow `test/integration/fleet/assistant-update-ticket-tool.integration.spec.ts`:
  - `seedFleetHttpWorld`: project `web` with the GitHub repository `acme/app` (default branch `trunk`), and a foreign
    project `ops` holding `acme/ops`;
  - DEVELOPER `dev`;
  - a RUNNING REPO THREAD job from `seedThreadJobFor`, created by `dev`;
  - `FLEET_THREADS_ENABLED=true` before boot.
- A requeue or cancel test creates the RUN job it acts on itself, in the state it needs, with `prisma.fleetJob.create`
  on `acme/app`, the way `seedThreadJobFor` creates the THREAD job, and gives it a feature no other test uses. Each test
  reads only what it wrote, and the tests pass in any order (`.nax/rules/api-test-isolation.md`).
- A job the requeue test approves is created with `selectorLabels: ['no-such-label']`. The requeue keeps the labels,
  placement reports a `labels` misfit against the fixture runner, and the job stays `QUEUED` instead of taking the
  runner's one slot.
- Each propose-then-approve pair of integration ACs is one test: it proposes, approves and reads back in a single
  `it`, as `assistant-update-ticket-tool.integration.spec.ts` does.
- The tests need the compose test DB (`bun run test:db:up`).
- No story changes the Prisma schema or the API contract, so none regenerates `openapi.json`.

### Context Files

**US-001**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `WRITE_TOOL_DESCRIPTORS`, `KODA_TOOL_DESCRIPTORS`, `kodaToolDescriptorsFor`
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the descriptor tests this story updates
- `apps/api/src/fleet/assistant/tools/tool-input.ts` — `asRecord`, `ticketPath`
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts` — `jobPath`
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — the dispatch bounds the descriptor mirrors

**US-002**

- `apps/api/src/common/exceptions/conflict-app.exception.ts` — `ConflictAppException`
- `apps/api/src/fleet/budgets/budget.exceptions.ts` — `BudgetPausedException`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — the prefixes and args each refusal carries
- `apps/api/src/fleet/jobs/dispatch-input.ts` — `fail`, the `fleet.dispatchInput` reason

**US-003**

- `apps/api/src/fleet/assistant/tools/update-ticket-tool.ts` — the write-tool pattern to mirror
- `apps/api/src/fleet/assistant/tools/ticket-write-tools.ts` — the provider pattern to mirror
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`
- `apps/api/src/fleet/knowledge/knowledge-index.service.ts` — `resolveProjectRepo`
- `apps/api/test/integration/fleet/assistant-update-ticket-tool.integration.spec.ts` — route and decide fixtures

**US-004**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `requeue`, `get`
- `apps/api/src/fleet/jobs/job-state.ts` — `canTransition`
- `apps/api/src/fleet/assistant/tools/fleet-write-tools.ts` — created by US-003; this story registers `requeueJobTool` in its `onModuleInit`
- `apps/api/src/fleet/assistant/tools/fleet-write-refusal.ts` — created by US-002; `fleetWriteRefusal`
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts` — created by US-003; route and decide fixtures

**US-005**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `cancel`, `get`
- `apps/api/src/fleet/jobs/job-state.ts` — `isTerminal`
- `apps/api/src/fleet/assistant/tools/fleet-write-tools.ts` — created by US-003; this story registers `cancelJobTool` in its `onModuleInit`
- `apps/api/src/fleet/assistant/tools/requeue-job-tool.ts` — created by US-004; the job preview line to match
- `apps/api/test/integration/fleet/assistant-requeue-job-tool.integration.spec.ts` — created by US-004; route, decide and job-seeding fixtures

### Creates

**US-001**

None. The story changes only existing files (see Modifies).

**US-002**

- `apps/api/src/fleet/assistant/tools/fleet-write-refusal.ts` — `fleetWriteRefusal`
- `apps/api/src/fleet/assistant/tools/fleet-write-refusal.spec.ts` — its unit tests

**US-003**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts` — `dispatchJobTool`
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.spec.ts` — its unit tests
- `apps/api/src/fleet/assistant/tools/fleet-write-tools.ts` — the `FleetWriteTools` provider, registering `dispatchJobTool`
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts` — route and approve tests

**US-004**

- `apps/api/src/fleet/assistant/tools/requeue-job-tool.ts` — `requeueJobTool`
- `apps/api/src/fleet/assistant/tools/requeue-job-tool.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/assistant-requeue-job-tool.integration.spec.ts` — route and approve tests

**US-005**

- `apps/api/src/fleet/assistant/tools/cancel-job-tool.ts` — `cancelJobTool`
- `apps/api/src/fleet/assistant/tools/cancel-job-tool.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/assistant-cancel-job-tool.integration.spec.ts` — route and approve tests

### Modifies

**US-001**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — gains `KODA_DISPATCH_JOB`, `KODA_REQUEUE_JOB`, `KODA_CANCEL_JOB` and `FLEET_WRITE_TOOL_DESCRIPTORS`, appended last in `KODA_TOOL_DESCRIPTORS` (2b2-D1); every existing descriptor unchanged.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the three fleet write descriptors are appended after the write group, so: the test `gives REPO and PROJECT 19 descriptors and WORKSPACE 20` becomes 22 and 23 and its `at(-1)` name check becomes `koda_cancel_job`; the 2b-1 tests `AC-4: REPO answers 19 descriptors` and `AC-5: WORKSPACE answers 20 descriptors` become 22 and 23; the 2b-1 test `AC-2: REPO ends with the WRITE_TOOL_DESCRIPTORS entries` asserts instead that the five write entries directly precede the three `FLEET_WRITE_TOOL_DESCRIPTORS` entries; every slice that offsets by `WRITE_TOOL_DESCRIPTORS.length` (the `AC-3` and `AC-15` tests naming `koda_get_action` and `koda_add_comment`, and the `AC-22` prefix tests that also subtract `ACTION_TOOL_DESCRIPTORS.length`) offsets by `WRITE_TOOL_DESCRIPTORS.length + FLEET_WRITE_TOOL_DESCRIPTORS.length` instead; the `AC-22` full-list equality of `KODA_TOOL_DESCRIPTORS` gains `...FLEET_WRITE_TOOL_DESCRIPTORS` last. No other assertion changes.
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts` — imports `jobPath` from the shared tool-input helper module instead of declaring it (2b2-D8); behaviour unchanged.
- `apps/api/src/fleet/assistant/tools/tool-input.ts` — gains the exported `jobPath(slug, jobId)` helper moved from the fleet read tools module; `asRecord` and `ticketPath` unchanged.
- `apps/api/src/fleet/assistant/tools/tool-input.spec.ts` — gains a `jobPath` test; the existing two tests unchanged.

**US-002**

None. The story only creates the refusal helper and its spec; no existing assertion pins the shapes it reads.

**US-003**

- `apps/api/src/fleet/assistant/assistant.module.ts` — the providers list gains `FleetWriteTools`; no import changes (`FleetJobsModule` and `KnowledgeModule` are already imported).
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_dispatch_job` is registered as a write tool with its permission; existing tests unchanged.

**US-004**

- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_requeue_job` is registered as a write tool with its permission; existing tests unchanged.

**US-005**

- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_cancel_job` is registered as a write tool with its permission; existing tests unchanged.

### Seams

- **US-001 → US-003 .. US-005.** A tool reaches the agent only once `FleetWriteTools` registers it under its US-001
  descriptor's name with `kind: 'write'`. Each tool story pins the registration in `assistant.module.spec.ts`, and its
  route test proves the real path, because only a registered write tool answers `pending ` at the runner tool route.
- **US-002 → US-003 .. US-005.** `fleetWriteRefusal` reaches the action result only through a tool's `execute`. Each
  tool story has a unit test that stubs the service to throw a real exception and asserts the `ToolActionError` text,
  which needs the real helper (not a stub of it).
- **US-003 → `FleetJobsService.dispatch`.** The dispatch unit tests assert the exact arguments the stubbed service
  receives, including the absence of `threadId` (2b2-R1); the route test approves a real dispatch and reads the stored
  job.

## Acceptance Criteria

### US-001: Fleet write descriptors and `jobPath` (`Workdir: apps/api`)

1. [unit] `FLEET_WRITE_TOOL_DESCRIPTORS.map((d) => d.name)` equals `['koda_dispatch_job', 'koda_requeue_job', 'koda_cancel_job']`.
2. [unit] The last three entries of `kodaToolDescriptorsFor('REPO')` are the `FLEET_WRITE_TOOL_DESCRIPTORS` entries, in order.
3. [unit] The five entries of `kodaToolDescriptorsFor('REPO')` before those three are the `WRITE_TOOL_DESCRIPTORS` entries, in order.
4. [unit] `kodaToolDescriptorsFor('REPO')` has 22 entries.
5. [unit] `kodaToolDescriptorsFor('WORKSPACE')` has 23 entries.
6. [unit] Every `FLEET_WRITE_TOOL_DESCRIPTORS` entry's `description` contains `only after the user approves`.
7. [unit] Every `FLEET_WRITE_TOOL_DESCRIPTORS` entry's `description` contains `do not call this tool again`.
8. [unit] `KODA_DISPATCH_JOB.inputSchema.required` equals `['repo', 'command', 'feature', 'maxCostUsd']`.
9. [unit] `KODA_DISPATCH_JOB.inputSchema.properties.command.enum` equals `['RUN', 'PLAN']`.
10. [unit] `KODA_DISPATCH_JOB.inputSchema.properties.maxCostUsd.minimum` equals `0.0001`.
11. [unit] `KODA_DISPATCH_JOB.inputSchema.properties.maxCostUsd.maximum` equals `10000`.
12. [unit] `KODA_REQUEUE_JOB.inputSchema.required` equals `['jobId']`.
13. [unit] `KODA_CANCEL_JOB.inputSchema.required` equals `['jobId']`.
14. [unit] `jobPath('web', 'j1')`, imported from `tools/tool-input.ts`, returns `/web/fleet/jobs/j1`.

### US-002: Fleet refusal text (`Workdir: apps/api`)

1. [unit] `fleetWriteRefusal(new ConflictAppException({ state: 'RUNNING' }, 'fleet.jobState'))` returns `job is RUNNING`.
2. [unit] `fleetWriteRefusal(new ConflictAppException({ activeJobId: 'j9' }, 'fleet.jobs'))` returns `job j9 is already active for this feature`.
3. [unit] `fleetWriteRefusal(new ConflictAppException({ refs: 'WEB-1, WEB-2' }, 'fleet.dispatchOpenPr'))` returns `open PR on WEB-1, WEB-2`.
4. [unit] `fleetWriteRefusal` for a `BudgetPausedException` built from a policy whose `scopeKey` is `project:p1` returns `budget paused for project:p1`.
5. [unit] `fleetWriteRefusal(new ConflictAppException({ outcome: 'conflict' }, 'fleet.configRequeue'))` returns `the config edit ended conflict`.
6. [unit] `fleetWriteRefusal(new ValidationAppException({ reason: 'ticket WEB-9' }, 'fleet.dispatchInput'))` returns `invalid ticket WEB-9`.
7. [unit] `fleetWriteRefusal(new ConflictAppException({}, 'threads.busy'))` returns `null`.
8. [unit] `fleetWriteRefusal(new Error('boom'))` returns `null`.

### US-003: `koda_dispatch_job` (`Workdir: apps/api`)

1. [unit] `dispatchJobTool(...).parse({ repo: 'acme/app', command: 'RUN', feature: 'add-auth' })` throws `ToolInputError` with reason `maxCostUsd`.
2. [unit] `dispatchJobTool(...).preview` in project `web` for `{ repo: 'acme/app', command: 'PLAN', feature: 'add-auth', maxCostUsd: 0.5, planFrom: 'docs/ghp_abcdefghijklmnopqrstuvwxyz0123456789.md' }`, when `resolveProjectRepo` answers `acme/app` with default branch `trunk`, returns exactly `Dispatch PLAN in web:\nrepo: acme/app @ trunk\nfeature: add-auth\nmax cost: $0.5\nplan from: docs/[masked].md`.
3. [unit] `dispatchJobTool(...).parse` with `repo` `app` and otherwise valid input throws `ToolInputError` with reason `repo`.
4. [unit] `dispatchJobTool(...).preview` in project `web` for `{ repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release', profiles: ['native-ds', 'fast'], bashMode: 'escalate', ticketRefs: ['WEB-1', 'WEB-2'] }`, when `resolveProjectRepo` answers `acme/app` with default branch `trunk`, returns exactly `Dispatch RUN in web:\nrepo: acme/app @ release\nfeature: add-auth\nmax cost: $0.5\nprofiles: native-ds, fast\nbash: escalate\ntickets: WEB-1, WEB-2`.
5. [unit] `dispatchJobTool(...).preview` for `repo` `acme/ops`, when `KnowledgeIndexService.resolveProjectRepo` answers `null`, throws `NotFoundAppException`.
6. [unit] `dispatchJobTool(...).preview` for a `PLAN` with no `planFrom` throws `ToolInputError` with reason `planFrom required for PLAN`.
7. [unit] For `dispatchJobTool(...).execute` with `{ repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release', profiles: ['native-ds'], bashMode: 'escalate', ticketRefs: ['WEB-1'] }`, when `resolveProjectRepo` answers repository id `r1`, the third argument `FleetJobsService.dispatch` receives equals `{ repoId: 'r1', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release', profiles: ['native-ds'], bashMode: 'escalate', ticketRefs: ['WEB-1'] }`, with no other key.
8. [unit] For `dispatchJobTool(...).execute` in project `web`, the first two arguments `FleetJobsService.dispatch` receives are `ctx.actor.id` and `ctx.projectId`.
9. [unit] For `dispatchJobTool(...).execute` in project `web`, the fourth argument `FleetJobsService.dispatch` receives deep-equals `{ ticketActor: { principal: ctx.actor, projectSlug: 'web' } }`, with no `threadId` key.
10. [unit] `dispatchJobTool(...).execute` in project `web`, when `FleetJobsService.dispatch` answers a `DispatchResultDto` whose `job` has id `j1` and state `QUEUED`, returns `dispatched j1: QUEUED /web/fleet/jobs/j1`.
11. [unit] `dispatchJobTool(...).execute`, when `FleetJobsService.dispatch` throws `new ConflictAppException({ refs: 'WEB-1' }, 'fleet.dispatchOpenPr')`, throws a `ToolActionError` whose `text` is `dispatch refused: open PR on WEB-1`.
12. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_dispatch_job')?.permission` equals `{ kind: 'ability', action: 'create', subject: 'FleetJob' }`.
13. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_dispatch_job?leaseEpoch=<n>` from the runner holding `dev`'s RUNNING REPO THREAD job, with `{ repo: 'acme/app', command: 'RUN', feature: <a feature no other test uses>, maxCostUsd: 0.5 }`, answers 200 with content starting `pending `.
14. [integration] After `dev` approves that action at `POST /projects/web/fleet/approvals/:approvalId/decide` with `{ decision: 'approve' }`, the project's FleetJob with that feature has `requestedById` equal to `dev`'s id.
15. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_dispatch_job?leaseEpoch=<n>` from the same runner with `repo` `acme/ops` (the foreign project's repository) answers content `not_found`, and no `PendingAction` exists for that tool call.

### US-004: `koda_requeue_job` (`Workdir: apps/api`)

1. [unit] `requeueJobTool(...).parse({})` throws `ToolInputError` with reason `jobId`.
2. [unit] `requeueJobTool(...).preview` in project `web` for a FAILED RUN job `j1` with feature `add-auth`, ref `trunk` and `maxCostUsd` `'0.5'`, when `resolveProjectRepo` answers `acme/app`, returns exactly `Requeue job j1 in web:\nRUN add-auth on acme/app @ trunk, now FAILED\nmax cost: $0.5`.
3. [unit] `requeueJobTool(...).preview` for that job when `resolveProjectRepo` answers `null` and the job's `repoId` is `r1` returns text whose second line is `RUN add-auth on r1 @ trunk, now FAILED`.
4. [unit] `requeueJobTool(...).preview` for a job whose state is `RUNNING` throws `ToolInputError` with reason `state`.
5. [unit] `requeueJobTool(...).preview` for a CRASHED job whose command is `THREAD` throws `ToolInputError` with reason `command`.
6. [unit] `requeueJobTool(...).preview` with `ctx.projectId` `p1` for `{ jobId: 'j1' }` reads the job through `FleetJobsService.get` with `('p1', 'j1')`.
7. [unit] For `requeueJobTool(...).execute` with `{ jobId: 'j1' }`, `FleetJobsService.requeue` receives `(ctx.actor.id, ctx.projectId, 'j1')`.
8. [unit] `requeueJobTool(...).execute` in project `web`, when `FleetJobsService.requeue` answers a `DispatchResultDto` whose `job` has id `j1` and state `QUEUED`, returns `requeued j1: QUEUED /web/fleet/jobs/j1`.
9. [unit] `requeueJobTool(...).execute`, when `FleetJobsService.requeue` throws `new ConflictAppException({ state: 'QUEUED' }, 'fleet.jobState')`, throws a `ToolActionError` whose `text` is `requeue refused: job is QUEUED`.
10. [unit] `requeueJobTool(...).execute`, when `FleetJobsService.requeue` throws a `BudgetPausedException` whose policy `scopeKey` is `project:p1`, throws a `ToolActionError` whose `text` is `requeue refused: budget paused for project:p1`.
11. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_requeue_job')?.permission` equals `{ kind: 'ability', action: 'update', subject: 'FleetJob' }`.
12. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_requeue_job?leaseEpoch=<n>` from the runner holding `dev`'s RUNNING REPO THREAD job, for a FAILED RUN job of `web` that the test created with `selectorLabels: ['no-such-label']`, answers 200 with content starting `pending `.
13. [integration] After `dev` approves that action at `POST /projects/web/fleet/approvals/:approvalId/decide` with `{ decision: 'approve' }`, that FleetJob's `state` is `QUEUED`.
14. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_requeue_job?leaseEpoch=<n>` from the same runner, for a RUNNING RUN job of `web` that the test created, answers content `invalid_input: state`.
15. [unit] `requeueJobTool(...).preview` for a FAILED job whose feature is `ghp_abcdefghijklmnopqrstuvwxyz0123456789` returns text in which `ghp_abcdefghijklmnopqrstuvwxyz0123456789` does not appear.

### US-005: `koda_cancel_job` (`Workdir: apps/api`)

1. [unit] `cancelJobTool(...).parse({ jobId: '' })` throws `ToolInputError` with reason `jobId`.
2. [unit] `cancelJobTool(...).preview` in project `web` for a RUNNING RUN job `j1` with feature `add-auth` and ref `trunk`, when `resolveProjectRepo` answers `acme/app`, returns exactly `Cancel job j1 in web:\nRUN add-auth on acme/app @ trunk, now RUNNING`.
3. [unit] `cancelJobTool(...).preview` for a job whose state is `CANCELLED` throws `ToolInputError` with reason `state`.
4. [unit] `cancelJobTool(...).preview` for a RUNNING job whose command is `THREAD` throws `ToolInputError` with reason `command`.
5. [unit] For `cancelJobTool(...).execute` with `{ jobId: 'j1' }`, `FleetJobsService.cancel` receives `(ctx.actor.id, ctx.projectId, 'j1', true)`.
6. [unit] `cancelJobTool(...).execute` in project `web`, when `FleetJobsService.cancel` answers a `FleetJobDto` with id `j1` and state `CANCELLED`, returns `cancelled j1 /web/fleet/jobs/j1`.
7. [unit] `cancelJobTool(...).execute` in project `web`, when `FleetJobsService.cancel` answers a `FleetJobDto` with id `j1` and state `RUNNING`, returns `cancel requested for j1 (RUNNING) /web/fleet/jobs/j1`.
8. [unit] `cancelJobTool(...).execute`, when `FleetJobsService.cancel` throws `new ConflictAppException({ state: 'COMPLETED' }, 'fleet.jobState')`, throws a `ToolActionError` whose `text` is `cancel refused: job is COMPLETED`.
9. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_cancel_job')?.permission` equals `{ kind: 'ability', action: 'update', subject: 'FleetJob' }`.
10. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_cancel_job?leaseEpoch=<n>` from the runner holding `dev`'s RUNNING REPO THREAD job, for a QUEUED RUN job of `web` that the test created, answers 200 with content starting `pending `.
11. [integration] After `dev` approves that action at `POST /projects/web/fleet/approvals/:approvalId/decide` with `{ decision: 'approve' }`, that FleetJob's `state` is `CANCELLED`.
12. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_cancel_job?leaseEpoch=<n>` from the same runner, with `jobId` set to the runner's own RUNNING REPO THREAD job, answers content `invalid_input: command`.
13. [unit] `cancelJobTool(...).preview` for a RUNNING job whose feature is `ghp_abcdefghijklmnopqrstuvwxyz0123456789` returns text in which `ghp_abcdefghijklmnopqrstuvwxyz0123456789` does not appear.
