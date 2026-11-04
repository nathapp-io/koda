# SPEC: Thread agents and modes (nax chat parity)

Closes: #368, #369

## Summary

koda threads reach parity with `nax chat`. A thread can run on any of four agents: koda's native agent, and Claude
Code, Codex and Cursor over ACP (`@nathapp/nax-agent-acp` 0.91.7 `acpBackend`), on REPO, PROJECT and WORKSPACE
threads. A REPO thread runs in one of three modes, `read` (today's behaviour, the default), `ask` (the agent may edit
files and run commands, and every mutating action waits for an Approve/Deny decision in the thread) and `full` (no
prompts). The mode can change between turns. Who may use `ask` and `full` is governed by two new configurable
permission keys, `thread.mode.ask` and `thread.mode.full`. Runners advertise which ACP agents they can start and their
models, and whether they support modes; the web new-thread form offers only what can run. In `ask` and `full`,
publishing a thread commits its code changes too, not only docs.

## Motivation

A koda thread can only use the native agent and can only read code and write docs: `ThreadSessionFactory.open`
refuses every ACP backend with `backend_unavailable` and hard-codes `profile: 'read'`
(`apps/runner/src/thread/session-factory.ts:89,116`), and the runner advertises `acp: []` unconditionally
(`apps/runner/src/capabilities/nax-probe.ts:167`). To get code changes a person must dispatch a fleet RUN. `nax chat`
already offers all four agents with read/ask/full modes on one machine. The user has not started using koda day to
day; this slice is what makes threads worth using. Design: `docs/superpowers/specs/2026-11-04-thread-agents-and-modes-design.md`
(approved 2026-11-04).

## Design

### User rulings (2026-11-04)

- One spec for #368 + #369; #371 (credential vault) is its own later spec.
- Bar: parity with `nax chat`. All four agents. Modes `read`, `ask`, `full`; `full` included.
- ACP agents run unsandboxed on the runner host in every mode, exactly as `nax chat` opens them (`acpBackend({ agent,
  allowUnsandboxed: true, inheritEnv: true, model?, effort? })`, no sandbox option). Accepted by the user.
- Mode changes between turns. Permissions follow koda's configurable keys; default for `full` is owner and project
  admin.
- nax#2444 is done: `acpBackend` serves the session's declared tools over its loopback tool host, so ACP agents get
  koda's thread tools and are allowed on REPO, PROJECT and WORKSPACE threads.

### Calls made while drafting (not user rulings)

- `ask` and `full` are REPO-only. A PROJECT or WORKSPACE thread has no worktree and no publish
  (`thread-job-run.ts:395-415`), so edits there would be lost; those kinds stay `read`.
- Native `ask`/`full` sessions pass `allowUnsandboxed: true` to the native backend, as `nax chat` does
  (`chat/open-chat-session.ts`): nax's sandbox is used when the runner has one, and the session still opens when it
  does not (nax-agent throws `AGENT_SESSION_SANDBOX_UNAVAILABLE` for `ask`/`full` otherwise).
- `thread.mode.` joins `HIGH_RISK_PREFIXES`, so both keys are high risk: approvable, floor `none`, default `agent`
  (an agent waits for approval by default, a human acts directly), like other high-risk keys.
- The mode is not re-checked on every message: a thread keeps its mode until someone changes it (see Out of Scope).

### Integration

Read-only symbols (verified on `feat/thread-agents-modes` = main `7093ced1` + docs):

- `ThreadSessionFactory.open(input: OpenThreadSessionOptions): Promise<OpenThreadSessionResult>`
  (`apps/runner/src/thread/session-factory.ts:84`); `OpenThreadSessionOptions { jobId; thread: ThreadAssign; worktree;
  tools: CreateAgentSessionOptions['tools']; approvalTimeoutSec }`; it maps `AGENT_SESSION_AUTH_REQUIRED` to
  `agent_not_logged_in` and `AGENT_SESSION_BACKEND_UNAVAILABLE` to `backend_unavailable` (`:60-61`) and resumes with
  `resumeAgentSession`, falling back to `createAgentSession` on `AGENT_SESSION_NOT_FOUND` (`:126-144`). Resume does not
  store the profile; it is passed again on every resume, so a resumed session can open with a different profile.
- `ThreadJobRun` opens the session with `[...buildThreadTools(...), ...this.kodaToolProxies(thread)]`
  (`apps/runner/src/thread/thread-job-run.ts:325-344`, PROJECT path `:397`); live publish runs through
  `ThreadLivePublish` (`:365-376`), the PUBLISH job through `thread-action-run.ts:31-42`.
