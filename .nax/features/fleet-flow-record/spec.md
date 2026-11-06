<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet flow record, entries and approval (fleet flow F1)

## Summary

Add the `FleetFlow` record: one flow holds an ordered list of features from one design (feature name, spec path,
dependencies), the branch and sha the spec set was settled at, the reviewer and supervisor role models, a cost cap,
and a state. A flow is created from two entries that share one service: a koda brainstorm thread (a human or agent
on the project route) and an agent key on `POST /api/fleet/flows` (what nax's `nax-flow__send` will call). Every new
flow is `PENDING` and raises one approval request under the new approvable key `fleet.flow.start`, decided by a
human; a thread's pre-approval tickbox (new key `fleet.thread.preapprove`, humans only) lets one flow from that
thread start `APPROVED` instead. A thread that re-publishes a flow's spec after the flow was created sends it back to
`PENDING`. Flows can be listed, read and stopped. F1 dispatches no job and spends nothing: the steps (F3-F5), the
`AGENT` job kind (F2) and the web pages (F6) come later.

## Motivation

The fleet flow design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, merged #392) turns a settled spec
set into ready PRs with one approval. Every later piece (steps, verdicts, merge waits, the flow page, nax's
send-to-koda tool) needs the record, its states and its approval first. nax's G5 `nax-flow__send` is built against
this feature's create endpoint, so F1 ships the nax entry now instead of last.

## Design

### User rulings

- 2026-11-04 (design): koda owns the always-on flow; one approval card after the spec set is settled, always asked
  at least once unless the thread's pre-approval tickbox is ticked; per-thread tickbox only (project-wide
  auto-approve deferred); an agent can propose a flow and can tick nothing; a spec change after approval sends the
  flow back to `PENDING`; a stopped flow is never restarted in place.
- 2026-11-06: the design splits into six features in order: F1 this record (design parts (a) and (g)), F2 the
  `AGENT` job kind, F3 single-feature steps, stops and cap, F4 verdicts and batched questions, F5 multi-feature order
  and merge waits, F6 the web pages.
- 2026-11-06: the caller sends the features list (`feature`, `specPath`, `dependsOn`) on both entries; the F6 form
  prefills it from the thread's published docs.

### Calls made while drafting (not user rulings)

- **Human floor.** `fleet.flow.start` is classified `critical`, so its approval floor and default are `human` and no
  policy can lower it: an agent can never approve a flow. (`high` would default to `agent`, which breaks the design's
  anti-goal "a billed step without a recorded human approval".)
- **Programmatic ask, not a gated route.** The approval gate executes a human caller's action at once (direct humans
  satisfy every mode), so a human-created flow could never be `PENDING` through `routeGate.run`. Creation therefore
  writes the flow and opens the request through `ApprovalAskService.open` with a new component `flow`, on behalf of
  the creator, in the same transaction (the `openBudget` precedent). The creating human may decide it: an on-behalf
  human contributes `human`.
- **Request id on the flow.** The flow row stores `approvalRequestId`; no `FleetApprovalAsk` link row (that table's
  fields are bash- and budget-shaped).
- **Thread entry trusts the thread's publish record.** Thread publish commits to a ref in the runner's local clone
  and never pushes, so koda cannot read thread-entry specs from the forge. The thread entry takes `branch =
  feat/<thread.feature>` and `specSha = thread.publishedSha`, requires `specPublished`, pins the flow to
  `thread.runnerId`, and does not check that each `specPath` exists; a missing spec fails the flow's first step (F3).
- **nax entry verifies on the forge.** `specSha` must equal the branch head (`getBranchHead`), and every `specPath`
  must exist at `specSha` (`getFile`). An unreachable forge fails closed (503): the check is the only evidence the
  approved spec set exists.
- **Re-publish detection is event-driven.** The thread ingest emits `THREAD_SPEC_PUBLISHED` after a `published`
  line's fold commits; a flows listener compares the line's `paths` with the flow's spec paths. Change detection for
  nax-entry flows (a push to the branch) belongs to F3's pre-dispatch check.
- **One live flow per thread.** A thread with a flow in `PENDING` or `APPROVED` refuses a second (409).
- **Bounds.** 1-20 features; feature name `^[a-z0-9][a-z0-9-]{0,63}$`; `specPath` 1-300 characters, relative, `.md`,
  no `..` segment; `dependsOn` names only features listed earlier; role values 1-200 characters of
  `[A-Za-z0-9._:/\[\]=,-]`; `costCapUsd` greater than 0 and at most 1000; tick cap the same bounds.
- **Remote URLs.** `remoteUrl` accepts what `parseGitHubUrl` accepts (`https://github.com/<owner>/<repo>[.git]`);
  GitLab and SSH URLs are refused 400.
- **Developer role.** `developer` gets `fleet.flow.read`, `fleet.flow.create`, `fleet.flow.stop`,
  `fleet.flow.start` and `fleet.thread.preapprove`; owner and admin already hold `*`.

### Flow states

`FleetFlowState`: `PENDING`, `APPROVED`, `RUNNING`, `WAITING_MERGE`, `WAITING_ANSWER`, `COMPLETED`, `STOPPED`. The
transition table (pure `canTransitionFlow(from, to)`):

| from | allowed to |
|:---|:---|
| PENDING | APPROVED, STOPPED |
| APPROVED | RUNNING, PENDING, STOPPED |
| RUNNING | WAITING_MERGE, WAITING_ANSWER, COMPLETED, STOPPED, PENDING |
| WAITING_MERGE | RUNNING, STOPPED |
| WAITING_ANSWER | RUNNING, PENDING, STOPPED |
| COMPLETED | (none) |
| STOPPED | (none) |

