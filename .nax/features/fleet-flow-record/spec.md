<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet flow record, entries and approval (fleet flow F1)

## Summary

Add the `FleetFlow` record: one flow holds an ordered list of features from one design (feature name, spec path,
dependencies), the branch and sha the spec set was settled at, the reviewer and supervisor role models, a cost cap,
and a state. A flow is created from two entries that share one service: a koda brainstorm thread (a human or agent
on the project route) and `POST /api/fleet/flows` (what nax's `nax-flow__send` will call with an agent key). Every
new flow is `PENDING` and raises one approval request under the new approvable key `fleet.flow.start`, which only a
human can decide; a thread's pre-approval tickbox (new key `fleet.thread.preapprove`, set by humans only) lets one
flow from that thread start `APPROVED` instead. A thread that re-publishes after its flow was created sends the flow
back to `PENDING` when the publish touches a spec path (or when the flow is still waiting for approval). Flows can be
listed, read and stopped. F1 dispatches no job and spends nothing: the `AGENT` job kind (F2), the steps (F3-F5) and
the web pages (F6) come later.

## Motivation

The fleet flow design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, merged #392) turns a settled spec
set into ready PRs with one approval. Every later piece (steps, verdicts, merge waits, the flow page, nax's
send-to-koda tool) needs the record, its states and its approval first. nax's G5 `nax-flow__send` is built against
this feature's create endpoint, so F1 ships the nax entry now instead of last.

## Design

### User rulings

- 2026-11-04 (design): koda owns the always-on flow; one approval after the spec set is settled, always asked at
  least once unless the thread's pre-approval tickbox is ticked; per-thread tickbox only, given in advance, with a
  required cost cap; project-wide auto-approve deferred; an agent can propose a flow and can tick nothing; a spec
  change after approval sends the flow back to `PENDING`, a change outside the spec paths does not; a stopped flow is
  never restarted in place.
- 2026-11-06: the design splits into six features in order: F1 this record (design parts (a) and (g)), F2 the
  `AGENT` job kind, F3 single-feature steps, stops and cap, F4 verdicts and batched questions, F5 multi-feature order
  and merge waits, F6 the web pages.
- 2026-11-06: the caller sends the features list (`feature`, `specPath`, `dependsOn`) on both entries; the F6 form
  prefills it from the thread's published docs.

### Calls made while drafting (not user rulings)

- **Human floor.** `fleet.flow.start` is classified `critical` in `classifyRisk`, so its approval floor and default
  are `human` and no policy can lower it: an agent can never approve a flow.
- **Programmatic ask for the start approval.** The approval gate executes a human caller's action at once, so a
  human-created flow could never be `PENDING` through `routeGate.run` alone. The create service writes the flow and
  opens the `fleet.flow.start` request through `ApprovalAskService.open` with a new component `flow`, on behalf of the
  creator, in the same transaction (the `openBudget` precedent). `open` returning `not-needed` cannot happen for a
  `critical` key; `create` treats it as an internal error. The creating human may decide its own request: an
  on-behalf human contributes `human`.
- **Every write route is gated.** The write keys are approvable, and the permission contract refuses an ungated
  write that requires one (`ungated-approvable-write`). Each write route runs through `routeGate.run` with a
  registered route command; for a human, or an agent with no policy asking, it executes at once; an agent whose
  policy asks gets 202 with the request, and approving it runs the command.
- **Humans only for the tick, in the route.** `fleet.thread.preapprove` keeps `principals: ['user', 'agent']`: a
  user-only catalog entry would make every role holding it (`developer`, and `project-admin` through `*`) unbindable
  to agents (`RoleAdminService.assertPrincipalType`). The pre-approval route commands refuse a non-USER actor with
  403 `fleet.flows.humanOnly` instead.
- **Request id on the flow.** The flow row stores `approvalRequestId`; no `FleetApprovalAsk` link row. Asks are
  closed with status `cancelled` and reason `superseded` or `flow_stopped`; `close` returns null when a decide holds
  the request, and the `approvalRequestId` guard then makes the late decision a no-op. `execute` reads `requestId`
  and `approverId` from the action context with a local helper (as `FleetBudgetOverrideCommand` does); `onReject`
  receives no request and reads only `currentContext().approval.requestId`.
- **Thread data through `ThreadsService`.** The flows module never reads the thread repository. `ThreadsService`
  gains `lockForFlow(projectId, threadId)`, which takes the thread row lock and applies the thread-entry guards in the
  Failure Handling order (it owns `threadsEnabled`), plus `setPreApproval`, `clearPreApproval` and
  `consumePreApproval`.
- **Thread entry trusts the thread's publish record.** Thread publish commits to a ref in the runner's local clone
  and never pushes, so koda cannot read thread-entry specs from the forge. The create command reads `branch =
  feat/<thread.feature>`, `specSha = thread.publishedSha` and `pinnedRunnerId = thread.runnerId` from the record
  `lockForFlow` returned inside its `run`, so a deferred agent request uses the thread as it is when it executes. It
  does not check that each `specPath` exists; a missing spec fails the flow's first step (F3).
- **Who consumes a tick.** A tick covers a flow whose creator is the tick's user or the thread's creator; a flow
  created by anyone else on that thread is `PENDING`. Covered means the tick's cap is at least the flow's cap, as
  decimals.
- **nax entry verifies on the forge, before the gate.** In the controller, before `routeGate.run`: resolve the repo,
  check reach and key, mint a read-only installation token, check `specSha` equals the branch head and every
  `specPath` exists at `specSha` (the `assertRepoInProject` precedent of checks before the gate). Inside `run`, under
  the `FleetRepo` row lock, the duplicate check and the create.
- **Live flow.** Every non-terminal state (not `COMPLETED`, not `STOPPED`) is live. One live flow per thread (thread
  row lock) and per `(repoId, branch, specSha)` on the nax entry (`FleetRepo` row lock).
- **Re-publish is event-driven.** After a thread ingest fold that applied a `published` line commits, the ingest
  emits `THREAD_SPEC_PUBLISHED` `{ threadId, sha, paths }` with `emitAsync`, logging a listener failure.
  `FleetFlowPublishListener` calls `FleetFlowsService.respec(event)` under the system writer `system.flow.respec`.
  `respec` finds the thread's live flow unlocked (for its `projectId`), then takes the thread and flow locks and
  re-reads both. Rules: an event whose `sha` is not the thread's current `publishedSha`, or equals the flow's
  `specSha`, is ignored; a `PENDING` flow always re-asks (old request closed `superseded`, new one with the new sha);
  an `APPROVED` flow whose publish touches a spec path returns to `PENDING` with a new request; an `APPROVED` flow
  whose publish touches none keeps its approval and takes the new sha; a flow in any later state is left to F3.
  Emission is best-effort, and a stale replayed `published` line can still move `publishedSha`, so F3 re-checks
  `thread.publishedSha == flow.specSha` before every dispatch.
- **Lock order.** Thread row (`ChatThread ... FOR UPDATE`) or `FleetRepo` row, then flow row (`FleetFlow ... FOR
  UPDATE`), then the request through `close`. Every flow transition reads the state under the flow row lock and checks
  `canTransitionFlow`.
- **The tick has no expiry and no spec binding.** It is the user's advance approval (design G4) for whatever the
  thread publishes next, up to its cap; it is consumed by the first flow it covers.
- **Bounds.** 1-20 features; feature names follow `FEATURE_RE` (`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) and are unique;
  `specPath` 1-300 characters, relative, ends `.md`, no `..` segment; `dependsOn` names only features listed earlier,
  no duplicates; role values 1-200 characters of `[A-Za-z0-9._:/\[\]=,-]`; `costCapUsd` greater than 0, at most 1000,
  at most 4 decimal places; `branch` matches `GIT_REF_RE`; `specSha` is 40 lowercase hex.
- **Remote URLs.** `remoteUrl` accepts what `parseGitHubUrl` accepts (`https://github.com/<owner>/<repo>[.git]`); its
  `skills.unsupportedHost` error is rethrown as a validation error naming `remoteUrl`.
- **Developer role.** `developer` gets `fleet.flow.create`, `fleet.flow.stop`, `fleet.flow.start` and
  `fleet.thread.preapprove` explicitly; it already holds `fleet.flow.read` through `*.read`.
- **Thread responses show the tick.** `ThreadDto` gains `preApproval { userId, at, costCapUsd } | null` so the F6
  control can render it; the tick is not secret.

### Flow states

`FleetFlowState`: `PENDING`, `APPROVED`, `RUNNING`, `WAITING_MERGE`, `WAITING_ANSWER`, `COMPLETED`, `STOPPED`.
Pure `canTransitionFlow(from, to)`:

| from | allowed to |
|:---|:---|
| PENDING | APPROVED, STOPPED, PENDING (re-ask) |
| APPROVED | RUNNING, PENDING, STOPPED |
| RUNNING | WAITING_MERGE, WAITING_ANSWER, COMPLETED, STOPPED, PENDING |
| WAITING_MERGE | RUNNING, STOPPED |
| WAITING_ANSWER | RUNNING, PENDING, STOPPED |
| COMPLETED | (none) |
| STOPPED | (none) |

`isLiveFlowState(state)` is true for every state except `COMPLETED` and `STOPPED`. F1 itself moves flows only along
PENDING -> APPROVED, PENDING -> PENDING (re-ask), PENDING -> STOPPED, APPROVED -> PENDING and APPROVED -> STOPPED. A
feature row's `state` is `PENDING` at creation; F3 owns its other values. Stop reasons written by F1:
`approval_rejected`, `human_stop`.

### Data model

```prisma
model FleetFlow {
  id                String    @id @default(cuid())
  projectId         String
  repoId            String
  threadId          String?
  entry             String    // THREAD | NAX
  createdByType     String    // USER | AGENT
  createdById       String
  branch            String
  specSha           String
  pinnedRunnerId    String?
  reviewerRole      String
  supervisorRole    String
  costCapUsd        Decimal   @db.Decimal(12, 4)
  spentUsd          Decimal   @default(0) @db.Decimal(12, 4)
  state             String    @default("PENDING")
  approvalMode      String?   // REQUEST | PRE_APPROVED
  approverId        String?
  approvedAt        DateTime?
  approvalRequestId String?
  stopReason        String?
  endedAt           DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  project           Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  repo              FleetRepo @relation(fields: [repoId], references: [id], onDelete: Cascade)
  features          FleetFlowFeature[]
  @@index([projectId, createdAt])
  @@index([threadId, state])
  @@index([repoId, branch, specSha])
  @@index([approvalRequestId])
}

model FleetFlowFeature {
  id           String    @id @default(cuid())
  flowId       String
  position     Int
  feature      String
  specPath     String
  dependsOn    String[]
  state        String    @default("PENDING")
  currentStep  String?
  prNumber     Int?
  flow         FleetFlow @relation(fields: [flowId], references: [id], onDelete: Cascade)
  @@unique([flowId, position])
  @@unique([flowId, feature])
}
```

`ChatThread` gains `preApproval Json?`, shape `{ userId: string, at: string (ISO), costCapUsd: string }`, surfaced on
`ChatThreadRecord` as `preApproval: ThreadPreApproval | null`.

### API

| route | key | result |
|:---|:---|:---|
| `POST /api/projects/:slug/threads/:id/flows` | `fleet.flow.create` | 201 flow, or 202 request |
| `PUT /api/projects/:slug/threads/:id/preapproval` | `fleet.thread.preapprove`, USER actor only | 200 pre-approval |
| `DELETE /api/projects/:slug/threads/:id/preapproval` | `fleet.thread.preapprove`, USER actor only | 200 |
| `POST /api/fleet/flows` | `fleet.flow.create`, enforced in the resolved repo's project | 201 flow, or 202 request |
| `GET /api/projects/:slug/flows` | `fleet.flow.read` | 200 page |
| `GET /api/projects/:slug/flows/:flowId` | `fleet.flow.read` | 200 flow |
| `GET /api/fleet/flows/:flowId` | `fleet.flow.read`, enforced in the flow's project | 200 flow |
| `POST /api/projects/:slug/flows/:flowId/stop` | `fleet.flow.stop` | 200 flow, or 202 request |

Thread-entry body: `{ features: [{ feature, specPath, dependsOn? }], roles: { reviewer, supervisor }, costCapUsd }`.
nax-entry body: the same plus `{ remoteUrl, branch, specSha }`. Pre-approval body: `{ costCapUsd }`.

`FleetFlowDto`: `id`, `projectId`, `repoId`, `threadId`, `entry`, `createdBy { type, id }`, `branch`, `specSha`,
`pinnedRunnerId`, `roles { reviewer, supervisor }`, `costCapUsd` (string), `spentUsd` (string), `state`,
`approval { mode, approverId, approvedAt, approvalRequestId } | null`, `stopReason`, `endedAt`, `createdAt`,
`features [{ feature, specPath, dependsOn, state, currentStep, prNumber }]` in position order, and `url` (the web
path `/<slug>/flows/<id>`, which F6 renders).

### Integration

Symbols this feature only reads (verified):

- `ApprovalAskService.open<TInput>(ask: OpenAsk, now)` and `OpenAsk { key, projectId, component, onBehalfOf, origin,
  input, deadline }` (`apps/api/src/approvals/approval-ask.service.ts:31-112`): inside the caller's transaction;
  returns `{ status: 'not-needed' }` or `{ status: 'pending', request }`.
- `ApprovalAskService.close(requestId, { status: 'cancelled' | 'expired', reason })` (same file, from line 113):
  inside a transaction; `FOR UPDATE SKIP LOCKED`; returns null when the request is gone, settled or held; reason 1-64
  characters.
- `ApprovalCommand<TInput, TResult, TDecision>` (`key`, `parse`, `execute`, `onReject?(input, decision)`, `details?`)
  and `ApprovalCommandRegistry.register` (`apps/api/src/approvals/approval-command.registry.ts:38-100`).
- System-raised ask precedent: `ApprovalCloser.openBudget` (`apps/api/src/fleet/approvals/approval-closer.ts:119-150`)
  and `FleetBudgetOverrideCommand` (`apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts`, with its
  file-local context helper), registered in `apps/api/src/fleet/approvals/approvals.module.ts` `onModuleInit`.
- Gated write route precedent: `ProjectProviderCredentialsController` (`apps/api/src/fleet/provider-credentials/project-provider-credentials.controller.ts:37-130`)
  with `provider-credential-route.commands.ts`, and `ThreadsController.stop` (`apps/api/src/fleet/threads/threads.controller.ts:176-184`,
  `@ApprovalGated()` plus `routeGate.run`).
- `POST /api/approvals/:id/decisions` (`apps/api/src/approvals/approval-requests.controller.ts:93`).
- `contributedMode` (`apps/api/src/approvals/approval-eligibility.ts`): an on-behalf `USER` decider contributes
  `human`; an agent contributes `self` or `agent`.
- `AuditRecorder.record({ key, resourceType, resourceId, projectId?, summary? })`
  (`apps/api/src/audit/audit-recorder.service.ts`): unknown catalog key throws; inside a transaction.
- `FleetActivityService.record(entry)` (`apps/api/src/fleet/activity/fleet-activity.service.ts:22`); every flow
  entry passes `projectId`; payload keys matching `/token|secret|key|password|credential/i` throw, so flow payloads
  use `flowId`, `state`, `entry`, `stopReason`, `featureCount`.
- `@SystemWriter(key)` (`apps/api/src/permissions/system-writer.decorator.ts:11`) and `runAsSystemWriter(writer, fn)`
  (`apps/api/src/action-context/action-context.ts:153`); precedent `VcsProjectDeletionListener`
  (`apps/api/src/vcs/vcs-project-deletion.listener.ts:28-50`).
- `EventEmitterModule.forRoot()` is global (`apps/api/src/app.module.ts:82`).
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)`, `getBranchHead(token, owner, name, branch)` (throws
  `RepoCheckException('repo_not_found')` on 404) and `getFile(token, owner, name, path, ref): Promise<ForgeFile | null>`
  (`apps/api/src/fleet/git-broker/github-app-client.ts:102, 312, 338`); `RepoCheckException.reason` values include
  `repo_not_found`, `provider_unreachable`, `provider_error`, `app_not_installed`, `app_permissions_insufficient`,
  `github_app_not_configured`, `github_app_key_unreadable` (`apps/api/src/fleet/git-broker/repo-check.exception.ts`).
- `parseGitHubUrl(url)` (`apps/api/src/skills/github-url.ts:12-34`), throwing `ValidationAppException({},
  'skills.unsupportedHost')`.
- `ProjectsService.findAllForPrincipal(principal)` (`apps/api/src/projects/projects.service.ts:88-96`).
- `RoleAdminService.assertPrincipalType` (`apps/api/src/permissions/role-admin.service.ts:409-418`): refuses binding a
  role holding a key whose `principals` excludes the principal type.
- `FEATURE_RE` and `GIT_REF_RE` (`apps/api/src/fleet/jobs/dispatch-input.ts:10, 12`).
- `ThreadsService.plan` guards (`apps/api/src/fleet/threads/threads.service.ts:145-160`): `threads.notFound`,
  `threads.notRepoThread` (from `repoThreadFields`), `threads.disabled`, `threads.archived`, `threads.notPublished`,
  `threads.runnerMissing`.

Symbols this feature changes. The baseline only locates the code; implement the target.

- `ASK_KEYS_BY_COMPONENT` (`apps/api/src/approvals/approval-ask.service.ts:49`).
  Baseline: `{ runner, budget }`. Target: adds `flow: 'fleet.flow.start'`.
- Permission catalog (`apps/api/src/permissions/catalog.ts`).
  Baseline: no `fleet.flow.*`, `fleet.thread.preapprove` or `system.flow.respec`; `classifyRisk` returns `critical`
  only for role-grant, `role.` and `approval.policy.` keys; `PENDING_SURFACE_KEYS` holds `member.remove`,
  `fleet.job.shell.escalate`, `fleet.budget.override`.
  Target: `NEW_KEY_SCOPES` adds `fleet.flow.read`, `fleet.flow.create`, `fleet.flow.start`, `fleet.flow.stop`,
  `fleet.thread.preapprove` (all `'project'`) and `system.flow.respec` (`'any'`); `classifyRisk` returns `critical`
  for `fleet.flow.start`; `PENDING_SURFACE_KEYS` adds all six, and each later story removes the key it declares
  (`fleet.flow.start` stays: no route declares it, as with `fleet.budget.override`).
- `FLEET_ENTITY_TYPES` (`apps/api/src/fleet/activity/domain/fleet-activity.domain.ts:8-22`).
  Baseline: ends at `provider_credential`. Target: ends `provider_credential, flow`.
- `ChatThreadRecord` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts:72-99`), `mapThread` in
  `prisma-chat-thread.repository.ts`, and `ThreadDto` (`apps/api/src/fleet/threads/dto/thread.dto.ts:36`).
  Baseline: no pre-approval. Target: `preApproval: ThreadPreApproval | null` on the record and the DTO.