- Each turn is a THREAD job: `createThreadJob` creates the job and a `FleetThreadTurn` row snapshotting `backend`,
  `skills`, `instructions` and `resume` (`apps/api/src/fleet/threads/prisma-chat-thread.repository.ts:513-536`);
  `findThreadAssign(jobId)` builds the `ThreadAssign` from that row (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:274-291`).
  `command(scope, threadId, userId, type, payload, canOperate)` (`prisma-chat-thread.repository.ts:205-250`) sends
  `THREAD_ANSWER`, `THREAD_STOP_TURN`, `THREAD_CLOSE` to the thread's RUNNING job; for `THREAD_ANSWER` it currently
  requires `payload.requestId === pendingQuestion.requestId` (`:207-211`). `sendRefusalFor(thread, job)` (`:457`)
  answers whether a message may start or reach a turn (`turnRunning`, `closing`, ...).
- `ThreadJobEffects.onJobEnded(job)` (`apps/api/src/fleet/threads/thread-job-effects.ts:42`) settles a thread when its
  job ends (it clears `pendingQuestion`).
- Route gating: `this.routeGate.run({ key, variant, ... })` with `@Requires` and `@ApprovalGated()`; precedents
  `PATCH :id` (`thread.cap.update`, `threads.controller.ts:91-98`), `POST :id/answer` (`thread.answer`, `:175-187`),
  workspace `PATCH :id` (`workspace-threads.controller.ts:136-143`, `enforcedBy: 'service'`), `POST :id/answer`
  (`:187`); variants `thread-route.commands.ts:13-25`, `workspace-thread-route.commands.ts:11+`. `ApprovalGate.gate`
  throws `UnregisteredApprovalCommandError` for a (key, variant) with no registered command
  (`apps/api/src/approvals/approval-gate.service.ts:71-73`) and accepts `alsoKeys` (`:98`).
- Service-level key check: `this.permissions.can(principal, key, { projectId })` (`workspace-threads.service.ts:190,199`).
- Permission contract: every catalog key must be declared by a route, tool or system writer, or it is reported as
  `unused-key` (`apps/api/src/permissions/test-helpers/permission-contract.ts`, `findContractViolations`), unless it is
  listed in `PENDING_SURFACE_KEYS` (`apps/api/src/permissions/catalog.ts:64`); a listed key that some route declares
  is reported as `pending-key-declared`. US-004 lists both mode keys there (the create route only names them through
  `alsoKeys`, which is not a declaration); US-005 removes them in the change that declares them on the mode route.
- `thread.*.own` expands only `OWNABLE_KEYS` (`apps/api/src/permissions/entry-matcher.ts:107`).
- `RunnerSummaryDto` copies `threadBackends` as `{ native, acp }` (`apps/api/src/fleet/runners/dto/runner-summary.dto.ts:15-24`).
- From `@nathapp/nax-agent-acp/client` 0.91.7: `acpBackend`, `launchCandidateKind`; a backend's capabilities carry
  `offeredModels` and `offeredEfforts` (`dist/client/backend.js:179-183`); Cursor model ids look like
  `gpt-5.5[context=272k,reasoning=medium]`. From `@nathapp/nax-agent` 0.91.7: `AnswerReply = { decision: 'allow' |
  'deny' } | { text }`; the `approval_requested` session event `{ requestId; callId?; tool; summary; command?; reason;
  expiresAt; unsandboxed?: true; answerable?: false }`.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `ThreadAgent` (`packages/fleet-protocol/src/threads.ts:12`) and the API runtime mirror (`apps/api/src/fleet/common/thread-jobs.ts`).
  Baseline: `'claude' | 'codex'`. Target: `'claude' | 'codex' | 'cursor'`.
- `ThreadBackends` (`threads.ts:26`). Baseline: `{ native: string[]; acp: ThreadAgent[] }`. Target: `{ native:
  string[]; acp: ThreadAgent[]; acpOffers?: ThreadAcpOffer[] }`; `acp` lists the agents that are launchable AND
  logged in (placement keeps `acp.includes(agent)`); new `ThreadAcpOffer { agent: ThreadAgent; launchable: boolean;
  loggedIn: boolean | null; models: string[]; efforts: string[] }` (`loggedIn: null` = not probed or probe failed).
- New `ACP_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@=,\[\]-]{0,127}$/` (protocol constant, mirrored at runtime in
  `thread-jobs.ts`): ACP model ids in `acpOffers` and in an `acp` create backend are checked with it; native model ids
  keep `MODEL_ID_RE`.
- `RunnerCapabilities` (`packages/fleet-protocol/src/index.ts`) gains `threadModes?: true`.
- New `ThreadMode = 'read' | 'ask' | 'full'` in `threads.ts`; `ThreadAssign` gains `mode?: ThreadMode` (absent = `read`).
- `ThreadAnswerPayload` (`threads.ts:97`). Baseline: `{ requestId: string; text: string }`. Target: `{ requestId:
  string; text: string } | { requestId: string; decision: 'allow' | 'deny' }`.
- `ThreadRunnerLine` `session_started` variant gains `mode?: ThreadMode`.
- `parseThreadBackends` (`apps/api/src/fleet/common/capabilities-core.ts:64-80`). Baseline: exactly two keys,
  agents `claude|codex`. Target: agents add `cursor`; an optional `acpOffers` (at most `THREAD_LIMITS.maxAcpAgents`
  entries, each agent at most once, `models` at most `maxNativeModels` ids matching `ACP_MODEL_ID_RE`, `efforts` at
  most 8 entries matching `^[a-z0-9_-]{1,32}$`) is kept when valid and dropped when malformed, the rest of the report
  still accepted. `parseCapabilities` keeps `threadModes` only when exactly `true`.
- `RunnerSummaryDto.threadBackends` and web `RunnerThreadBackends` (`apps/web/lib/thread-types.ts`, `lib/fleet-types.ts`)
  carry a valid `acpOffers` through.
- The create normalisers in `apps/api/src/fleet/threads/thread-input.ts` (REPO/PROJECT `:72-79`,
  `validateCreateWorkspaceThread`). Baseline: `acp` agent `claude|codex`; PROJECT and WORKSPACE native-only. Target:
  `acp` agent `claude|codex|cursor` on every kind; the normalised result carries `mode` only for REPO (`read` when
  absent); `mode` `ask`/`full` on PROJECT or WORKSPACE is a validation error naming `mode`.
- Prisma `ChatThread` gains `mode String @default("read")` and `pendingApprovals Json?`; `FleetThreadTurn` gains
  `mode String @default("read")`. Migration `20261124090000_thread_modes` also appends `thread.mode.ask` to the stored
  `permissions` of the existing `developer` role when absent (precedent
  `migrations/20261106090000_approval_fleet_core/migration.sql:4-8`).
- `ApprovalRequestedThreadLine` (`apps/api/src/fleet/threads/ingest/thread-line.ts:71-75`). Baseline: `{ type;
  requestId; callId? }`. Target: also keeps `tool`, `summary`, `command?`, `reason`, `expiresAt`, `unsandboxed?`,
  `answerable` (malformed optional fields dropped; a line missing `tool`, `summary` or `expiresAt` keeps today's
  minimal shape and is not made pending).
- `ThreadDto` (`apps/api/src/fleet/threads/dto/thread.dto.ts:9`) gains `mode: ThreadMode` and `pendingApprovals:
  ThreadPendingApprovalDto[]`; `CreateThreadDto` gains optional `mode`.
- `threadAuditKey` (`apps/api/src/fleet/threads/thread-audit.ts:4`) gains the action `approve` (audited under
  `thread.answer`); the mode change records its audit entry with `audit.record` directly under the target mode's gate
  key (`threadAuditKey` takes no key).
- `publishThreadDocs` (`apps/runner/src/thread/thread-publish.ts`). Baseline: stages only paths passing
  `isAllowedThreadDocPath`, message `docs(<feature>): spec from koda thread "<title>"`. Target: takes `mode`; in
  `ask`/`full` it stages every changed regular file (`lstat().isFile()`, as today), and when a staged path is not a doc
  path the message is `feat(<feature>): changes from koda thread "<title>"`. The `publishedLineFits` limit (200 paths
  of at most 512 characters) applies unchanged.
- `readAnswer`/`applyAnswer` (`thread-job-run.ts:171-175,921-935`). Target: also accept `{ requestId, decision }` and
  call `session.answer(requestId, { decision })`.
- `ThreadSessionFactory.open`. Target: opens `acp` through an injectable `acpBackend` factory (factory dependency
  `acpBackend`, default the package's); sets `profile` from `thread.mode`; native `ask`/`full` add
  `allowUnsandboxed: true` to the native backend options.
- `NaxCapabilityProbe` (`nax-probe.ts:145-180`). Target: `NaxProbeDeps.acpProbe?: AcpAgentProbe`; when present its
  result fills `acp` and `acpOffers` (omitted when empty); when absent `acp` stays `[]`. The probe reports
  `threadModes: true`.
- `DaemonOptions` (`apps/runner/src/daemon/daemon.ts`) gains `acpProbe?: AcpAgentProbe`, passed to
  `createCapabilityProbe`; the `run` command (`apps/runner/src/commands/run.ts`) passes the real `probeAcpAgents`.
  Other `startDaemon` callers (tests) get no ACP probe.
- Assign parser (`apps/runner/src/supervisor/assign-parser.ts:34-60,320-337`). Target: accepts `cursor` (ACP model by
  `ACP_MODEL_ID_RE`) and keeps a valid `mode`; an invalid `mode` refuses the assign.
- Placement (`apps/api/src/fleet/jobs/placement-rules.ts:136-151`). Target: `PlacementThread` (`:25-31`) gains `mode`,
  filled from the thread assign by both builders in `placement.service.ts` (`:95`, `:176`); a SESSION job whose mode is
  `ask` or `full` needs `runner.capabilities.threadModes === true`, else misfit `thread_modes`. `MisfitReason`
  (`placement-rules.ts:13`), `MISFIT_REASONS` (`apps/api/src/fleet/dashboard/dashboard.types.ts:111-113`) and the
  `PlacementMisfitDto` enum (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:140`) gain `thread_modes`.