F1 itself moves flows only along PENDING -> APPROVED, PENDING -> STOPPED, APPROVED -> PENDING and APPROVED -> STOPPED.
A feature row's `state` is `PENDING` at creation; F3 owns its other values.

Stop reasons written by F1: `approval_rejected`, `human_stop`.

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
  @@index([threadId])
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

`ChatThread` gains `preApproval Json?`, shape `{ userId: string, at: string (ISO), costCapUsd: string }`.

### API

| route | key | actor | result |
|:---|:---|:---|:---|
| `POST /api/projects/:slug/threads/:id/flows` | `fleet.flow.create` | user or agent | 201 flow |
| `PUT /api/projects/:slug/threads/:id/preapproval` | `fleet.thread.preapprove` | user only | 200 thread pre-approval |
| `DELETE /api/projects/:slug/threads/:id/preapproval` | `fleet.thread.preapprove` | user only | 200 |
| `POST /api/fleet/flows` | `fleet.flow.create` (service-enforced in the repo's project) | agent or user | 201 flow |
| `GET /api/projects/:slug/flows` | `fleet.flow.read` | any | 200 page |
| `GET /api/projects/:slug/flows/:flowId` | `fleet.flow.read` | any | 200 flow |
| `GET /api/fleet/flows/:flowId` | `fleet.flow.read` (service-enforced) | any | 200 flow |
| `POST /api/projects/:slug/flows/:flowId/stop` | `fleet.flow.stop` | any | 200 flow |

Thread-entry body: `{ features: [{ feature, specPath, dependsOn? }], roles: { reviewer, supervisor }, costCapUsd }`.
nax-entry body: the same plus `{ remoteUrl, branch, specSha }`. Pre-approval body: `{ costCapUsd }`.

Flow response (`FleetFlowDto`): `id`, `projectId`, `repoId`, `threadId`, `entry`, `createdBy { type, id }`, `branch`,
`specSha`, `pinnedRunnerId`, `roles { reviewer, supervisor }`, `costCapUsd` (string), `spentUsd` (string), `state`,
`approval { mode, approverId, approvedAt, approvalRequestId } | null`, `stopReason`, `endedAt`, `createdAt`,
`features [{ feature, specPath, dependsOn, state, currentStep, prNumber }]` in position order, and `url` (the
web path `/<slug>/flows/<id>`, which F6 renders).

### Integration

Symbols this feature only reads (verified):

- `ApprovalAskService.open<TInput>(ask: OpenAsk, now)` and `OpenAsk { key, projectId, component, onBehalfOf, origin,
  input, deadline }` in `apps/api/src/approvals/approval-ask.service.ts:31-112`: must run inside the caller's
  transaction; returns `{ status: 'not-needed' }` when the mode is none, else `{ status: 'pending', request }`.
- `ApprovalAskService.close(requestId, { status, reason })` in the same file (SYSTEM actors only).
- `ApprovalCommand<TInput, TResult, TDecision>` (`key`, `parse`, `execute`, `onReject?`, `details?`) and
  `ApprovalCommandRegistry.register` in `apps/api/src/approvals/approval-command.registry.ts:38-100`; `register`
  throws unless the key's catalog entry is approvable.
- Precedent for a system-raised ask flipping a record: `ApprovalCloser.openBudget`
  (`apps/api/src/fleet/approvals/approval-closer.ts:119-150`) and `FleetBudgetOverrideCommand`
  (`apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts`, `execute` reads `approvalOf()` for
  `requestId` and `approverId`, registered in `apps/api/src/fleet/approvals/approvals.module.ts` `onModuleInit`).
- `contributedMode` in `apps/api/src/approvals/approval-eligibility.ts`: an on-behalf `USER` decider contributes
  `human`.
- `AuditRecorder.record({ key, resourceType, resourceId, projectId?, summary? })`
  (`apps/api/src/audit/audit-recorder.service.ts:44`): throws `unknown audit key` for a key with no catalog entry;
  runs inside a transaction; actor and approval come from `currentContext()`.
- `FleetActivityService.record(entry)` (`apps/api/src/fleet/activity/fleet-activity.service.ts:22`); a payload key
  matching `/token|secret|key|password|credential/i` throws, so flow payloads use `flowId`, `state`, `entry`,
  `stopReason`, `featureCount` only.
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)`, `getBranchHead(token, owner, name, branch):
  Promise<string>` and `getFile(token, owner, name, path, ref): Promise<ForgeFile | null>`
  (`apps/api/src/fleet/git-broker/github-app-client.ts:102, 312, 338`); failures surface as `RepoCheckException`
  from `FleetHttpClient.request`.
- `parseGitHubUrl(url)` (`apps/api/src/skills/github-url.ts:12-22`): `https://github.com/<owner>/<repo>[.git]`
  only, lowercased.
- `ProjectsService.findAllForPrincipal(principal)` (`apps/api/src/projects/projects.service.ts:88-96`): the
  projects an agent can reach.
- `PermissionService.can(principal, key, { projectId, resource })` and `canHoldKey`
  (`apps/api/src/permissions/permission.service.ts:66-82`): a catalog entry whose `principals` excludes the caller's
  type is denied `principal-type`.
- `GIT_REF_RE` (`apps/api/src/fleet/jobs/dispatch-input.ts:12`).
- `ChatThreadRecord` (`apps/api/src/fleet/threads/domain/chat-thread.domain.ts:72-99`): `kind`, `repoId`,
  `feature`, `specPublished`, `publishedSha`, `runnerId`, `status`.