- `ThreadsService` (`apps/api/src/fleet/threads/threads.service.ts`). Target adds `lockForFlow(projectId, threadId):
  Promise<ChatThreadRecord>` (inside the caller's transaction: thread row lock, then the guards, throwing their
  errors), `setPreApproval(projectId, threadId, userId, costCapUsd)`, `clearPreApproval(projectId, threadId):
  Promise<boolean>` and `consumePreApproval(threadId)`.
- `IFleetRepoRepository` (`apps/api/src/fleet/repos/domain/fleet-repo.domain.ts:39-66`). Target adds
  `findByIdentity(provider, owner, name): Promise<FleetRepoRecord | null>` (case-insensitive on owner and name) and
  `lockById(id)`, exposed through `FleetReposService`.
- `PrismaThreadIngestRepository.fold` (`apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts:79-84`).
  Baseline: applies `published` lines inside `txManager.run(() => bookkeeping('thread.transcript', ...))` and emits
  nothing. Target: takes an `EventEmitter2`, collects the batch's `published` lines and, after that `txManager.run`
  resolves, awaits `emitAsync(THREAD_SPEC_PUBLISHED, { threadId, sha, paths })` once per line, logging (not
  rethrowing) a listener failure.

### Approach

```ts
// apps/api/src/fleet/flows/fleet-flow-start.command.ts (worked skeleton)
@Injectable()
export class FleetFlowStartCommand implements ApprovalCommand<FlowStartInput, FlowStartResult> {
  readonly key = 'fleet.flow.start';
  parse(input: unknown): FlowStartInput { /* { flowId: string, specSha: 40 lowercase hex } or throw */ }
  async execute(input: FlowStartInput): Promise<FlowStartResult> {
    const { requestId, approverId } = approvalFromContext();          // file-local, as the budget command's helper
    const flow = await this.flows.lockById(input.flowId);           // FleetFlow ... FOR UPDATE
    if (!flow || flow.state !== 'PENDING' || flow.approvalRequestId !== requestId || flow.specSha !== input.specSha) {
      return { applied: false };
    }
    await this.flows.approve(flow.id, { mode: 'REQUEST', approverId, approvedAt: new Date(), approvalRequestId: requestId });
    await this.audit.record({ key: 'fleet.flow.start', resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId, summary: 'flow approved' });
    await this.activity.record({ action: 'flow.approved', entityType: 'flow', entityId: flow.id, projectId: flow.projectId, /* actor */ payload: { flowId: flow.id, state: 'APPROVED' } });
    return { applied: true };
  }
  async onReject(input: FlowStartInput): Promise<void> {
    const requestId = currentContext()?.approval.requestId;           // no approverId on reject
    /* same guard; PENDING -> STOPPED approval_rejected; audit; activity */
  }
}
```