### Approach

**Agents (US-001..US-003).** `probeAcpAgents` checks `claude`, `codex`, `cursor` in parallel:
`launchCandidateKind(agent, env)` decides `launchable` (local binary or `npx` fallback); for a launchable agent it
opens a tool-less, memory-only `ask` session through `acpBackend` with `initializeTimeoutMs` 20000 and a 20 s overall
timeout, reads `backend.capabilities.offeredModels` / `offeredEfforts`, drops ids failing `ACP_MODEL_ID_RE` (models,
capped at 32) or the effort pattern (capped at 8), and closes the session; `AGENT_SESSION_AUTH_REQUIRED` gives
`loggedIn: false`; a timeout or other error gives `loggedIn: null` with empty lists, and a session that opens after its
timeout is closed when it settles. A thread pinned to a runner whose agent became unavailable fails placement with the
existing `thread_backend` misfit. Opening an `acp` thread uses `acpBackend({ agent, allowUnsandboxed: true,
inheritEnv: true, model?, effort? })` with the same session options as native (workdir, instructions, declared tools,
transcript store, approval timeout, turn timeout 900 s).

**Modes (US-004..US-006).** Profile mapping `read` → `read`, `ask` → `ask`, `full` → `full`, native and ACP alike.
`mode` lives on `ChatThread` and is snapshotted onto each `FleetThreadTurn`; `findThreadAssign` carries the turn's
mode. Creating a REPO thread with `ask`/`full` passes `alsoKeys: [<mode key>]` to the create gate and the service
checks the key (`permissions.can`) against the thread's project. `PATCH /projects/:slug/threads/:id/mode` declares
`@Requires(['thread.mode.ask', 'thread.mode.full', 'thread.cap.update'], { mode: 'any', enforcedBy: 'service' })`;
the controller validates the body and gates with the key of the TARGET mode (`read` → `thread.cap.update`), and the
route command `rest:threads.mode` is registered under all three keys. There is no WORKSPACE mode route: WORKSPACE
threads are always `read`. The caller must
also be the thread's creator or hold an any-row `thread.cap.update`. A change is refused with 409 when
`sendRefusalFor` answers `turnRunning` (a turn is QUEUED, ASSIGNED or running) or a PUBLISH/DISCARD job is active
(`threads.busy`); `closing` (a THREAD_CLOSE already queued) still changes the mode without a second command; an idle
live SESSION job gets one `THREAD_CLOSE` in the same transaction, so the next message starts a turn that resumes the
same session id with the new profile. The change writes a system message (role `system`, status `complete`, content
`Mode changed from <from> to <to> by <display name>`, the name resolved when written) and an audit entry.

**Approvals (US-007..US-009).** Ingest appends an answerable, complete `approval_requested` line to
`ChatThread.pendingApprovals` (independently of the tool-summary fold; oldest first, at most 20, later ones dropped)
and removes it on the matching `approval_resolved`; `session_closed`, `session_failed` and `onJobEnded` clear the list.
`POST /projects/:slug/threads/:id/approvals/:requestId` and `POST /threads/:id/approvals/:requestId`, body `{
decision }`, `@Requires('thread.answer')` gated like the text answer (variants `rest:threads.approve`,
`rest:workspace-threads.approve`), call `command()` with `THREAD_ANSWER { requestId, decision }`; `command()` checks a
decision payload against `pendingApprovals` (409 `threads.noApproval`) instead of `pendingQuestion`, and keeps every
other check. The runner calls `session.answer(requestId, { decision })`.

**Publish (US-010).** Both publish paths (the PUBLISH job and the live publish) pass the assign's mode.

**Web (US-011, US-012).** New-thread forms: an agent select (Native, Claude Code, Codex, Cursor) from the eligible
runners' `threadBackends`/`acpOffers`; an agent no eligible runner can start is disabled with `not installed` (no
runner has it launchable) or `not logged in` (launchable, `loggedIn === false` everywhere); models and efforts from the
chosen agent; on the project REPO form a mode select (Read, Ask, Full) limited to the modes the caller's project
permissions allow; the body always carries `mode` for REPO threads and never for PROJECT/WORKSPACE. Thread page: a mode
control (REPO threads only), one approval card per `pendingApprovals` entry (tool, summary, command, reason, an
"unsandboxed" badge when set, Approve / Deny), and system messages rendered as today.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| US-002: an ACP agent probe times out or fails | `loggedIn: null`, empty models; the other agents still reported |
| US-002: `AGENT_SESSION_AUTH_REQUIRED` from the probe | `loggedIn: false`; the agent is not in `acp` |
| US-002: a probe session opens after its timeout | it is closed when it settles |
| US-001: a runner reports malformed `acpOffers` | `acpOffers` dropped; `native` and `acp` kept |
| US-003: the agent cannot be launched at open | `backend_unavailable` |
| US-003: the agent needs login at open | `agent_not_logged_in` |
| US-004: create with `ask`/`full` without the mode key | 403; nothing written |
| US-004: `ask`/`full` on a PROJECT or WORKSPACE thread | 400 naming `mode` |
| US-004: an `ask`/`full` turn and no runner advertising `threadModes` | the job stays queued with misfit `thread_modes` |
| US-005: mode change while a turn is queued or running | 409 `threads.turnRunning`; unchanged |
| US-005: mode change while a PUBLISH/DISCARD job is active | 409 `threads.busy`; unchanged |
| US-005: mode change by a non-creator without any-row `thread.cap.update` | 403; unchanged |
| US-005: mode change without the target mode's key | 403; unchanged |
| US-005: mode change to the current mode | 200; no message, no command |
| US-008: decision for a request not pending | 409 `threads.noApproval`; nothing sent |
| US-008: decision with no live session | 409 `threads.noSession` |
| US-009: malformed decision payload on the runner | rejected, detail `invalid payload` |
| US-010: `ask`/`full` publish with only doc paths changed | `docs(...)` message |