- Thread routes: `@Controller('projects/:slug/threads')` in `apps/api/src/fleet/threads/threads.controller.ts:40`;
  the `changeMode` route (`:116-132`) and `PrismaChatThreadRepository.changeMode` (`prisma-chat-thread.repository.ts:205-260`,
  row lock then `audit.record`) are the precedent for an audited thread setting.
- Post-commit event precedent: `PROJECT_SOFT_DELETED` (`apps/api/src/projects/project-events.ts:14`) emitted with
  `EventEmitter2` by `ProjectsService` and consumed by `@OnEvent` in `apps/api/src/vcs/vcs-project-deletion.listener.ts:40`.

Symbols this feature changes. The baseline only locates the code; implement the target.

- `ASK_KEYS_BY_COMPONENT` (`apps/api/src/approvals/approval-ask.service.ts:49`).
  Baseline: `{ runner: 'fleet.job.shell.escalate', budget: 'fleet.budget.override' }`.
  Target: the same plus `flow: 'fleet.flow.start'`.
- Permission catalog (`apps/api/src/permissions/catalog.ts`).
  Baseline: `NEW_KEY_SCOPES` (line 119) has no `fleet.flow.*` or `fleet.thread.preapprove`; `classifyRisk` (~line
  438) returns `critical` only for role-grant, `role.` and `approval.policy.` keys; `buildEntry` (line 479) restricts
  `principals` to `['user']` only for `OWNER_BINDING_KEY`.
  Target: `NEW_KEY_SCOPES` adds `fleet.flow.read`, `fleet.flow.create`, `fleet.flow.start`, `fleet.flow.stop`,
  `fleet.thread.preapprove`, all `'project'`; `fleet.flow.start` is approvable and classified `critical`;
  a `USER_ONLY_KEYS` set holding `OWNER_BINDING_KEY` and `fleet.thread.preapprove` drives `principals: ['user']`.
- `FLEET_ENTITY_TYPES` (`apps/api/src/fleet/activity/domain/fleet-activity.domain.ts:8-22`).
  Baseline: ends at `provider_credential`. Target: adds `flow`.
- `IFleetRepoRepository` (`apps/api/src/fleet/repos/domain/fleet-repo.domain.ts:39-66`).
  Baseline: `findById`, `findPage`, `findAnchor`, no lookup by identity.
  Target: adds `findByIdentity(provider, owner, name): Promise<FleetRepoRecord | null>`, matching owner and name
  case-insensitively.
- Thread ingest `foldWriteLine` (`apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts:562`).
  Baseline: writes the `published` patch and nothing else.
  Target: after the fold transaction commits, a `published` line emits `THREAD_SPEC_PUBLISHED` with
  `{ threadId, sha, paths }`.

### Approach

```ts
// apps/api/src/fleet/flows/fleet-flow-start.command.ts (worked skeleton)
@Injectable()
export class FleetFlowStartCommand implements ApprovalCommand<FlowStartInput, FlowStartResult> {
  readonly key = 'fleet.flow.start';
  parse(input: unknown): FlowStartInput { /* { flowId: string, specSha: 40 hex } or throw */ }
  async execute(input: FlowStartInput): Promise<FlowStartResult> {
    const { requestId, approverId } = approvalOf();
    const flow = await this.flows.lockById(input.flowId);
    if (!flow || flow.state !== 'PENDING' || flow.approvalRequestId !== requestId || flow.specSha !== input.specSha) {
      return { applied: false };
    }
    await this.flows.approve(flow.id, { mode: 'REQUEST', approverId, approvedAt: new Date(), approvalRequestId: requestId });
    await this.audit.record({ key: 'fleet.flow.start', resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId, summary: 'flow approved' });
    return { applied: true };
  }
  async onReject(input: FlowStartInput): Promise<void> { /* same guard; PENDING -> STOPPED, stopReason approval_rejected, audit */ }
}
```

Creation (`FleetFlowsService.create`) runs in one `txManager.run`: insert the flow and its features, then either
consume the thread tick (PRE_APPROVED) or call `askService.open({ key: 'fleet.flow.start', component: 'flow',
onBehalfOf: { type: creatorType, id: creatorId }, origin: 'system', projectId, input: { flowId, specSha }, deadline:
null })` and store the returned request id; audit `fleet.flow.create`; record activity `flow.created`.

### Failure Handling

| case | response |
|:---|:---|
| body fails a bound (features, roles, cap, branch, sha, remoteUrl) | 400 `ValidationAppException` naming the property |
| thread not found, archived, not REPO kind | 404 `threads.notFound` / 409 `threads.archived` / 409 `threads.repoOnly` |
| thread spec not published | 409 `threads.notPublished` |
| thread already has a PENDING or APPROVED flow | 409 `fleet.flows.threadBusy` |
| nax entry: `remoteUrl` resolves to no repo, or to one in a project the caller cannot reach | 404 `fleet.flows.repoNotFound` |
| nax entry: caller lacks `fleet.flow.create` in the repo's project | 403 |
| nax entry: `specSha` is not the branch head, or the branch is missing | 409 `fleet.flows.specShaNotHead` |
| nax entry: a `specPath` is missing at `specSha` | 422 `fleet.flows.specMissing`, naming the path |
| nax entry: the forge read fails (token mint or HTTP) | 503 `fleet.flows.forgeUnavailable`; no flow written |
| repo has no GitHub installation id | 409 `fleet.flows.repoNotConnected` |
| pre-approval set by an agent | 403 (principal type) |
| stop on a flow already `STOPPED` or `COMPLETED` | 409 `fleet.flows.notStoppable` |
| flow not found or not in the route's project | 404 `fleet.flows.notFound` |
| approval decided after the flow left `PENDING`, or for a superseded request | no-op, `{ applied: false }` |
| re-publish event for a thread with no live flow | no-op |