`FleetFlowsService.create(input, creator, context)` runs in one transaction: take the thread lock (`lockForFlow`) or
the `FleetRepo` lock; refuse a live flow on the thread, or a live duplicate on the nax entry; insert the flow and
features; consume a covering tick (`APPROVED`, `PRE_APPROVED`) or open the `fleet.flow.start` ask and store its id;
audit `fleet.flow.create`; record `flow.created`. Each create route's `routeCommand.run` calls it.

### Failure Handling

| case | response |
|:---|:---|
| body fails a bound (features, roles, cap, branch, sha, remoteUrl) | 400 `ValidationAppException` naming the property |
| agent caller whose approval policy asks for the write key | 202 with the approval request |
| thread not found or in another project | 404 `threads.notFound` |
| thread is not a REPO thread | 409 `threads.notRepoThread` |
| threads disabled | 409 `threads.disabled` |
| thread archived | 409 `threads.archived` |
| thread spec not published | 409 `threads.notPublished` |
| thread has no runner | 409 `threads.runnerMissing` |
| thread already has a live flow | 409 `fleet.flows.threadBusy` |
| nax entry: no FleetRepo for `remoteUrl`, or one in a project the caller cannot reach | 404 `fleet.flows.repoNotFound` |
| nax entry: caller lacks `fleet.flow.create` in the repo's project | 403 |
| nax entry: repo has no GitHub installation id, or the mint fails `app_not_installed` / `app_permissions_insufficient` | 409 `fleet.flows.repoNotConnected` |
| nax entry: mint fails `github_app_not_configured` / `github_app_key_unreadable`, or the forge fails `provider_unreachable` / `provider_error` | 503 `fleet.flows.forgeUnavailable`; no flow written |
| nax entry: branch missing (`repo_not_found` from `getBranchHead`) | 409 `fleet.flows.branchNotFound` |
| nax entry: `specSha` is not the branch head | 409 `fleet.flows.specShaNotHead` |
| nax entry: a `specPath` missing at `specSha` | 422 `fleet.flows.specMissing`, naming the path |
| nax entry: a live flow exists for the same repo, branch and sha | 409 `fleet.flows.duplicate`, with the existing flow id |
| pre-approval set or cleared by a non-USER actor | 403 `fleet.flows.humanOnly` |
| stop on a flow already `STOPPED` or `COMPLETED` | 409 `fleet.flows.notStoppable` |
| flow not found or not in the route's project | 404 `fleet.flows.notFound` |
| approval decided after the flow left `PENDING`, or for a superseded request | no-op, `{ applied: false }` |
| re-publish event that is stale, already applied, or for a thread with no live flow | no-op |