## Out of Scope

- The central credential vault (#371): credentials stay on the runner (the agent's own login for ACP, the nax auth store or its existing `credentials.source: exec` config for native).
- Any sandbox for ACP agents: they run unsandboxed on the runner host in every mode, as in `nax chat` (user ruling).
- `ask` and `full` on PROJECT and WORKSPACE threads: those kinds have no worktree or publish and stay `read`.
- Re-checking the mode key on every message: a thread keeps its mode after its creator loses `thread.mode.full`, and an any-row `thread.message.send` holder may message an `ask`/`full` thread without holding the mode key.
- PR creation or a hand-off to a fleet RUN from a thread; changes leave only through the existing publish (commit to `feat/<feature>`) and discard.
- CLI commands for thread agents, modes or approvals.
- Changing a thread's agent (backend) after creation; only the mode changes.
- Per-turn time limits beyond the existing `turnTimeoutSeconds` 900; an approval left waiting longer ends with the turn. The cost cap applies to reported usage only, and an ACP agent that reports no usage counts as zero.
- More than 20 pending approvals per thread: later ones are not listed (the agent still waits for them until they expire).
- A publish of more than 200 changed paths, or a path over 512 characters: it fails as today.
- Publishing code changes made in `ask`/`full` after the thread is switched back to `read`: publish follows the mode at publish time, so those code changes are reported as ignored.
- ACP agents other than `claude`, `codex` and `cursor` (nax-agent-acp also knows `gemini`, `opencode`, `pi`).
- Bumping `@nathapp/nax-agent` beyond `0.91.7`.

## Stories

### US-001: API and protocol accept ACP agents on every thread kind

Workdir: `apps/api`. No dependencies. Protocol `ThreadAgent` adds `cursor` (and the runtime mirror), `ThreadAcpOffer`,
`ThreadBackends.acpOffers`, `ACP_MODEL_ID_RE`; `parseThreadBackends` accepts `cursor` and validates `acpOffers`;
`RunnerSummaryDto` carries `acpOffers`; create input accepts `acp` with `claude|codex|cursor` on every kind; placement
accepts an ACP thread only on a runner whose `threadBackends.acp` lists the agent.

### US-002: Runner advertises its ACP agents

Workdir: `apps/runner`. Depends on US-001. Add `@nathapp/nax-agent-acp` `0.91.7` (exact pin); `probeAcpAgents` in
`apps/runner/src/capabilities/acp-agent-probe.ts`; `NaxProbeDeps.acpProbe`, `DaemonOptions.acpProbe`, the `run`
command passing the real probe.

### US-003: Runner opens ACP thread sessions

Workdir: `apps/runner`. Depends on US-001, US-002. `ThreadSessionFactory.open` builds `acp` backends through the
injectable `acpBackend` factory (unsandboxed, `inheritEnv`, model, effort) with the declared tools; the assign parser
accepts `cursor`.

### US-004: Thread mode stored, permissioned, placed and carried to the runner

Workdir: `apps/api`. Depends on US-001. `ThreadMode`, `ThreadAssign.mode`, `RunnerCapabilities.threadModes` (parsed),
the `thread_modes` placement misfit, columns `ChatThread.mode` / `FleetThreadTurn.mode` and migration
`20261124090000_thread_modes` (with the developer role append), keys `thread.mode.ask` / `thread.mode.full` in
`NEW_KEY_SCOPES` with `thread.mode.` in `HIGH_RISK_PREFIXES` and both keys in `PENDING_SURFACE_KEYS`, the developer
grant, REPO create with `mode` (gate `alsoKeys`, service check), `ThreadDto.mode`, `findThreadAssign` carrying the
turn's mode, the protocol `ThreadRunnerLine` `session_started.mode` field, `PlacementThread.mode` from both placement
builders, `thread_modes` in `MisfitReason`, `MISFIT_REASONS` and the `PlacementMisfitDto` enum, regenerated
`openapi.json` and CLI client.

### US-005: Change a thread's mode between turns

Workdir: `apps/api`. Depends on US-004. `PATCH /projects/:slug/threads/:id/mode`, the multi-key `@Requires`, the route
command under the three keys, removing both mode keys from `PENDING_SURFACE_KEYS`, creator/any-row check, refusals,
`THREAD_CLOSE` of an idle session, system message, audit entry under the target key, i18n, regenerated `openapi.json`
and CLI client.

### US-006: Runner opens sessions in the thread's mode

Workdir: `apps/runner`. Depends on US-003, US-004. Assign parser keeps `mode`; the profile follows it; native
`ask`/`full` pass `allowUnsandboxed: true`; `session_started` carries `mode`; the probe reports `threadModes: true`.

### US-007: Session approvals become pending on the thread

Workdir: `apps/api`. Depends on US-004. `ApprovalRequestedThreadLine` fields; `pendingApprovals` append, resolve,
session-end and `onJobEnded` clearing, cap 20; `session_started.mode` accepted by the parser; `ThreadDto.pendingApprovals`.

### US-008: Decide a session approval

Workdir: `apps/api`. Depends on US-007. `ThreadAnswerPayload` decision form; the two approval routes; `command()`
decision branch; audit action `approve`; i18n `threads.noApproval`; regenerated `openapi.json` and CLI client.

### US-009: Runner hands decisions to the session

Workdir: `apps/runner`. Depends on US-008. `readAnswer` accepts `{ requestId, decision }`; `applyAnswer` calls
`session.answer(requestId, { decision })`.

### US-010: Publish commits code changes in ask and full modes

Workdir: `apps/runner`. Depends on US-006. `publishThreadDocs` takes `mode`; both publish paths pass the assign's mode.

### US-011: Web new-thread forms choose agent and mode

Workdir: `apps/web`. Depends on US-001, US-004. Agent select with disabled reasons, models and efforts per agent, mode
select on the project REPO form limited by permissions, request bodies.

### US-012: Web thread page changes mode and decides approvals

Workdir: `apps/web`. Depends on US-005, US-008. `ThreadModeControl`, `ThreadApprovalCard`, wiring on both thread pages.

### Context Files

**US-001**
- `packages/fleet-protocol/src/threads.ts` — the types this story changes
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseThreadBackends`
- `apps/api/src/fleet/threads/thread-input.ts` — create normalisers
- `apps/api/src/fleet/runners/dto/runner-summary.dto.ts` — runner summary projection
- `apps/api/src/fleet/jobs/placement-rules.ts` — the ACP placement rule

**US-002**
- `apps/runner/src/capabilities/nax-probe.ts` — the probe this story extends
- `apps/runner/src/capabilities/create-probe.ts` — probe construction
- `apps/runner/src/daemon/daemon.ts` — `DaemonOptions` and probe wiring
- `apps/runner/src/commands/run.ts` — the production `startDaemon` caller

**US-003**
- `apps/runner/src/thread/session-factory.ts` — the open path
- `apps/runner/src/supervisor/assign-parser.ts` — thread backend parsing

**US-004**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `createThreadJob`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES`, `PENDING_SURFACE_KEYS`
- `apps/api/src/fleet/jobs/placement-rules.ts` — `PlacementThread`, `MisfitReason`, the thread rule
- `apps/api/src/fleet/jobs/placement.service.ts` — the two placement builders

**US-005**
- `apps/api/src/fleet/threads/threads.controller.ts` — `PATCH :id` precedent
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — workspace routes
- `apps/api/src/fleet/threads/thread-route.commands.ts` — route commands
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `command()`, `sendRefusalFor`
- `apps/api/src/fleet/threads/thread-audit.ts` — audit keys

**US-006**
- `apps/runner/src/thread/session-factory.ts` — profile and backend options
- `apps/runner/src/supervisor/assign-parser.ts` — `ThreadAssign` construction
- `apps/runner/src/thread/thread-event-writer.ts` — `session_started` line
- `apps/runner/src/capabilities/nax-probe.ts` — capability flags

**US-007**
- `apps/api/src/fleet/threads/ingest/thread-line.ts` — line parsing
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — ingest
- `apps/api/src/fleet/threads/thread-job-effects.ts` — `onJobEnded`
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDto`

**US-008**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `command()`
- `apps/api/src/fleet/threads/threads.controller.ts` — answer route precedent
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — workspace answer route
- `apps/api/src/fleet/threads/thread-audit.ts` — audit keys

**US-009**
- `apps/runner/src/thread/thread-job-run.ts` — `readAnswer`, `applyAnswer`

**US-010**
- `apps/runner/src/thread/thread-publish.ts` — publish
- `apps/runner/src/thread/thread-action-run.ts` — PUBLISH job caller
- `apps/runner/src/thread/thread-live-publish.ts` — live publish caller

**US-011**
- `apps/web/pages/threads/new.vue` — workspace new-thread page
- `apps/web/pages/[project]/threads/new.vue` — project new-thread page
- `apps/web/components/fleet/threads/BackendPicker.vue` — the picker
- `apps/web/lib/thread-create.ts` — `eligibleModels`
- `apps/web/lib/thread-types.ts` — thread and backend types

**US-012**
- `apps/web/pages/[project]/threads/[id].vue` — project thread page
- `apps/web/pages/threads/[id].vue` — workspace thread page
- `apps/web/components/fleet/threads/ThreadQuestionCard.vue` — answer card precedent
- `apps/web/composables/useThread.ts` — project thread controller
- `apps/web/composables/useWorkspaceThread.ts` — workspace thread controller

### Creates

**US-002**
- `apps/runner/src/capabilities/acp-agent-probe.ts`
- `apps/runner/src/capabilities/acp-agent-probe.spec.ts`

**US-004**
- `apps/api/prisma/migrations/20261124090000_thread_modes/migration.sql`

**US-012**
- `apps/web/components/fleet/threads/ThreadApprovalCard.vue`
- `apps/web/components/fleet/threads/ThreadModeControl.vue`
- `apps/web/tests/components/thread-approval-card.spec.ts`
- `apps/web/tests/components/thread-mode-control.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/threads/thread-input.spec.ts` — its case asserting that a PROJECT thread with an `acp` backend is refused with `backend` becomes: an `acp` backend (`claude`, `codex` or `cursor`) is accepted on PROJECT; an unknown agent is still refused with `backend`.
- `apps/api/src/fleet/threads/workspace-thread-input.spec.ts` — its case asserting WORKSPACE threads refuse an `acp` backend becomes: an `acp` backend with `claude`, `codex` or `cursor` is accepted.
- `apps/api/src/fleet/common/capabilities-thread.spec.ts` — its assertion that `threadBackends` must have exactly the keys `native` and `acp` becomes: an optional valid `acpOffers` is kept, a malformed one is dropped, any other extra key is still refused.
- `apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts` — its expectation that `threadBackends` is exactly `{ native, acp }` becomes: a valid `acpOffers` is carried through, and absent when the runner reported none.

**US-002**
- `apps/runner/src/capabilities/nax-probe.spec.ts` — its assertion that `threadBackends.acp` is `[]` becomes: with no `acpProbe` it is still `[]` with no `acpOffers`; with an injected probe `acp` and `acpOffers` come from it.

**US-003**
- `apps/runner/test/unit/thread-session-factory.spec.ts` — its case asserting an `acp` backend fails with `backend_unavailable` becomes: an `acp` backend opens through the injected `acpBackend` factory; `backend_unavailable` remains for an agent that cannot be launched.
- `apps/runner/src/supervisor/assign-parser-thread.spec.ts` — its case refusing an `acp` agent other than `claude`/`codex` becomes: `cursor` is accepted; an unknown agent is still refused.

**US-004**
- `apps/api/src/permissions/role-matrix.spec.ts` — its per-role cell count `toHaveLength(227)` becomes 229 for the two new keys, and the regenerated snapshot shows `thread.mode.ask` granted to developer and above and `thread.mode.full` granted only through `*` (owner, project admin, admin).
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated with the two new keys' cells for every role.
- `apps/api/src/permissions/catalog.spec.ts` — its `NEW_KEY_SCOPES` mirror gains `thread.mode.ask: 'project'` and `thread.mode.full: 'project'`, and its re-derived `HIGH_RISK_PREFIXES` mirror gains `thread.mode.`.
- `apps/api/src/fleet/threads/thread-input.spec.ts` — its `toEqual` expectations on the normalised REPO create result gain `mode: 'read'`; PROJECT results stay without `mode`.
- `apps/api/src/fleet/threads/workspace-thread-input.spec.ts` — its `toEqual` expectations stay without `mode`; a new case refuses `mode: 'ask'`.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — its `expectedPending` set gains `thread.mode.ask` and `thread.mode.full`.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — its pinned placement-misfit enum gains `thread_modes`.

**US-005**
- `apps/api/src/fleet/threads/threads.controller.keys.spec.ts` — its handler table gains the mode handler with keys `thread.mode.ask`, `thread.mode.full`, `thread.cap.update`, mode `any`, `enforcedBy: 'service'`.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the gated-operation list gains the mode route (PATCH /api/projects/{slug}/threads/{id}/mode); the count 131 becomes 132.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated route count 131 becomes 132 (the mode route).
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — its `expectedPending` set loses `thread.mode.ask` and `thread.mode.full` again (declared by the mode route now).

**US-006**
- `apps/runner/test/unit/thread-session-factory.spec.ts` — its assertion that the session opens with `profile: 'read'` becomes: the profile follows `thread.mode` (`read` when absent).

**US-007**
- `apps/api/src/fleet/threads/ingest/thread-line.spec.ts` — its expectation that a parsed `approval_requested` line has only `requestId` (and `callId`) becomes: the line also keeps `tool`, `summary`, `command`, `reason`, `expiresAt`, `unsandboxed` and `answerable` when present and valid; its `session_started` expectations accept an optional `mode`.

**US-008**
- `apps/api/src/fleet/threads/threads.controller.keys.spec.ts` — its handler table gains the approval handler with key `thread.answer`.
- `apps/api/src/fleet/threads/workspace-threads.controller.keys.spec.ts` — its handler table gains the workspace approval handler with key `thread.answer`.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the gated-operation list gains the two approval routes (POST /api/projects/{slug}/threads/{id}/approvals/{requestId} and POST /api/threads/{id}/approvals/{requestId}); the count 132 becomes 134.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated route count 132 becomes 134 (the two approval routes).

**US-009**

None. `readAnswer` and `applyAnswer` gain a branch; the existing text-answer tests keep passing unchanged.

**US-010**
- `apps/runner/test/unit/thread-publish.spec.ts` — its case asserting a non-doc changed path is reported in `ignored` becomes: that holds in `read` mode; in `ask`/`full` the path is staged in `paths` and the message starts with `feat(`.

**US-011**
- `apps/web/tests/components/thread-backend-picker.spec.ts` — its props-only `{ models, model, effort }` rendering becomes: the picker also renders the agent select and emits `update:agent`.
- `apps/web/tests/pages/threads-new-page.spec.ts` — its expectation of the exact submitted body becomes: the body carries the chosen agent's backend (and no `mode` for a WORKSPACE thread).
- `apps/web/tests/pages/workspace-threads-new-page.spec.ts` — its exact-body expectations become: the chosen agent's backend, no `mode`.
- `apps/web/tests/lib/thread-create.spec.ts` — its exact create-body expectation for a REPO thread gains `mode` (`read` when unchanged).
- `apps/web/tests/lib/thread-create-project.spec.ts` — its exact create-body expectations stay without `mode` for PROJECT threads and accept an `acp` backend.
- `apps/web/tests/lib/workspace-thread-create.spec.ts` — its exact create-body expectation accepts an `acp` backend and has no `mode`.

**US-012**

None. The new cards are additive components; the existing page specs mount them only when `pendingApprovals` is non-empty or the thread is REPO.

### Seams

- US-001 → US-011: `ThreadAcpOffer` in the capability report and `RunnerSummaryDto`, consumed by the new-thread forms.
- US-002 → production: `probeAcpAgents` wired by the `run` command into `startDaemon`.
- US-004 → US-006: `ThreadAssign.mode` set by `findThreadAssign`, consumed by the runner's assign parser and session factory.
- US-006 → US-004: `threadModes: true` reported by the runner, consumed by placement.
- US-008 → US-009: `ThreadAnswerPayload` decision form sent by the approval route, consumed by `applyAnswer`.
- US-005, US-008 → US-012: the mode and approval routes called from the thread pages; `ThreadDto.mode` and `pendingApprovals` rendered there.

## Acceptance Criteria

### US-001: API and protocol accept ACP agents on every thread kind

- [unit] `parseThreadBackends({ native: [], acp: ['cursor'] })` returns `{ native: [], acp: ['cursor'] }`.
- [unit] `parseThreadBackends` with `acp: ['gemini']` throws the same refusal as any unknown agent.
- [unit] `parseThreadBackends` with `acpOffers: [{ agent: 'cursor', launchable: true, loggedIn: true, models: ['gpt-5.5[context=272k,reasoning=medium]'], efforts: ['high'] }]` returns it unchanged under `acpOffers`.
- [unit] `parseThreadBackends` with an `acpOffers` entry whose `models` contains `bad model!` returns a result without `acpOffers` and keeps `native` and `acp`.
- [unit] `parseThreadBackends` with two `acpOffers` entries for the same agent returns a result without `acpOffers`.
- [unit] `parseThreadBackends` with an extra key other than `acpOffers` still throws.
- [unit] `RunnerSummaryDto` built from capabilities whose `threadBackends` has a valid `acpOffers` exposes the same `acpOffers` under `threadBackends`.
- [unit] The REPO/PROJECT create normaliser accepts a PROJECT thread with backend `{ kind: 'acp', agent: 'codex' }`.
- [unit] The REPO/PROJECT create normaliser accepts a REPO thread with backend `{ kind: 'acp', agent: 'cursor', model: 'gpt-5.5[context=272k,reasoning=medium]' }`.
- [unit] The REPO/PROJECT create normaliser refuses backend `{ kind: 'acp', agent: 'gemini' }` with a validation error naming `backend`.
- [unit] `validateCreateWorkspaceThread` accepts backend `{ kind: 'acp', agent: 'claude' }`.
- [unit] The placement rule answers no misfit for a SESSION job of a PROJECT thread with backend `{ kind: 'acp', agent: 'cursor' }` on a runner whose `threadBackends.acp` is `['cursor']`.
- [unit] The placement rule answers `thread_backend` for that job on a runner whose `threadBackends.acp` is `['claude']`.

### US-002: Runner advertises its ACP agents

- [unit] `probeAcpAgents` with an injected launch check answering no candidate for `codex` reports `{ agent: 'codex', launchable: false, loggedIn: null, models: [], efforts: [] }` and opens no session for it.
- [unit] `probeAcpAgents` for a launchable `claude` whose injected probe backend reports `offeredModels: ['claude-sonnet-4-5']` and `offeredEfforts: ['high']` reports `loggedIn: true` with those lists and closes the session.
- [unit] `probeAcpAgents` drops an offered model failing `ACP_MODEL_ID_RE` and keeps the valid ones.
- [unit] `probeAcpAgents` keeps at most 32 models and 8 efforts per agent.
- [unit] `probeAcpAgents` for a launchable `cursor` whose probe open throws code `AGENT_SESSION_AUTH_REQUIRED` reports `loggedIn: false` with empty lists.
- [unit] `probeAcpAgents` with a probe open that does not settle within 20 s (injected clock) reports `loggedIn: null` for that agent and still returns the other agents.
- [unit] When a timed-out probe open settles later with a session, `probeAcpAgents` closes that session.
- [unit] `probeAcpAgents` passes `initializeTimeoutMs: 20000` to the `acpBackend` factory.
- [unit] `probeAcpAgents` starts the probe opens of two launchable agents before either resolves.
- [unit] `NaxCapabilityProbe.probe` with an injected `acpProbe` reporting `claude` launchable and logged in and `codex` launchable with `loggedIn: false` reports `threadBackends.acp` equal to `['claude']` and `acpOffers` with both entries.
- [unit] `NaxCapabilityProbe.probe` with no `acpProbe` reports `threadBackends.acp` equal to `[]` and no `acpOffers` key.
- [unit] `NaxCapabilityProbe.probe` with an `acpProbe` that throws reports `threadBackends.acp` equal to `[]` and no `acpOffers` key.
- [unit] The `run` command calls `startDaemon` with an `acpProbe` that is `probeAcpAgents`.
- [unit] `startDaemon` with an injected `acpProbe` reporting `claude` logged in sends a sync whose capabilities carry `threadBackends.acp` equal to `['claude']`.

### US-003: Runner opens ACP thread sessions

- [unit] `ThreadSessionFactory.open` with backend `{ kind: 'acp', agent: 'codex', model: 'gpt-5-codex' }` calls the injected `acpBackend` factory once with `{ agent: 'codex', allowUnsandboxed: true, inheritEnv: true, model: 'gpt-5-codex' }` and returns `{ ok: true }`.
- [unit] An `acp` backend carrying `effort: 'high'` passes `effort: 'high'` to the factory.
- [unit] An `acp` backend passes the input's `tools`, `worktree` as `workdir`, and `thread.instructions` to the created session.
- [unit] An `acp` open whose creation throws code `AGENT_SESSION_AUTH_REQUIRED` returns `{ ok: false, reason: 'agent_not_logged_in' }`.
- [unit] An `acp` open whose creation throws code `AGENT_SESSION_BACKEND_UNAVAILABLE` returns `{ ok: false, reason: 'backend_unavailable' }`.
- [unit] A native open never calls the `acpBackend` factory.
- [unit] The assign parser accepts a THREAD assign whose backend is `{ kind: 'acp', agent: 'cursor', model: 'gpt-5.5[context=272k,reasoning=medium]' }`.
- [unit] The assign parser refuses a THREAD assign whose backend is `{ kind: 'acp', agent: 'gemini' }`.

### US-004: Thread mode stored, permissioned, placed and carried to the runner

- [unit] `findCatalogEntry('thread.mode.ask')` returns scope `project`, `ownable` false, risk `high` and approval `{ approvable: true, floor: 'none', default: 'agent' }`.
- [unit] `findCatalogEntry('thread.mode.full')` returns the same shape.
- [unit] The developer system role grants `thread.mode.ask` and not `thread.mode.full`.
- [unit] `parseCapabilities` keeps `threadModes: true` and drops `threadModes: 'yes'`.
- [unit] The placement rule answers `thread_modes` for a SESSION job whose turn mode is `ask` on a runner without `threadModes`, and no misfit for a `read` turn there.
- [integration] Applying the migration to a database whose `developer` role lacks `thread.mode.ask` leaves the role holding it exactly once.
- [integration] Creating a REPO thread with no `mode` stores `read`, and the response has `mode: 'read'`.
- [integration] A developer creating a REPO thread with `mode: 'ask'` gets 201 and the stored mode is `ask`.
- [integration] A developer creating a REPO thread with `mode: 'full'` gets 403 and no thread is written.
- [integration] A project admin creating a REPO thread with `mode: 'full'` gets 201 and the stored mode is `full`.
- [integration] An agent holding `thread.create` and `thread.mode.ask` with no approval policy creating a REPO thread with `mode: 'ask'` gets 202 and no thread is written until approved.
- [integration] Creating a PROJECT thread with `mode: 'ask'` gets 400 naming `mode`.
- [integration] After a REPO thread's first message, `findThreadAssign` for the turn's job returns `mode` equal to the thread's mode.
- [integration] A turn created before the thread's mode changed keeps its own `mode` in `findThreadAssign`.

### US-005: Change a thread's mode between turns

- [integration] `PATCH /projects/:slug/threads/:id/mode` `{ mode: 'ask' }` by the creator (a developer) on a thread with no live session answers 200, stores `ask` and appends a `complete` system message `Mode changed from read to ask by <creator's name>`.
- [integration] The PATCH `{ mode: 'full' }` by a developer creator answers 403 and the mode is unchanged.
- [integration] The PATCH `{ mode: 'full' }` by a project admin who is not the creator answers 200 and stores `full`.
- [integration] The PATCH `{ mode: 'ask' }` by a developer who is not the creator answers 403.
- [integration] The PATCH `{ mode: 'read' }` from `ask` by the creator holding only `thread.cap.update.own` answers 200.
- [integration] The PATCH while the thread's SESSION job is QUEUED answers 409 `threads.turnRunning` and the mode is unchanged.
- [integration] The PATCH while a turn is running in the live session answers 409 `threads.turnRunning`.
- [integration] The PATCH while a PUBLISH job is active answers 409 `threads.busy`.
- [integration] The PATCH while the live session is idle answers 200, stores the mode and creates exactly one `THREAD_CLOSE` command for that job.
- [integration] The PATCH while a `THREAD_CLOSE` is already queued for the job answers 200, stores the mode and creates no second `THREAD_CLOSE`.
- [integration] The PATCH to the current mode answers 200 with no system message and no command.
- [integration] An agent holding `thread.mode.ask` with no approval policy calling the PATCH `{ mode: 'ask' }` gets 202 and the mode is unchanged until approved.
- [integration] A successful PATCH records an audit entry under the target mode's key whose summary names the from and to modes.
- [integration] The PATCH with `{ mode: 'bogus' }` answers 400 naming `mode`.

### US-006: Runner opens sessions in the thread's mode

- [unit] `ThreadSessionFactory.open` with `thread.mode` `ask` creates the session with `profile: 'ask'`.
- [unit] `ThreadSessionFactory.open` with `thread.mode` `full` creates the session with `profile: 'full'`.
- [unit] `ThreadSessionFactory.open` with no `thread.mode` creates the session with `profile: 'read'`.
- [unit] A native open with `thread.mode` `ask` passes `allowUnsandboxed: true` in the native backend options, and a native `read` open does not set it.
- [unit] An `acp` open with `thread.mode` `full` creates the session with `profile: 'full'`.
- [unit] The resume path passes the same `profile` to `resumeAgentSession` as the create path.
- [unit] The assign parser keeps `mode: 'full'` from a THREAD assign.
- [unit] The assign parser refuses a THREAD assign with `mode: 'write'`.
- [unit] The assign parser returns a `ThreadAssign` without `mode` when the assign has none.
- [unit] A thread job whose session opens writes a `session_started` line carrying the assign's `mode` (`read` when absent).
- [unit] `NaxCapabilityProbe.probe` reports `threadModes: true`.

### US-007: Session approvals become pending on the thread

- [unit] The thread-line parser keeps `tool`, `summary`, `command`, `reason`, `expiresAt` and `unsandboxed: true` from a valid `approval_requested` line.
- [unit] The thread-line parser reads `answerable: false` when the line says so and `answerable: true` when absent.
- [unit] The thread-line parser accepts a `session_started` line with `mode: 'ask'` and keeps the mode.
- [integration] Ingesting an answerable `approval_requested` line with no `callId` appends `{ requestId, tool, summary, command, reason, expiresAt, unsandboxed }` to `pendingApprovals`.
- [integration] Ingesting an `approval_requested` line with `answerable: false` leaves `pendingApprovals` unchanged.
- [integration] Ingesting an `approval_requested` line without `summary` leaves `pendingApprovals` unchanged.
- [integration] Ingesting the matching `approval_resolved` line removes that request.
- [integration] Ingesting a `session_closed` line clears `pendingApprovals`.
- [integration] The thread's job ending as CRASHED clears `pendingApprovals` through `onJobEnded`.
- [integration] Ingesting a 21st pending request leaves the oldest 20.
- [integration] `GET /projects/:slug/threads/:id` returns `pendingApprovals` oldest first and `mode`.

### US-008: Decide a session approval

- [integration] `POST /projects/:slug/threads/:id/approvals/:requestId` `{ decision: 'allow' }` by the turn's requester for a pending request on a live session answers 200 and creates one `THREAD_ANSWER` command with payload `{ requestId, decision: 'allow' }`.
- [integration] The same POST with `{ decision: 'deny' }` creates the command with `decision: 'deny'`.
- [integration] The decision POST succeeds while a different text question is pending, and leaves `pendingQuestion` unchanged.
- [integration] The decision POST for a request id not in `pendingApprovals` answers 409 `threads.noApproval` and creates no command.
- [integration] The decision POST with `{ decision: 'maybe' }` answers 400 naming `decision`.
- [integration] The decision POST for a request id present in `pendingApprovals` (fixture-written) on a thread whose job is no longer RUNNING answers 409 `threads.noSession` and creates no command.
- [integration] The decision POST by a member who is not the turn's requester answers 403.
- [integration] The text answer `POST .../answer` for a request id that is only in `pendingApprovals` still answers 409 `threads.noQuestion`.
- [integration] A successful decision POST records an audit entry under `thread.answer` whose summary names the decision.
- [integration] `POST /threads/:id/approvals/:requestId` on a WORKSPACE thread creates the `THREAD_ANSWER` decision command.
- [integration] The 409 `threads.noApproval` response message is the English text from the threads i18n file, and the Chinese file has the same key.

### US-009: Runner hands decisions to the session

- [unit] A `THREAD_ANSWER` with payload `{ requestId: 'r1', decision: 'allow' }` calls the session's `answer('r1', { decision: 'allow' })` and acks `ok` when it answers `accepted`.
- [unit] A `THREAD_ANSWER` with `{ requestId: 'r1', decision: 'deny' }` calls `answer('r1', { decision: 'deny' })`.
- [unit] A `THREAD_ANSWER` with `{ requestId: 'r1', decision: 'maybe' }` is rejected with detail `invalid payload` and `answer` is not called.
- [unit] A `THREAD_ANSWER` with `{ requestId: 'r1', text: 'yes' }` still calls `answer('r1', { text: 'yes' })`.
- [unit] A decision whose session answers a status other than `accepted` is rejected with that status as the detail.

### US-010: Publish commits code changes in ask and full modes

- [unit] `publishThreadDocs` with `mode: 'ask'` and a changed `src/math.ts` stages it, reports it in `paths` and commits with a message starting `feat(<feature>): changes from koda thread`.
- [unit] `publishThreadDocs` with `mode: 'full'` and a changed doc path plus `src/math.ts` stages both with the `feat(` message.
- [unit] `publishThreadDocs` with `mode: 'ask'` and only a changed doc path commits with the `docs(<feature>): spec from koda thread` message.
- [unit] `publishThreadDocs` with `mode: 'read'` and a changed `src/math.ts` reports it in `ignored` and does not stage it.
- [unit] `publishThreadDocs` with `mode: 'full'` and a changed symlink reports the symlink in `ignored`.
- [unit] A PUBLISH job whose assign has `mode: 'full'` calls the publisher with `mode: 'full'`.
- [unit] A PUBLISH job whose assign has no `mode` calls the publisher with `mode: 'read'`.
- [unit] A live publish during a SESSION job whose assign has `mode: 'ask'` calls the publisher with `mode: 'ask'`.

### US-011: Web new-thread forms choose agent and mode

- [unit] The ACP eligibility helper for runners whose `acpOffers` list `claude` launchable and logged in returns `claude` available with its models.
- [unit] The helper returns `codex` unavailable with reason `not logged in` when every eligible runner reports it launchable with `loggedIn: false`.
- [unit] The helper returns `cursor` unavailable with reason `not installed` when no eligible runner reports it launchable.
- [unit] The backend picker renders Native, Claude Code, Codex and Cursor, with an unavailable agent's option disabled and its reason shown.
- [unit] Choosing Claude Code in the picker emits `update:agent` with `claude` and lists Claude Code's models.
- [unit] On the project REPO form, the mode select lists Read and Ask, not Full, when the caller holds `thread.mode.ask` but not `thread.mode.full`.
- [unit] On the project REPO form, the mode select lists Read, Ask and Full when the caller holds both keys.
- [unit] The project PROJECT-kind form shows no mode select.
- [unit] Submitting the project REPO form with Codex, model `gpt-5-codex` and mode Ask posts `backend` `{ kind: 'acp', agent: 'codex', model: 'gpt-5-codex' }` and `mode: 'ask'`.
- [unit] Submitting the project REPO form with Native and an unchanged mode posts `backend.kind` `native` and `mode: 'read'`.
- [unit] Submitting the workspace form with Cursor posts an `acp` backend with agent `cursor` and no `mode`.
- [unit] The disabled-agent reason renders as the English text `Not logged in` with the English locale and as the Chinese text with the Chinese locale.

### US-012: Web thread page changes mode and decides approvals

- [unit] `ThreadModeControl` shows the thread's current mode as selected.
- [unit] Choosing Ask in `ThreadModeControl` calls the thread's mode endpoint with `{ mode: 'ask' }`.
- [unit] `ThreadModeControl` disables Full when the caller lacks `thread.mode.full`.
- [unit] `ThreadModeControl` renders the API error text when the mode endpoint answers 409.
- [unit] The project thread page renders `ThreadModeControl` for a REPO thread and not for a PROJECT thread.
- [unit] `ThreadApprovalCard` renders the request's tool, summary, command and reason.
- [unit] `ThreadApprovalCard` renders an `Unsandboxed` badge when the request has `unsandboxed: true`, and none otherwise.
- [unit] Clicking Approve posts `{ decision: 'allow' }` to the approval endpoint for its request id.
- [unit] Clicking Deny posts `{ decision: 'deny' }`.
- [unit] The project thread page renders one `ThreadApprovalCard` per `pendingApprovals` entry and none when the list is empty.
- [unit] The workspace thread page renders the same approval cards from its thread's `pendingApprovals`, posting to the workspace approval endpoint.
- [unit] The approval card's Approve label renders as English `Approve` with the English locale and as the Chinese text with the Chinese locale.