## Out of Scope

- Dispatching any job (spec review, PLAN, PRD review, RUN, REVIEW, FIX, finish); F1 creates, approves and stops records only.
- The `AGENT` job kind and `nax agents run` on the runner (fleet flow F2).
- Single-feature steps, the cost cap check between jobs, `spentUsd` accumulation and job-failure stops (fleet flow F3).
- Detecting a push to a nax-entry flow's branch after approval; F3 checks the branch before each dispatch.
- Review verdicts, spec-fix jobs, batched questions and the flow's ticket (fleet flow F4).
- Feature order, merge waits and independent features starting from main (fleet flow F5).
- Every web page: the Start flow form, the tickbox control, the flow page and the approval card's flow details (fleet flow F6).
- Cloning a stopped flow into a new pending flow (deferred to F6).
- A project-wide auto-approve setting (deferred by the user 2026-11-04).
- GitLab repos and SSH remote URLs on the nax entry.
- Verifying thread-entry spec paths exist: thread publish never pushes, so the first step (F3) is where a missing spec fails.
- Approval request expiry: flow requests open with `deadline: null`.
- Notifications for a pending flow beyond what the approval engine already sends for a new request.
- Changes under `.nax/` (rules, config): none are needed; `.nax/` is read-only to the run.

## Stories

### US-001: Flow permission keys, catalog risk and principals, activity entity

Workdir: `apps/api`. No dependencies. Adds the five keys to `NEW_KEY_SCOPES` (project scope), makes
`fleet.flow.start` approvable and `critical`, introduces `USER_ONLY_KEYS` (`role.binding.owner`,
`fleet.thread.preapprove`) driving `principals: ['user']`, adds the keys to the `developer` system role, adds `flow`
to `FLEET_ENTITY_TYPES` and `flow: 'fleet.flow.start'` to `ASK_KEYS_BY_COMPONENT`, and regenerates the role-matrix
snapshot.

### US-002: FleetFlow model, migration, repository and state rules

Workdir: `apps/api`. No dependencies. Prisma models `FleetFlow` and `FleetFlowFeature`, `ChatThread.preApproval`,
migration `20261125090000_fleet_flows`, the domain types and `FLEET_FLOW_REPOSITORY` token, a
`PrismaFleetFlowRepository` extending `AbstractPrismaRepository` (create with features, `findById`, `lockById`,
`findPage({ projectId })`, `findLiveForThread(threadId)`, `approve`, `toPending`, `stop`), and the pure
`canTransitionFlow(from, to)` table.

### US-003: The fleet.flow.start approval command

Workdir: `apps/api`. Depends on US-001, US-002. `FleetFlowStartCommand` (`parse`, `execute`, `onReject`, `details`),
registered at module init; approve flips PENDING to APPROVED with the approval record, reject stops with
`approval_rejected`, and a stale or superseded decision is a no-op.

### US-004: Flow input validation and the create service

Workdir: `apps/api`. Depends on US-003. `parseFlowInput` (features, roles, cap bounds) and
`FleetFlowsService.create(input, creator, context)`: one transaction inserting the flow and features, opening the
`fleet.flow.start` ask on behalf of the creator (or consuming a matching thread tick), storing the request id,
auditing `fleet.flow.create` and recording `flow.created` activity.

### US-005: Thread pre-approval tickbox routes

Workdir: `apps/api`. Depends on US-001, US-002. `PUT` and `DELETE /api/projects/:slug/threads/:id/preapproval`:
humans only, audited under `fleet.thread.preapprove`, writing or clearing `ChatThread.preApproval`.

### US-006: Thread entry route

Workdir: `apps/api`. Depends on US-004, US-005. `POST /api/projects/:slug/threads/:id/flows`: thread checks (REPO,
not archived, spec published, no live flow), branch `feat/<feature>`, `specSha = publishedSha`, `pinnedRunnerId =
runnerId`, then `FleetFlowsService.create`; a tick whose cap is at least the flow's cap makes the flow
`PRE_APPROVED`.

### US-007: nax entry route

Workdir: `apps/api`. Depends on US-004. `POST /api/fleet/flows`: `remoteUrl` to `FleetRepo` through the new
`findByIdentity`, reachability (404) and key (403) checks in the repo's project, forge checks (`specSha` is the
branch head, every `specPath` exists at it), then `FleetFlowsService.create` with entry `NAX`; always `PENDING`.

### US-008: Flow read and stop routes