## Out of Scope

- Dispatching any job (spec review, PLAN, PRD review, RUN, REVIEW, FIX, finish); F1 creates, approves and stops records only.
- The `AGENT` job kind and `nax agents run` on the runner (fleet flow F2).
- Single-feature steps, the cost cap check between jobs, `spentUsd` accumulation and job-failure stops (fleet flow F3).
- Change detection before each dispatch: F3 re-checks `thread.publishedSha` (thread entry) and the branch head (nax entry) against `flow.specSha`, which also covers a lost `THREAD_SPEC_PUBLISHED` event and a stale replayed `published` line.
- Review verdicts, spec-fix jobs, batched questions and the flow's ticket (fleet flow F4).
- Feature order, merge waits and independent features starting from main (fleet flow F5).
- Every web page: the Start flow form, the tickbox control, the flow page and the approval card's flow view (fleet flow F6).
- Cloning a stopped flow into a new pending flow (deferred to F6).
- A project-wide auto-approve setting (deferred by the user 2026-11-04).
- Pre-approval expiry or binding the tick to a published sha: by design the tick approves in advance whatever the thread publishes, up to its cap, and is consumed by one flow.
- GitLab repos and SSH remote URLs on the nax entry.
- Verifying thread-entry spec paths exist: thread publish never pushes, so the first step (F3) is where a missing spec fails.
- Approval request expiry: flow requests open with `deadline: null`.
- Closing a flow's pending request when its repo or project is deleted: the cascade removes the flow, and a later decision on the orphaned request is a no-op.
- A default approval policy for `fleet.flow.create` or `fleet.flow.stop`: both execute at once unless a project adds a policy.
- Regenerating the CLI client (`bun run generate:cli`) and CLI commands for flows: no CLI story in F1; `openapi.json` is regenerated.
- Notifications for a pending flow beyond what the approval engine already sends for a new request.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Flow permission keys, catalog risk, activity entity

Workdir: `apps/api`. No dependencies. Adds the five project keys and the system writer `system.flow.respec` to
`NEW_KEY_SCOPES`, puts all six in `PENDING_SURFACE_KEYS`, classifies `fleet.flow.start` `critical`, adds the four
write keys to the `developer` role, adds `flow` to `FLEET_ENTITY_TYPES` and `flow: 'fleet.flow.start'` to
`ASK_KEYS_BY_COMPONENT`, and regenerates the role-matrix snapshot.

### US-002: FleetFlow schema, migration and state rules

Workdir: `apps/api`. No dependencies. Prisma models `FleetFlow` and `FleetFlowFeature`, `ChatThread.preApproval`,
migration `20261125090000_fleet_flows`, the domain types and `FLEET_FLOW_REPOSITORY` token, and the pure
`canTransitionFlow` and `isLiveFlowState`.

### US-003: FleetFlow repository

Workdir: `apps/api`. Depends on US-002. `PrismaFleetFlowRepository` extending `AbstractPrismaRepository`: create with
features, `findById`, `lockById`, `findPage({ projectId })`, `findLiveForThread`, `findLiveForSpec(repoId, branch,
specSha)`, and transitions `approve`, `reask`, `updateSha`, `stop`, each locking the row and checking
`canTransitionFlow`.

### US-004: Thread pre-approval data and the guarded thread lock

Workdir: `apps/api`. Depends on US-002. `ChatThreadRecord.preApproval`, its mapping and `ThreadDto.preApproval`, and
the `ThreadsService` methods `lockForFlow`, `setPreApproval`, `clearPreApproval`, `consumePreApproval` with their
repository methods. `setPreApproval` and `clearPreApproval` lock the thread row and audit under
`fleet.thread.preapprove`; `consumePreApproval` writes no audit (the flow create audits).

### US-005: The fleet.flow.start approval command

Workdir: `apps/api`. Depends on US-001, US-003. `FleetFlowStartCommand` (`parse`, `execute`, `onReject`, `details`)
in the new `FlowsModule`, registered at module init and imported by `FleetModule`; approve flips PENDING to APPROVED
with the approval record, reject stops with `approval_rejected`, and a stale or superseded decision is a no-op.

### US-006: Flow input validation

Workdir: `apps/api`. No dependencies. Pure `parseFlowInput(body, entry)` in `flow-input.ts` enforcing every bound in
Calls made while drafting and throwing `ValidationAppException` naming the failing property.

### US-007: The flow create service

Workdir: `apps/api`. Depends on US-004, US-005, US-006. `FleetFlowsService.create(input, creator, context)`: one
transaction taking the thread lock (thread entry) or the `FleetRepo` lock (nax entry), refusing a live flow on the
thread or a live duplicate, inserting the flow and features, opening the `fleet.flow.start` ask on behalf of the
creator or consuming a covering tick, auditing `fleet.flow.create` and recording `flow.created`.

### US-008: Thread pre-approval routes

Workdir: `apps/api`. Depends on US-001, US-004, US-005. `ThreadPreApprovalController`: `PUT` and `DELETE
/api/projects/:slug/threads/:id/preapproval`, each `@ApprovalGated()` through `routeGate.run` with route commands in
the new `flow-route.commands.ts`, refusing a non-USER actor. Removes `fleet.thread.preapprove` from
`PENDING_SURFACE_KEYS`.

### US-009: Thread entry route

Workdir: `apps/api`. Depends on US-007, US-008. `ThreadFlowsController`: `POST /api/projects/:slug/threads/:id/flows`,
gated under `fleet.flow.create`; the route command's `run` calls `FleetFlowsService.create` for the thread entry,
which reads branch, sha and runner from the record `lockForFlow` returns. Removes `fleet.flow.create` from
`PENDING_SURFACE_KEYS`.

### US-010: nax entry route

Workdir: `apps/api`. Depends on US-007, US-009. `FleetFlowsController`: `POST /api/fleet/flows`: before the gate,
`remoteUrl` to `FleetRepo` through `findByIdentity`, reach (404) and key (403) checks in the repo's project, and the
forge checks; then `routeGate.run` under `fleet.flow.create` with that `projectId`, whose `run` calls
`FleetFlowsService.create` with entry `NAX`.

### US-011: Flow read and stop routes

Workdir: `apps/api`. Depends on US-010. `ProjectFlowsController`: `GET /api/projects/:slug/flows`, `GET
/api/projects/:slug/flows/:flowId` and gated `POST /api/projects/:slug/flows/:flowId/stop`; `GET
/api/fleet/flows/:flowId` on `FleetFlowsController` with the read enforced in the flow's project. Removes
`fleet.flow.read` and `fleet.flow.stop` from `PENDING_SURFACE_KEYS`.

### US-012: Re-publish sends a thread flow back to PENDING

Workdir: `apps/api`. Depends on US-007. The ingest emits `THREAD_SPEC_PUBLISHED`; `FleetFlowPublishListener`
(`@SystemWriter('system.flow.respec')`) calls `FleetFlowsService.respec(event)` under `runAsSystemWriter`, applying the
re-publish rules from Calls made while drafting. Removes `system.flow.respec` from `PENDING_SURFACE_KEYS`.