Workdir: `apps/api`. Depends on US-004. `GET /api/projects/:slug/flows`, `GET /api/projects/:slug/flows/:flowId`,
`GET /api/fleet/flows/:flowId` (service-enforced read in the flow's project) and `POST
/api/projects/:slug/flows/:flowId/stop` (closes a pending request, stops with `human_stop`, audits
`fleet.flow.stop`).

### US-009: Re-publish sends a thread flow back to PENDING

Workdir: `apps/api`. Depends on US-004. The thread ingest emits `THREAD_SPEC_PUBLISHED` after a `published` line's
fold commits; a `FleetFlowPublishListener` handles it: for the thread's live flow, a publish whose `paths` include any
of the flow's spec paths moves an APPROVED flow to PENDING (approval cleared, new ask) or re-asks a PENDING flow
(old request closed `superseded`, new one opened), and updates `specSha`; a publish touching none of them only updates
`specSha`.

Nine stories: one capability (the flow record's lifecycle up to approval), confirmed against the split ruling of
2026-11-06; every story is in `apps/api`.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES`, `classifyRisk`, `buildEntry`
- `apps/api/src/permissions/system-roles.ts` — the `developer` role key list
- `apps/api/src/approvals/approval-ask.service.ts` — `ASK_KEYS_BY_COMPONENT`
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — `FLEET_ENTITY_TYPES`

**US-002**
- `apps/api/prisma/schema.prisma` — `ChatThread`, `FleetRepo`, `ProviderCredential` models
- `apps/api/src/fleet/provider-credentials/prisma-provider-credential.repository.ts` — `AbstractPrismaRepository` precedent
- `apps/api/src/fleet/provider-credentials/provider-credentials.module.ts` — token wiring precedent
- `apps/api/prisma/migrations/20261105000000_provider_credentials/migration.sql` — migration style

**US-003**
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` — command precedent
- `apps/api/src/fleet/approvals/approvals.module.ts` — `onModuleInit` registration
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand` interface

**US-004**
- `apps/api/src/fleet/approvals/approval-closer.ts` — `openBudget` ask precedent
- `apps/api/src/approvals/approval-ask.service.ts` — `open`, `OpenAsk`
- `apps/api/src/audit/audit-recorder.service.ts` — `record`
- `apps/api/src/fleet/activity/fleet-activity.service.ts` — `record`

**US-005**
- `apps/api/src/fleet/threads/threads.controller.ts` — `changeMode` route precedent
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `changeMode` row lock and audit
- `apps/api/src/permissions/permission.service.ts` — principal-type denial

**US-006**
- `apps/api/src/fleet/threads/threads.service.ts` — `plan` guards (`threads.notPublished`, archived, REPO only)
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRecord`

**US-007**
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintReadOnlyToken`, `getBranchHead`, `getFile`
- `apps/api/src/skills/github-url.ts` — `parseGitHubUrl`
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`
- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — global fleet route precedent

**US-008**
- `apps/api/src/fleet/provider-credentials/project-provider-credentials.controller.ts` — project-scoped route and page shape precedent

**US-009**
- `apps/api/src/projects/project-events.ts` — post-commit event precedent
- `apps/api/src/vcs/vcs-project-deletion.listener.ts` — `@OnEvent` listener precedent
- `apps/api/src/fleet/threads/ingest/thread-write-fold.ts` — the `published` patch and its `paths`

### Creates

**US-002**
- `apps/api/prisma/migrations/20261125090000_fleet_flows/migration.sql`
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`
- `apps/api/src/fleet/flows/flow-states.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts`

**US-003**
- `apps/api/src/fleet/flows/fleet-flow-start.command.ts`
- `apps/api/src/fleet/flows/flows.module.ts`

**US-004**
- `apps/api/src/fleet/flows/flow-input.ts`
- `apps/api/src/fleet/flows/fleet-flows.service.ts`
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.ts`

**US-005**
- `apps/api/src/fleet/flows/thread-preapproval.controller.ts`

**US-006**
- `apps/api/src/fleet/flows/thread-flows.controller.ts`

**US-007**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts`

**US-008**
- `apps/api/src/fleet/flows/project-flows.controller.ts`

**US-009**
- `apps/api/src/fleet/flows/fleet-flow-publish.listener.ts`

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.ts` — add the five keys to `NEW_KEY_SCOPES`, classify `fleet.flow.start` `critical` and approvable, and replace the single `OWNER_BINDING_KEY` principal check in `buildEntry` with `USER_ONLY_KEYS`.
- `apps/api/src/permissions/catalog.spec.ts` — this spec keeps its own copy of `NEW_KEY_SCOPES` and asserts the full key list (line ~392); add the five keys to both, and the `principals` expectations for `fleet.thread.preapprove`.
- `apps/api/src/permissions/system-roles.ts` — add the five keys to the `developer` role.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated snapshot: the five keys appear for owner, admin and developer only.
- `apps/api/src/approvals/approval-ask.service.ts` — add `flow: 'fleet.flow.start'` to `ASK_KEYS_BY_COMPONENT`.
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — add `flow` to `FLEET_ENTITY_TYPES`.

**US-002**
- `apps/api/prisma/schema.prisma` — add `FleetFlow`, `FleetFlowFeature`, `ChatThread.preApproval Json?`, and the back-relations on `Project` and `FleetRepo`.

**US-003**
- `apps/api/src/app.module.ts` — import `FlowsModule`.

**US-004**
- `apps/api/src/i18n/en/fleet.json` — add the `fleet.flows.*` error messages in the Failure Handling table.
- `apps/api/src/i18n/zh/fleet.json` — add the same `fleet.flows.*` keys in Chinese.

**US-005**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the pre-approval routes: happy path and one error each, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new routes.

**US-006**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the thread entry route: happy path and one error, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new route.

**US-007**
- `apps/api/src/fleet/repos/domain/fleet-repo.domain.ts` — add `findByIdentity(provider, owner, name)` to `IFleetRepoRepository`.
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — implement `findByIdentity` with case-insensitive owner and name.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the nax entry route (POST to fleet flows): happy path and one error, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new route.

**US-008**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add the read and stop routes: happy path and one error each, with exact status codes.
- `openapi.json` — regenerated by `bun run api:export-spec` for the new routes.

**US-009**
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — emit `THREAD_SPEC_PUBLISHED` `{ threadId, sha, paths }` after the fold transaction that applied a `published` line commits.
- `apps/api/src/fleet/threads/ingest/thread-ingest.module.ts` — provide `EventEmitter2` to the ingest repository if the module does not already reach it.

### Seams

- US-003 -> US-004: `FleetFlowsService.create` opens the ask with key `fleet.flow.start`, which only resolves because US-003 registered `FleetFlowStartCommand` (`askService.open` throws `UnregisteredApprovalCommandError` otherwise).
- US-004 -> US-006, US-007: both routes call `FleetFlowsService.create`; their tests stub it and assert the arguments.
- US-002 -> US-009: the listener calls the repository's `findLiveForThread` and `toPending`.
- US-009 (ingest -> listener): `THREAD_SPEC_PUBLISHED` is emitted by the ingest and consumed by `FleetFlowPublishListener`.

## Acceptance Criteria

### US-001: Flow permission keys, catalog risk and principals, activity entity

- [unit] `findCatalogEntry('fleet.flow.start')` returns an entry with scope `project`, `approval.approvable === true`, risk `critical`, and approval floor and default both `human`.
- [unit] `findCatalogEntry` returns an entry with scope `project` for each of `fleet.flow.read`, `fleet.flow.create`, `fleet.flow.stop` and `fleet.thread.preapprove`.
- [unit] `findCatalogEntry('fleet.thread.preapprove').principals` equals `['user']`.
- [unit] `findCatalogEntry('role.binding.owner').principals` still equals `['user']`.
- [unit] `findCatalogEntry('fleet.flow.create').principals` equals `['user', 'agent']`.
- [unit] `PermissionService.canHoldKey` for an AGENT principal bound to a role holding `fleet.thread.preapprove` returns false.
- [unit] An approval policy resolution for `fleet.flow.start` with a project policy of mode `agent` resolves mode `human` (the floor wins).
- [unit] The `developer` system role's effective keys include `fleet.flow.read`, `fleet.flow.create`, `fleet.flow.start`, `fleet.flow.stop` and `fleet.thread.preapprove`; the `viewer` role's include none of them.
- [unit] `ASK_KEYS_BY_COMPONENT.flow` equals `fleet.flow.start`.
- [unit] `FleetActivityService.record` with `entityType: 'flow'` and payload `{ flowId, state }` writes the row without throwing.

### US-002: FleetFlow model, migration, repository and state rules

- [unit] `canTransitionFlow` returns true for every pair listed in the Flow states table.
- [unit] `canTransitionFlow('PENDING', 'RUNNING')` returns false.
- [unit] `canTransitionFlow('COMPLETED', 'PENDING')` and `canTransitionFlow('STOPPED', 'APPROVED')` return false.
- [integration] `PrismaFleetFlowRepository.create` with three features persists them with positions 0, 1, 2, each feature `state` `PENDING`, and the flow `state` `PENDING`, `spentUsd` `0`.
- [integration] `findById` returns the features in position order with their `dependsOn` arrays.
- [integration] Creating two features with the same `feature` name in one flow fails with Prisma error code `P2002` and writes no flow row.
- [integration] `findLiveForThread(threadId)` returns the flow in `PENDING` or `APPROVED` for that thread and null when the thread's only flow is `STOPPED`.
- [integration] `approve(flowId, { mode: 'REQUEST', approverId, approvedAt, approvalRequestId })` sets `state` `APPROVED` and the four approval columns.
- [integration] `toPending(flowId, { specSha, approvalRequestId })` on an APPROVED flow sets `state` `PENDING`, clears `approvalMode`, `approverId` and `approvedAt`, and stores the new sha and request id.
- [integration] `stop(flowId, 'human_stop', now)` sets `state` `STOPPED`, `stopReason` `human_stop` and `endedAt` `now`.
- [integration] A repository transition whose `canTransitionFlow(current, target)` is false (for example `stop` on a STOPPED flow) throws `FlowTransitionError` and leaves the row unchanged.
- [integration] `findPage({ projectId })` returns that project's flows newest first, bounded by the page size, and excludes another project's flows.
- [integration] Deleting the flow's `FleetRepo` deletes the flow and its features (cascade).

### US-003: The fleet.flow.start approval command

- [unit] `FleetFlowStartCommand.parse({ flowId: 'f1', specSha: <40 hex> })` returns the same object, and `parse` of a value with a 39-character sha throws.
- [integration] Approving the request opened for a PENDING flow (through `ApprovalDecisionService.decide` as a human holding `fleet.flow.start` and `approval.decide`) sets the flow `APPROVED` with `approvalMode` `REQUEST`, `approverId` the human's id and `approvalRequestId` the request id.
- [integration] That approval writes an `AuditEntry` with key `fleet.flow.start`, resourceType `flow`, `approverType` `USER` and `approvalRequestId` the request id.
- [integration] That approval records a `FleetActivity` row with action `flow.approved`, entityType `flow` and entityId the flow id.
- [integration] Rejecting the request sets the flow `STOPPED` with `stopReason` `approval_rejected` and `endedAt` set.
- [integration] Approving a request whose flow is already `STOPPED` leaves the flow `STOPPED` and the command returns `{ applied: false }`.
- [integration] Approving a request whose id is not the flow's current `approvalRequestId` (superseded by a re-ask) leaves the flow `PENDING` and returns `{ applied: false }`.
- [integration] Approving a request whose stored `specSha` differs from the flow's current `specSha` leaves the flow `PENDING` and returns `{ applied: false }`.
- [integration] An AGENT decider holding `fleet.flow.start` and `approval.decide` cannot approve the request: `decide` refuses it as not eligible and the flow stays `PENDING`.
- [unit] `FlowsModule.onModuleInit` registers the command: `ApprovalCommandRegistry.get('fleet.flow.start')` returns a `FleetFlowStartCommand` instance.
- [unit] `FleetFlowStartCommand.details(request)` returns `{ kind: 'flow', flowId, state, branch, specSha, costCapUsd, features }` for the request's flow, and null when the flow is gone.

### US-004: Flow input validation and the create service

- [unit] `parseFlowInput` accepts one feature `{ feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md' }` with roles `{ reviewer: 'acp:claude', supervisor: 'native:fast' }` and `costCapUsd: 25` and returns `dependsOn: []` for the feature.
- [unit] `parseFlowInput` with zero features, or 21 features, throws `ValidationAppException` naming `features`.
- [unit] `parseFlowInput` with a feature name `Flow_A` throws `ValidationAppException` naming `features.0.feature`.
- [unit] `parseFlowInput` with two features named `flow-a` throws `ValidationAppException` naming `features.1.feature`.
- [unit] `parseFlowInput` with a `specPath` of `../x.md`, `/abs/spec.md` or `spec.txt` throws `ValidationAppException` naming `features.0.specPath`.
- [unit] `parseFlowInput` where the second feature's `dependsOn` is `['flow-c']` and `flow-c` is the third feature (a forward reference) throws `ValidationAppException` naming `features.1.dependsOn`.
- [unit] `parseFlowInput` where a feature depends on itself throws `ValidationAppException` naming that feature's `dependsOn`.
- [unit] `parseFlowInput` with a missing `roles.reviewer`, or a `roles.supervisor` containing a space, throws `ValidationAppException` naming that role property.
- [unit] `parseFlowInput` with `costCapUsd` of `0`, `-1` or `1000.01` throws `ValidationAppException` naming `costCapUsd`; `1000` is accepted.
- [integration] `FleetFlowsService.create` for a USER creator with no thread tick writes a `PENDING` flow, opens an `ApprovalRequest` with permissionKey `fleet.flow.start`, `onBehalfOf` the creator, required mode `human` and input `{ flowId, specSha }`, and stores its id as the flow's `approvalRequestId`.
- [integration] `FleetFlowsService.create` for an AGENT creator opens the request with `onBehalfOf` `{ type: 'AGENT', id }`.
- [integration] `FleetFlowsService.create` with a thread whose `preApproval.costCapUsd` is at least the flow's `costCapUsd` writes the flow `APPROVED` with `approvalMode` `PRE_APPROVED`, `approverId` the tick's `userId`, opens no `ApprovalRequest`, and clears the thread's `preApproval`.
- [integration] `FleetFlowsService.create` with a thread tick whose cap is below the flow's cap writes the flow `PENDING`, opens the request, and leaves the thread's `preApproval` unchanged.
- [integration] `FleetFlowsService.create` writes an `AuditEntry` with key `fleet.flow.create` and resourceType `flow`, and a `FleetActivity` row with action `flow.created` whose payload is `{ flowId, entry, featureCount, state }`.
- [integration] When `askService.open` throws inside `create`, no `FleetFlow` row and no `FleetFlowFeature` row remain.

### US-005: Thread pre-approval tickbox routes

- [integration] `PUT /api/projects/:slug/threads/:id/preapproval` with `{ costCapUsd: 30 }` by a USER holding `fleet.thread.preapprove` returns 200 and stores `preApproval` `{ userId, at, costCapUsd: '30' }` on the thread.
- [integration] The same request writes an `AuditEntry` with key `fleet.thread.preapprove`, resourceType `thread` and resourceId the thread id.
- [integration] The same request by an AGENT whose role holds `fleet.thread.preapprove` returns 403 and leaves `preApproval` null.
- [integration] The same request by a USER without `fleet.thread.preapprove` returns 403.
- [integration] `PUT` with `costCapUsd: 0` returns 400 naming `costCapUsd`.
- [integration] `PUT` on an ARCHIVED thread returns 409 `threads.archived`.
- [integration] `PUT` on a thread id in another project returns 404 `threads.notFound`.
- [integration] A second `PUT` with `{ costCapUsd: 50 }` replaces the stored cap with `'50'` and the `userId` with the second caller's id.
- [integration] `DELETE /api/projects/:slug/threads/:id/preapproval` by a USER holding the key returns 200, sets `preApproval` null and writes an `AuditEntry` with key `fleet.thread.preapprove` and a summary naming the clear.
- [integration] `DELETE` on a thread with no tick returns 200 and writes no `AuditEntry`.

### US-006: Thread entry route

- [integration] `POST /api/projects/:slug/threads/:id/flows` on a REPO thread with `specPublished` true, `feature` `flow-x`, `publishedSha` S and `runnerId` R returns 201 with a flow whose `entry` is `THREAD`, `branch` `feat/flow-x`, `specSha` S, `pinnedRunnerId` R, `threadId` the thread id and `state` `PENDING`.
- [integration] The route's test stubs `FleetFlowsService.create` and asserts it is called once with `repoId` the thread's repo, `projectId` the route's project, the parsed features, roles and cap, and the creator `{ type: 'USER', id }` of the caller.
- [integration] The route on a thread with `specPublished` false returns 409 `threads.notPublished` and writes no flow.
- [integration] The route on a PROJECT or WORKSPACE thread returns 409 `threads.repoOnly`.
- [integration] The route on an ARCHIVED thread returns 409 `threads.archived`.
- [integration] The route on a thread that already has a `PENDING` flow returns 409 `fleet.flows.threadBusy`.
- [integration] The route on a thread whose only earlier flow is `STOPPED` returns 201.
- [integration] The route by a caller without `fleet.flow.create` returns 403.
- [integration] The route with an invalid body (zero features) returns 400 naming `features`.
- [integration] The route on a thread whose tick cap is 40, for a flow with `costCapUsd` 25, returns 201 with `state` `APPROVED` and `approval.mode` `PRE_APPROVED`.
- [integration] The route called by an AGENT on a ticked thread returns 201 `APPROVED` with `approval.approverId` the tick's human `userId`.
- [integration] The response body's `url` is `/<slug>/flows/<flowId>`.

### US-007: nax entry route

- [integration] `POST /api/fleet/flows` by an agent rostered on the repo's project, with `remoteUrl` `https://github.com/Org/Repo.git` for a FleetRepo `org/repo`, a `specSha` equal to the stubbed `getBranchHead` result, and `getFile` returning content for every `specPath`, returns 201 with `entry` `NAX`, `threadId` null and `state` `PENDING`.
- [integration] The route's test stubs `FleetFlowsService.create` and asserts it is called once with the resolved `repoId`, that repo's `projectId`, `branch`, `specSha`, features, roles, cap, and creator `{ type: 'AGENT', id }`.
- [integration] The route calls `getBranchHead` with the repo's owner, name and the body's `branch`, and `getFile` once per `specPath` with `ref` equal to `specSha`.
- [integration] A `remoteUrl` matching no FleetRepo returns 404 `fleet.flows.repoNotFound`.
- [integration] A `remoteUrl` matching a FleetRepo in a project the agent is not rostered on returns 404 `fleet.flows.repoNotFound`, not 403.
- [integration] An agent rostered on the project whose roles lack `fleet.flow.create` returns 403.
- [integration] A `remoteUrl` of `git@github.com:org/repo.git` returns 400 naming `remoteUrl`.
- [integration] A `specSha` of 39 hex characters returns 400 naming `specSha`, and a `branch` of `feat/..x` returns 400 naming `branch`.
- [integration] A `specSha` different from the branch head returns 409 `fleet.flows.specShaNotHead` and writes no flow.
- [integration] `getFile` returning null for the second `specPath` returns 422 `fleet.flows.specMissing` with that path in the error details, and writes no flow.
- [integration] `getBranchHead` throwing `RepoCheckException` returns 503 `fleet.flows.forgeUnavailable` and writes no flow.
- [integration] A FleetRepo with a null `githubInstallationId` returns 409 `fleet.flows.repoNotConnected`.
- [integration] A flow created by the nax entry is `PENDING` even when the body's features match a thread with a pre-approval tick.
- [integration] `findByIdentity('github', 'ORG', 'REPO')` returns the FleetRepo stored as `org/repo`, and null for `other/repo`.

### US-008: Flow read and stop routes

- [integration] `GET /api/projects/:slug/flows` returns 200 with `.data.records` holding the project's flows newest first and `.data.total`.
- [integration] `GET /api/projects/:slug/flows/:flowId` returns 200 with a `FleetFlowDto` whose `features` are in position order and whose `costCapUsd` is a string.
- [integration] `GET /api/projects/:slug/flows/:flowId` for a flow in another project returns 404 `fleet.flows.notFound`.
- [integration] `GET /api/fleet/flows/:flowId` by an agent rostered on the flow's project with `fleet.flow.read` returns 200 with the same body as the project route.
- [integration] `GET /api/fleet/flows/:flowId` by an agent not rostered on the flow's project returns 404 `fleet.flows.notFound`.
- [integration] `GET /api/projects/:slug/flows` by a caller without `fleet.flow.read` returns 403.
- [integration] `POST /api/projects/:slug/flows/:flowId/stop` on a PENDING flow returns 200 with `state` `STOPPED`, `stopReason` `human_stop` and `endedAt` set.
- [integration] Stopping a PENDING flow closes its open approval request (status no longer `pending`), so a later approve of that request leaves the flow `STOPPED`.
- [integration] Stopping an APPROVED flow returns 200 with `state` `STOPPED`.
- [integration] Stopping a STOPPED flow returns 409 `fleet.flows.notStoppable`.
- [integration] A stop writes an `AuditEntry` with key `fleet.flow.stop` and resourceType `flow`, and a `FleetActivity` row with action `flow.stopped` and payload `{ flowId, stopReason }`.
- [integration] `POST .../stop` by a caller without `fleet.flow.stop` returns 403 and leaves the flow unchanged.

### US-009: Re-publish sends a thread flow back to PENDING

- [integration] Folding a thread `published` line through the thread ingest emits `THREAD_SPEC_PUBLISHED` once, after the fold commits, with `{ threadId, sha, paths }` from the line.
- [integration] Folding a `write_doc` line emits no `THREAD_SPEC_PUBLISHED`.
- [integration] The listener test emits `THREAD_SPEC_PUBLISHED` through `EventEmitter2` for a thread whose APPROVED flow has spec path P, with `paths` containing P and a new sha N: the flow becomes `PENDING`, `specSha` N, approval columns cleared, and a new `fleet.flow.start` request is open and stored as `approvalRequestId`.
- [integration] For a PENDING flow, the same event closes the old request (status no longer `pending`) and opens a new one with input `specSha` N.
- [integration] An event whose `paths` contain none of the flow's spec paths updates `specSha` to N and leaves the flow's state and `approvalRequestId` unchanged.
- [integration] An event for a thread with no PENDING or APPROVED flow writes nothing and does not throw.
- [integration] A flow moved back to PENDING by the listener writes an `AuditEntry` with key `fleet.flow.create`, resourceType `flow` and a summary naming the re-publish, and a `FleetActivity` row with action `flow.respec` and payload `{ flowId, state }`.
- [integration] Delivering the same event twice opens one new request in total: the second delivery finds `specSha` already N and changes nothing.
- [integration] Approving the request that was open before the re-publish leaves the flow `PENDING` (superseded request).