Twelve stories: one capability (the flow record's lifecycle up to approval), confirmed against the split ruling of
2026-11-06; every story is in `apps/api`.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `PENDING_SURFACE_KEYS`, `classifyRisk`, `buildEntry`
- `apps/api/src/permissions/system-roles.ts` — the `developer` role key list
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — `unused-key`, `pending-key-declared`, `ungated-approvable-write`
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — `FLEET_ENTITY_TYPES`

**US-002**
- `apps/api/prisma/schema.prisma` — `ChatThread`, `FleetRepo`, `ProviderCredential` models
- `apps/api/prisma/migrations/20261105000000_provider_credentials/migration.sql` — migration style

**US-003**
- `apps/api/src/fleet/provider-credentials/prisma-provider-credential.repository.ts` — `AbstractPrismaRepository` precedent
- `apps/api/src/fleet/provider-credentials/provider-credentials.module.ts` — token wiring precedent
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts` — created by US-002, implemented here
- `apps/api/src/fleet/flows/flow-states.ts` — created by US-002, used here

**US-004**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `changeMode` row lock and audit, `mapThread`
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRecord`, `ChatThreadRepository`, `repoThreadFields`
- `apps/api/src/fleet/threads/threads.service.ts` — `plan` guard order and `this.config.threadsEnabled`

**US-005**
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` — command and context-helper precedent
- `apps/api/src/fleet/approvals/approvals.module.ts` — `onModuleInit` registration
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand` interface
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts` — created by US-003, used here

**US-006**
- `apps/api/src/fleet/jobs/dispatch-input.ts` — `FEATURE_RE`, `GIT_REF_RE`

**US-007**
- `apps/api/src/fleet/approvals/approval-closer.ts` — `openBudget` ask precedent
- `apps/api/src/approvals/approval-ask.service.ts` — `open`, `close`
- `apps/api/src/fleet/flows/flows.module.ts` — created by US-005, extended here: provide `FleetFlowsService`, import `ThreadsModule`, `FleetReposModule`, `ApprovalEngineModule`
- `apps/api/src/fleet/flows/flow-input.ts` — created by US-006, used here
- `apps/api/src/fleet/activity/fleet-activity.service.ts` — `record`

**US-008**
- `apps/api/src/fleet/provider-credentials/project-provider-credentials.controller.ts` — gated project route precedent
- `apps/api/src/fleet/provider-credentials/provider-credential-route.commands.ts` — route command registration
- `apps/api/src/fleet/flows/flows.module.ts` — created by US-005, extended here: register `ThreadPreApprovalController` and the route commands provider

**US-009**
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — created by US-007, called here
- `apps/api/src/fleet/flows/flow-route.commands.ts` — created by US-008, extended here: the thread-entry create command
- `apps/api/src/fleet/flows/flows.module.ts` — created by US-005, extended here: register `ThreadFlowsController`

**US-010**
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintReadOnlyToken`, `getBranchHead`, `getFile`
- `apps/api/src/skills/github-url.ts` — `parseGitHubUrl`
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`
- `apps/api/src/fleet/flows/flow-route.commands.ts` — created by US-008, extended here: the nax-entry create command
- `apps/api/src/fleet/flows/flows.module.ts` — created by US-005, extended here: register `FleetFlowsController`, import `GitBrokerModule` and `ProjectsModule`

**US-011**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — created by US-010, extended here: the agent-reachable read route
- `apps/api/src/fleet/flows/flow-route.commands.ts` — created by US-008, extended here: the stop command
- `apps/api/src/fleet/flows/flows.module.ts` — created by US-005, extended here: register `ProjectFlowsController`

**US-012**
- `apps/api/src/vcs/vcs-project-deletion.listener.ts` — `@SystemWriter` plus `@OnEvent` listener precedent
- `apps/api/src/fleet/threads/ingest/thread-write-fold.ts` — the `published` line's `sha` and `paths`
- `apps/api/src/fleet/flows/fleet-flows.service.ts` — created by US-007, extended here: `respec(event)`
- `apps/api/src/fleet/flows/flows.module.ts` — created by US-005, extended here: provide `FleetFlowPublishListener`

### Creates

**US-002**
- `apps/api/prisma/migrations/20261125090000_fleet_flows/migration.sql`
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`
- `apps/api/src/fleet/flows/flow-states.ts`

**US-003**
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts`

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-start.command.ts`
- `apps/api/src/fleet/flows/flows.module.ts`

**US-006**
- `apps/api/src/fleet/flows/flow-input.ts`

**US-007**
- `apps/api/src/fleet/flows/fleet-flows.service.ts`
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.ts`

**US-008**
- `apps/api/src/fleet/flows/thread-preapproval.controller.ts`
- `apps/api/src/fleet/flows/flow-route.commands.ts`

**US-009**
- `apps/api/src/fleet/flows/thread-flows.controller.ts`

**US-010**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts`

**US-011**
- `apps/api/src/fleet/flows/project-flows.controller.ts`

**US-012**
- `apps/api/src/fleet/flows/fleet-flow-publish.listener.ts`
- `apps/api/src/fleet/threads/ingest/thread-spec-published.event.ts`

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.ts` — add the five project keys and `system.flow.respec` (scope `'any'`) to `NEW_KEY_SCOPES`, add all six to `PENDING_SURFACE_KEYS`, and return `critical` for `fleet.flow.start` in `classifyRisk`.
- `apps/api/src/permissions/catalog.spec.ts` — this spec keeps its own copies of `NEW_KEY_SCOPES` (its `NEW_KEY_LIST`), the expected risk table (lines ~184-192) and the `derive` helper (lines ~410-429); add the six keys and `critical` for `fleet.flow.start` so the full-key-list and length assertions (lines ~393-396, 446) hold.
- `apps/api/src/permissions/system-roles.ts` — add `fleet.flow.create`, `fleet.flow.stop`, `fleet.flow.start` and `fleet.thread.preapprove` to the `developer` role.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated: `fleet.flow.read` is granted in project scope to every role holding `*.read` and to `project-admin`; the other four project keys to `owner`, `admin`, `project-admin` and `developer` only.
- `apps/api/src/approvals/approval-ask.service.ts` — add `flow: 'fleet.flow.start'` to `ASK_KEYS_BY_COMPONENT`.
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — append `flow` to `FLEET_ENTITY_TYPES`.
- `apps/api/src/fleet/activity/fleet-activity.entity-types.spec.ts` — its closed-world assertion (line 17) becomes `[...PRE_EXISTING, 'provider_credential', 'flow']`.

**US-002**
- `apps/api/prisma/schema.prisma` — add `FleetFlow`, `FleetFlowFeature`, `ChatThread.preApproval Json?`, and the back-relations on `Project` and `FleetRepo`.

**US-004**
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — add `ThreadPreApproval`, `ChatThreadRecord.preApproval`, and the pre-approval and lock methods on `ChatThreadRepository`.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — map `preApproval` in `mapThread` and implement the new methods with the thread row lock.
- `apps/api/src/fleet/threads/threads.service.ts` — add `lockForFlow`, `setPreApproval`, `clearPreApproval`, `consumePreApproval`.
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — add `preApproval` (`@ApiProperty`, nullable `{ userId, at, costCapUsd }`) to `ThreadDto`.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new `ThreadDto` field.

**US-005**
- `apps/api/src/fleet/fleet.module.ts` — import `FlowsModule` in the `imports` list.

**US-007**
- `apps/api/src/fleet/repos/domain/fleet-repo.domain.ts` — add `findByIdentity(provider, owner, name)` and `lockById(id)` to `IFleetRepoRepository`.
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — implement `findByIdentity` (case-insensitive on owner and name) and `lockById` (`FleetRepo ... FOR UPDATE`).
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — expose `findByIdentity` and `lockById` to other modules.
- `apps/api/src/i18n/en/fleet.json` — add the `fleet.flows.*` messages from the Failure Handling table.
- `apps/api/src/i18n/zh/fleet.json` — add the same `fleet.flows.*` keys in Chinese.

**US-008**
- `apps/api/src/permissions/catalog.ts` — remove `fleet.thread.preapprove` from `PENDING_SURFACE_KEYS` now that its routes declare it.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add the two pre-approval operations to `gatedOperations` and raise the expected length by 2.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the pre-approval routes: happy path and one error each, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new routes.

**US-009**
- `apps/api/src/permissions/catalog.ts` — remove `fleet.flow.create` from `PENDING_SURFACE_KEYS` now that a route declares it.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add the thread-entry operation to `gatedOperations` and raise the expected length by 1.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the thread entry route: happy path and one error, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new route.

**US-010**
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add the nax-entry operation to `gatedOperations` and raise the expected length by 1.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the nax entry route: happy path and one error, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new route.

**US-011**
- `apps/api/src/permissions/catalog.ts` — remove `fleet.flow.read` and `fleet.flow.stop` from `PENDING_SURFACE_KEYS` now that routes declare them.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add the stop operation to `gatedOperations` and raise the expected length by 1.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the read and stop routes: happy path and one error each, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new routes.

**US-012**
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — inject `EventEmitter2`, collect the batch's `published` lines, and emit `THREAD_SPEC_PUBLISHED` once per line after `fold`'s transaction resolves.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.spec.ts` — its positional constructions (around line 108) pass the new `EventEmitter2` argument.
- `apps/api/src/fleet/threads/ingest/prisma-thread-cost-review.spec.ts` — its positional construction (around line 24) passes the new `EventEmitter2` argument.
- `apps/api/src/permissions/catalog.ts` — remove `system.flow.respec` from `PENDING_SURFACE_KEYS` now that the listener declares it.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — its writer table (around line 58) gains `[FleetFlowPublishListener, 'system.flow.respec']`.

### Seams

- US-005 -> US-007: `FleetFlowsService.create` opens the ask with key `fleet.flow.start`, which only resolves because US-005 registered `FleetFlowStartCommand`.
- US-004 -> US-007: `create` calls `ThreadsService.lockForFlow` and `consumePreApproval`.
- US-006 -> US-009, US-010: both create routes parse the body with `parseFlowInput`.
- US-007 -> US-009, US-010: both route commands call `FleetFlowsService.create`; their tests stub it and assert the arguments.
- US-012: `THREAD_SPEC_PUBLISHED` is emitted by the ingest's `fold` and consumed by `FleetFlowPublishListener`, which calls `FleetFlowsService.respec`.

## Acceptance Criteria

### US-001: Flow permission keys, catalog risk, activity entity

- [unit] `findCatalogEntry('fleet.flow.start')` returns scope `project`, `approval.approvable === true` and risk `critical`.
- [unit] `findCatalogEntry('fleet.flow.start').approval` has floor `human` and default `human`.
- [unit] For each key in the table `fleet.flow.read`, `fleet.flow.create`, `fleet.flow.stop`, `fleet.thread.preapprove`, `findCatalogEntry` returns scope `project` and `principals` `['user', 'agent']`.
- [unit] `findCatalogEntry('system.flow.respec')` returns an entry whose access is `system`.
- [unit] `ApprovalPolicyResolver.resolve` for key `fleet.flow.start` with a project policy of mode `agent` resolves mode `human`.
- [unit] The `developer` system role's project-scope grants include each of `fleet.flow.create`, `fleet.flow.start`, `fleet.flow.stop`, `fleet.thread.preapprove`.
- [unit] The `viewer` system role's project-scope grants include `fleet.flow.read`.
- [unit] The `viewer` system role's project-scope grants include none of `fleet.flow.create`, `fleet.flow.start`, `fleet.flow.stop`, `fleet.thread.preapprove`.
- [unit] `RoleAdminService` binds the `developer` role to an AGENT principal without throwing `permissions.principalType`.
- [unit] `PENDING_SURFACE_KEYS` contains `fleet.flow.start`.
- [unit] `ASK_KEYS_BY_COMPONENT.flow` equals `fleet.flow.start`.
- [unit] `FLEET_ENTITY_TYPES` ends with `provider_credential`, `flow`.

### US-002: FleetFlow schema, migration and state rules

- [unit] For each pair in the Flow states table, `canTransitionFlow(from, to)` returns true.
- [unit] `canTransitionFlow('PENDING', 'RUNNING')` returns false.
- [unit] `canTransitionFlow('COMPLETED', 'PENDING')` returns false.
- [unit] `canTransitionFlow('STOPPED', 'APPROVED')` returns false.
- [unit] `isLiveFlowState` returns true for `PENDING`, `APPROVED`, `RUNNING`, `WAITING_MERGE` and `WAITING_ANSWER`.
- [unit] `isLiveFlowState` returns false for `COMPLETED` and `STOPPED`.
- [integration] After migrating, inserting a `FleetFlow` row with only the required columns stores `state` `PENDING` and `spentUsd` `0`.
- [integration] Inserting two `FleetFlowFeature` rows with the same `flowId` and `feature` fails with Prisma error code `P2002`.
- [integration] Inserting a `ChatThread` row without `preApproval` stores it as null.

### US-003: FleetFlow repository

- [integration] `PrismaFleetFlowRepository.create` with three features persists them with positions 0, 1, 2 and feature `state` `PENDING`.
- [integration] `findById` returns the features in position order with their `dependsOn` arrays.
- [integration] `create` with two features of the same name throws and leaves no flow row.
- [integration] `findLiveForThread(threadId)` returns the thread's flow in `APPROVED`.
- [integration] `findLiveForThread(threadId)` returns null when the thread's only flow is `STOPPED`.
- [integration] `findLiveForSpec(repoId, branch, specSha)` returns a `PENDING` flow with those three values.
- [integration] `approve(flowId, { mode: 'REQUEST', approverId, approvedAt, approvalRequestId })` sets `state` `APPROVED` and the four approval columns.
- [integration] `reask(flowId, { specSha, approvalRequestId })` on an APPROVED flow sets `state` `PENDING`, stores the new sha and request id, and clears `approvalMode`, `approverId` and `approvedAt`.
- [integration] `updateSha(flowId, specSha)` on an APPROVED flow changes only `specSha`.
- [integration] `stop(flowId, 'human_stop', now)` sets `state` `STOPPED`, `stopReason` `human_stop` and `endedAt` `now`.
- [integration] `stop` on a STOPPED flow throws `FlowTransitionError` and leaves the row unchanged.
- [integration] `findPage({ projectId })` returns that project's flows newest first and none of another project's flows.
- [integration] Deleting the flow's `FleetRepo` deletes the flow and its features.

### US-004: Thread pre-approval data and the guarded thread lock

- [integration] `ThreadsService.setPreApproval(projectId, threadId, userId, '30')` stores `preApproval` `{ userId, at, costCapUsd: '30' }`, and the next thread read returns it.
- [integration] `setPreApproval` writes an `AuditEntry` with key `fleet.thread.preapprove`, resourceType `thread` and resourceId the thread id.
- [integration] `setPreApproval` on an ARCHIVED thread throws `ConflictAppException` with `threads.archived`.
- [integration] `clearPreApproval` on a ticked thread returns true, sets `preApproval` null and writes an `AuditEntry` with key `fleet.thread.preapprove`.
- [integration] `clearPreApproval` on an unticked thread returns false and writes no `AuditEntry`.
- [integration] `consumePreApproval(threadId)` sets `preApproval` null and writes no `AuditEntry`.
- [integration] `lockForFlow(projectId, threadId)` on a published REPO thread with a runner returns its record, including `preApproval`.
- [integration] `lockForFlow` throws `NotFoundAppException` with `threads.notFound` for a thread of another project.
- [integration] `lockForFlow` throws `ConflictAppException` with `threads.notRepoThread` for a PROJECT thread.
- [integration] `lockForFlow` throws `ConflictAppException` with `threads.notPublished` for a thread whose `specPublished` is false.
- [integration] `lockForFlow` throws `ConflictAppException` with `threads.runnerMissing` for a thread with no `runnerId`.
- [integration] While one transaction holds `lockForFlow` on a thread, a concurrent `setPreApproval` on it completes only after that transaction ends.
- [integration] `GET /api/projects/:slug/threads/:id` returns `preApproval` with `costCapUsd` `'30'` for a ticked thread and null otherwise.

### US-005: The fleet.flow.start approval command

- [unit] `FleetFlowStartCommand.parse({ flowId: 'f1', specSha: <40 lowercase hex> })` returns the same object.
- [unit] `FleetFlowStartCommand.parse` throws for a 39-character or an uppercase `specSha`.
- [integration] `POST /api/approvals/:id/decisions` with `approve` by a USER holding `fleet.flow.start` and `approval.decide`, for the request of a PENDING flow, sets the flow `APPROVED` with `approvalMode` `REQUEST`, `approverId` that user and `approvalRequestId` the request id.
- [integration] That approval writes an `AuditEntry` with key `fleet.flow.start`, resourceType `flow`, `approverType` `USER` and `approvalRequestId` the request id.
- [integration] That approval records a `FleetActivity` row with action `flow.approved`, entityType `flow`, entityId the flow id and `projectId` the flow's project.
- [integration] The USER on whose behalf the request was opened may approve it, and the flow becomes `APPROVED`.
- [integration] `POST /api/approvals/:id/decisions` with `reject` sets the flow `STOPPED` with `stopReason` `approval_rejected` and `endedAt` set.
- [integration] Approving a request whose flow is already `STOPPED` leaves it `STOPPED`, and the command result is `{ applied: false }`.
- [integration] Approving a request whose id is not the flow's current `approvalRequestId` leaves the flow `PENDING` with `{ applied: false }`.
- [integration] Approving a request whose stored `specSha` differs from the flow's `specSha` leaves the flow `PENDING` with `{ applied: false }`.
- [integration] `POST /api/approvals/:id/decisions` with `approve` by an AGENT holding `fleet.flow.start` and `approval.decide` is refused, and the flow stays `PENDING`.
- [unit] After `FlowsModule.onModuleInit`, `ApprovalCommandRegistry.get('fleet.flow.start')` returns a `FleetFlowStartCommand`.
- [unit] `FleetFlowStartCommand.details(request)` returns `{ kind: 'flow', flowId, state, branch, specSha, costCapUsd, features }` for the request's flow, and null when the flow is gone.

### US-006: Flow input validation

- [unit] `parseFlowInput` accepts one feature `{ feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md' }` with roles `{ reviewer: 'acp:claude', supervisor: 'native:fast' }` and `costCapUsd: 25`, returning `dependsOn: []`.
- [unit] `parseFlowInput` with zero features throws `ValidationAppException` naming `features`.
- [unit] `parseFlowInput` with 21 features throws `ValidationAppException` naming `features`.
- [unit] `parseFlowInput` with a first feature named `-flow` throws `ValidationAppException` naming `features.0.feature`.
- [unit] `parseFlowInput` with two features named `flow-a` throws `ValidationAppException` naming `features.1.feature`.
- [unit] For each `specPath` in the table `../x.md`, `/abs/spec.md`, `spec.txt`, `parseFlowInput` throws `ValidationAppException` naming `features.0.specPath`.
- [unit] `parseFlowInput` where the second feature's `dependsOn` names the third feature throws `ValidationAppException` naming `features.1.dependsOn`.
- [unit] `parseFlowInput` where the second feature depends on itself throws `ValidationAppException` naming `features.1.dependsOn`.
- [unit] `parseFlowInput` with no `roles.reviewer` throws `ValidationAppException` naming `roles.reviewer`.
- [unit] `parseFlowInput` with a `roles.supervisor` containing a space throws `ValidationAppException` naming `roles.supervisor`.
- [unit] For each `costCapUsd` in the table `0`, `-1`, `1000.01`, `1.00001`, `parseFlowInput` throws `ValidationAppException` naming `costCapUsd`.
- [unit] `parseFlowInput` accepts `costCapUsd` `1000` and `0.0001`.
- [unit] `parseFlowInput` for the nax entry with a 39-character `specSha` throws `ValidationAppException` naming `specSha`.
- [unit] `parseFlowInput` for the nax entry with `branch` `feat/..x` throws `ValidationAppException` naming `branch`.
- [unit] `parseFlowInput` for the nax entry with `remoteUrl` `git@github.com:org/repo.git` throws `ValidationAppException` naming `remoteUrl`.

### US-007: The flow create service

- [integration] `FleetFlowsService.create` for a USER creator with no tick writes a `PENDING` flow and opens an `ApprovalRequest` with permissionKey `fleet.flow.start`, `onBehalfOf` the creator, required mode `human` and input `{ flowId, specSha }`.
- [integration] The request id `create` opened is stored as the flow's `approvalRequestId`.
- [integration] `create` for an AGENT creator opens the request with `onBehalfOf` `{ type: 'AGENT', id }`.
- [integration] `create` for a thread entry stores `branch` `feat/<thread.feature>`, `specSha` the thread's `publishedSha` and `pinnedRunnerId` the thread's `runnerId` from the record `lockForFlow` returned.
- [integration] `create` by the tick's user on a thread ticked with cap `'40'`, for a flow cap of `25`, writes the flow `APPROVED` with `approvalMode` `PRE_APPROVED` and `approverId` the tick's `userId`, opens no request, and leaves the thread's `preApproval` null.
- [integration] `create` by the thread's creator on a thread ticked by another user writes the flow `PRE_APPROVED`.
- [integration] `create` by a user who is neither the tick's user nor the thread's creator writes the flow `PENDING` and leaves the tick in place.
- [integration] `create` on a thread ticked with cap `'9.5'` for a flow cap of `10` writes the flow `PENDING` and leaves the tick in place.
- [integration] Two concurrent `create` calls for one thread produce one flow and one `ConflictAppException` with `fleet.flows.threadBusy`.
- [integration] `create` for a thread whose earlier flow is `STOPPED` succeeds.
- [integration] `create` for a nax entry whose `(repoId, branch, specSha)` already has a live flow throws `ConflictAppException` with `fleet.flows.duplicate` carrying the existing flow id.
- [integration] Two concurrent nax-entry `create` calls for the same repo, branch and sha produce one flow and one `fleet.flows.duplicate` conflict.
- [integration] `create` writes an `AuditEntry` with key `fleet.flow.create` and resourceType `flow`.
- [integration] `create` records a `FleetActivity` row with action `flow.created`, `projectId` the flow's project and payload `{ flowId, entry, featureCount, state }`.
- [integration] When `askService.open` throws inside `create`, no `FleetFlow` row and no `FleetFlowFeature` row remain.

### US-008: Thread pre-approval routes

- [integration] `PUT /api/projects/:slug/threads/:id/preapproval` with `{ costCapUsd: 30 }` by a USER holding `fleet.thread.preapprove` returns 200 and the thread's `preApproval.costCapUsd` is `'30'`.
- [integration] The route's test stubs `ThreadsService.setPreApproval` and asserts it is called once with the route's project id, the thread id, the caller's user id and `'30'`.
- [integration] The same request by an AGENT whose role holds `fleet.thread.preapprove` returns 403 `fleet.flows.humanOnly` and leaves `preApproval` null.
- [integration] The same request by a USER without `fleet.thread.preapprove` returns 403.
- [integration] `PUT` with `costCapUsd: 0` returns 400 naming `costCapUsd`.
- [integration] `PUT` on an ARCHIVED thread returns 409 `threads.archived`.
- [integration] `PUT` on a thread id of another project returns 404 `threads.notFound`.
- [integration] A second `PUT` with `{ costCapUsd: 50 }` by another user stores `'50'` and that user's id.
- [integration] `DELETE /api/projects/:slug/threads/:id/preapproval` by a USER holding the key returns 200 and sets `preApproval` null.
- [integration] `DELETE` by an AGENT returns 403 `fleet.flows.humanOnly`.
- [integration] The permission contract check over all routes reports no `ungated-approvable-write`, `unused-key` or `pending-key-declared` violation.

### US-009: Thread entry route

- [integration] `POST /api/projects/:slug/threads/:id/flows` on a REPO thread with `specPublished` true, `feature` `flow-x`, `publishedSha` S and `runnerId` R returns 201 with `entry` `THREAD`, `branch` `feat/flow-x`, `specSha` S, `pinnedRunnerId` R, `threadId` the thread id and `state` `PENDING`.
- [integration] The route's test stubs `FleetFlowsService.create` and asserts it is called once with entry `THREAD`, the route's `projectId`, the thread id, the parsed features, roles and cap, and creator `{ type: 'USER', id }` of the caller.
- [integration] The route on a thread with `specPublished` false returns 409 `threads.notPublished` and writes no flow.
- [integration] The route on a PROJECT thread returns 409 `threads.notRepoThread`.
- [integration] The route on an ARCHIVED thread returns 409 `threads.archived`.
- [integration] The route with threads disabled in config returns 409 `threads.disabled`.
- [integration] The route on a thread id of another project returns 404 `threads.notFound`.
- [integration] The route on a thread with a `PENDING` flow returns 409 `fleet.flows.threadBusy`.
- [integration] The route by a caller without `fleet.flow.create` returns 403.
- [integration] The route with zero features returns 400 naming `features`.
- [integration] The route by the tick's user on a thread ticked with cap 40, for a flow cap of 25, returns 201 with `state` `APPROVED` and `approval.mode` `PRE_APPROVED`.
- [integration] With an approval policy of mode `agent` on `fleet.flow.create` for the project, the route called by an AGENT returns 202 with the request; approving that request creates the flow in `PENDING`.
- [integration] The response's `url` is `/<slug>/flows/<flowId>`.

### US-010: nax entry route

- [integration] `POST /api/fleet/flows` by an agent rostered on the repo's project, with `remoteUrl` `https://github.com/Org/Repo.git` for FleetRepo `org/repo`, `specSha` equal to the stubbed `getBranchHead` result and `getFile` returning content for every `specPath`, returns 201 with `entry` `NAX`, `threadId` null and `state` `PENDING`.
- [integration] The route's test stubs `FleetFlowsService.create` and asserts it is called once with entry `NAX`, the resolved `repoId`, that repo's `projectId`, `branch`, `specSha`, features, roles, cap, and creator `{ type: 'AGENT', id }`.
- [integration] The route calls `getBranchHead` with the repo's owner, name and `branch`, and `getFile` once per `specPath` with `ref` `specSha`.
- [integration] A `remoteUrl` matching no FleetRepo returns 404 `fleet.flows.repoNotFound`.
- [integration] A `remoteUrl` matching a FleetRepo in a project the agent is not rostered on returns 404 `fleet.flows.repoNotFound`.
- [integration] An agent rostered on the project whose roles lack `fleet.flow.create` returns 403.
- [integration] `getBranchHead` throwing `RepoCheckException` with reason `repo_not_found` returns 409 `fleet.flows.branchNotFound`.
- [integration] A `specSha` different from the branch head returns 409 `fleet.flows.specShaNotHead` and writes no flow.
- [integration] `getFile` returning null for the second `specPath` returns 422 `fleet.flows.specMissing` with that path in the error details, and writes no flow.
- [integration] `getBranchHead` throwing `RepoCheckException` with reason `provider_unreachable` returns 503 `fleet.flows.forgeUnavailable` and writes no flow.
- [integration] `mintReadOnlyToken` throwing `RepoCheckException` with reason `github_app_not_configured` returns 503 `fleet.flows.forgeUnavailable`.
- [integration] A FleetRepo with a null `githubInstallationId` returns 409 `fleet.flows.repoNotConnected`.
- [integration] A second identical send while the first flow is `PENDING` returns 409 `fleet.flows.duplicate` with the first flow's id, and one approval request exists.
- [integration] With an approval policy of mode `agent` on `fleet.flow.create` for the project, the route returns 202 with the request; approving that request creates the flow.
- [integration] `FleetReposService.findByIdentity('github', 'ORG', 'REPO')` returns the FleetRepo stored as `org/repo`, and null for `other/repo`.

### US-011: Flow read and stop routes

- [integration] `GET /api/projects/:slug/flows` returns 200 with `.data.records` holding the project's flows newest first and `.data.total`.
- [integration] `GET /api/projects/:slug/flows/:flowId` returns 200 with a `FleetFlowDto` whose `features` are in position order and whose `costCapUsd` is a string.
- [integration] `GET /api/projects/:slug/flows/:flowId` for a flow of another project returns 404 `fleet.flows.notFound`.
- [integration] `GET /api/fleet/flows/:flowId` by an agent rostered on the flow's project returns 200 with the same body as the project route.
- [integration] `GET /api/fleet/flows/:flowId` by an agent not rostered on the flow's project returns 404 `fleet.flows.notFound`.
- [integration] `GET /api/projects/:slug/flows` by a caller without `fleet.flow.read` returns 403.
- [integration] `POST /api/projects/:slug/flows/:flowId/stop` on a PENDING flow returns 200 with `state` `STOPPED`, `stopReason` `human_stop` and `endedAt` set.
- [integration] Stopping a PENDING flow cancels its open approval request with status `cancelled` and reason `flow_stopped`.
- [integration] Stopping an APPROVED flow returns 200 with `state` `STOPPED`.
- [integration] Stopping a STOPPED flow returns 409 `fleet.flows.notStoppable`.
- [integration] A stop writes an `AuditEntry` with key `fleet.flow.stop` and resourceType `flow`, and a `FleetActivity` row with action `flow.stopped` and payload `{ flowId, stopReason }`.
- [integration] `POST .../stop` by a caller without `fleet.flow.stop` returns 403 and leaves the flow unchanged.
- [integration] With an approval policy of mode `agent` on `fleet.flow.stop` for the project, an AGENT's stop returns 202 and the flow stays `PENDING` until the request is approved.

### US-012: Re-publish sends a thread flow back to PENDING

- [integration] `PrismaThreadIngestRepository.fold` over a batch holding a `published` line emits `THREAD_SPEC_PUBLISHED` once, after its transaction commits, with the line's `sha` and `paths` and the batch's thread id.
- [integration] `fold` over a batch with only `write_doc` lines emits no `THREAD_SPEC_PUBLISHED`.
- [integration] End to end with the real listener: folding a `published` line with new sha N whose `paths` contain spec path P of the thread's APPROVED flow leaves the flow `PENDING` with `specSha` N, approval columns cleared, and a new open `fleet.flow.start` request stored as `approvalRequestId`.
- [integration] For a PENDING flow, an event with new sha N cancels the old request with reason `superseded` and opens a new one with input `specSha` N.
- [integration] For a PENDING flow, an event with new sha N whose `paths` contain none of the flow's spec paths also re-asks.
- [integration] For an APPROVED flow, an event whose `paths` contain none of the flow's spec paths updates `specSha` to N and keeps `state` `APPROVED` and the approval columns.
- [integration] An event whose `sha` is not the thread's current `publishedSha` changes nothing.
- [integration] Delivering the same event twice changes the flow once and leaves one open request.
- [integration] An event for a thread with no live flow writes nothing and does not throw.
- [integration] Each applied re-publish writes an `AuditEntry` with key `system.flow.respec`, resourceType `flow` and `actorType` `SYSTEM`.
- [integration] Each applied re-publish records a `FleetActivity` row with action `flow.respec` and payload `{ flowId, state }`.
- [integration] Approving the request that was open before a re-publish re-asked leaves the flow `PENDING`.
- [integration] A listener that throws is logged and the ingest fold that emitted the event still resolves.
