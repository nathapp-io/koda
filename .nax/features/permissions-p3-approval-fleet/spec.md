# SPEC: Permissions P3d-2 — Fleet Asks on the Approval Engine

## Summary

This feature moves the two fleet asks onto the approval engine and drops `FleetApproval`.
- **Bash asks.** A nax job's shell escalation (`nax_bash_escalate`) becomes an `ApprovalRequest` for `fleet.job.shell.escalate`, opened by the runner relay through `ApprovalAskService.open`, linked by `FleetApprovalAsk`, and answered by a registered command that writes the runner's `APPROVAL_ANSWER`.
- **Budget asks.** A budget hard stop (`budget_override_required`) becomes an `ApprovalRequest` for `fleet.budget.override`, opened by the budget evaluator, and approved by a registered command that raises the amount, resumes the policy and re-queues the chosen jobs.
- **Closes.** A job leaving `RUNNING`, a newer hard stop, a window reset, a deleted policy and a manual resume close the ask through `ApprovalAskService.close`.
- **Adapters.** These keep their shapes, now built from the engine request and its link: `/fleet/approvals` (list, get, decide), `/fleet/approval-counts`, `FleetApprovalDto`, the `fleet.approval.requested`/`.resolved` webhooks, the fleet activity rows, the `fleet_approval` live events and the `fleet_approval_requested` notification. The web and the CLI do not change.
- **Readers.** Job pending counts, the dashboard, the home page, the assistant's project counts and the fleet notification reader read the engine.
- **Cleanup.** `FleetApproval`, its repository, `ApprovalExpirySweeper` and the old closer paths are deleted.

This is the second half of feature 4 of P3 in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Asks raised by runners and the system", §8 "No data migration"). The first half, `permissions-p3-approval-fleet-core` (PR #342), built the engine support with no production caller: the two catalog keys, decision params, `ApprovalAskService`, the SYSTEM resolver subject and the `FleetApprovalAsk` link table.

## Motivation

Two request models still exist: the engine's `ApprovalRequest` and the fleet's `FleetApproval`. Two inboxes, two decide paths, two expiry sweepers and two permission checks decide the same kind of thing. P3 replaces `FleetApproval` with the engine (design §8), and the engine now has every piece the fleet asks need. What is left:
- switch the producers, closers and readers;
- keep the fleet's public surfaces working over the engine until P3 web replaces the screens;
- delete the old table.

**Rulings that bind this feature** (user):
- 2026-10-26: P3 is six features in order. Feature 4 moves `nax_bash_escalate` to `fleet.job.shell.escalate` and `budget_override_required` to `fleet.budget.override`, and drops `FleetApproval`.
- 2026-10-27: feature 4 is split, and this is the second half. The `/fleet/approvals` routes, their DTO, the fleet webhooks and the fleet live events stay as adapters over the engine until P3 web replaces the screens. The web and the CLI are untouched.
- 2026-10-27: `fleet.approval.decide.bash` and `fleet.approval.decide.budget` stay in the catalog and in the Developer seed until P3 web, as display hints only (the web reads them to show its decide buttons). No API path checks them any more: the engine's eligibility (`approval.decide@<key>` plus the action key) decides.
- 2026-10-27: notifications stay as today. The fleet's `fleet_approval_requested` notification (every global admin, link `/admin/fleet/approvals`) stays. The engine's `ApprovalRequestedSubscriber` skips the two fleet keys until P3 web ships the `/approvals` page its link points at.
- 2026-10-27: one feature, not split into bash and budget features.
- Design decision 2: no data is copied. koda-wk held no pending `FleetApproval` row on 2026-10-27 (6 settled bash rows), so dropping the table loses history only.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Lock order is request first, then job or policy.**
  - The engine's decide and execute lock the `ApprovalRequest` row, then run the command, which locks the job (bash) or the budget policy (budget).
  - Every fleet close path holds the job or policy lock first and closes the request second.
  - So that the two orders cannot deadlock, `ApprovalAskService.close` locks the request with `FOR UPDATE SKIP LOCKED` and answers null when another transaction holds it.
  - A held request is being decided or executed, so it will not stay pending in the normal case, and skipping the close is the right outcome. The skip that matters is the job transition's, the evaluator's, the sweeper's and `BudgetsService.remove`'s: each holds the job or policy lock an executing command waits for.
  - If the holder rolls back (a refused decide), the request stays pending. A bash ask then expires at its deadline, and a decided ask whose job or policy is gone settles through the command's own checks.
- **The fleet keeps one closer class.**
  - `ApprovalCloser` keeps its methods (`openBash`, `closeForJob`, `openBudget`, `closeForPolicy`, `recordResolved`) and the `ApprovalChange { approval, live }` return shape. Its callers (the job report processor, `JobTransitionsService`, `BudgetEvaluator`, `BudgetSweeper`, `BudgetsService`) do not change.
  - The bodies move from `IApprovalRepository` to `ApprovalAskService` and `FleetApprovalAskStore`.
  - The closer keeps `APPROVAL_REPOSITORY` only for `expire`, which `ApprovalExpirySweeper` and the old `ApprovalsService` still call until US-010 and US-012. US-012 deletes `expire` and the injection.
- **`FleetApprovalRecord` becomes a view.**
  - The type keeps its name and fields, and is built by a pure function `toFleetApproval` from the request, its link and its last decision. Its `id` is the request id.
  - `FleetApprovalDto.from`, `approvalActivityPayload` and `approvalWebhookPayload` take it unchanged, so every fleet output keeps its shape.
- **Fleet status mapping, in this order.**
  1. A link `resolvedBy` of `job_ended`, `superseded`, `policy_deleted` or `window_reset` gives `cancelled`; `manual_resume` gives `approved`.
  2. Otherwise the request status decides: `pending` → `pending`, `approved` or `executed` → `approved`, `rejected` → `rejected`, `expired` → `expired`, `cancelled` or `failed` → `cancelled`.
  - `fleetStatusWhere` encodes the same precedence, so a list filter never disagrees with the row it returns.
- **Fleet decision mapping.**
  - A manual resume gives `raise_budget_and_resume`.
  - Otherwise the last decision row decides: a bash approve gives its params' `choice` (`allow` or `allow_for_job`), a bash reject `deny`, a budget approve `raise_budget_and_resume`, a budget reject `keep_paused`.
  - No decision gives null.
- **A bash approve with no params means `allow`.** The generic decide route (`POST /approvals/:id/decisions`) can then allow an ask without knowing the fleet's choice names. A bash reject takes no params.
- **The commands read the request id and the decider from the action context.** `ApprovalExecutionService` (and the decide service for `onReject`) runs a command under a context whose `approval` carries `requestId`, `approverType` and `approverId`. A command has no other way to know which request it runs.
- **An ask is not opened when nax cannot wait for it.**
  - If the job is not `RUNNING`, the job is in `raw` bash mode, or the ask's deadline is at or before `now`, the relay opens no request and no link.
  - It records `runner.sync` with summary `bash ask not opened: <reason>` (`job not running`, `raw mode`, `past deadline`).
  - Today a closed row was written instead.
- **A bash ask the policy resolves to `none` is answered at once.**
  - No request is written (`open` answers `not-needed`).
  - The report processor writes `APPROVAL_ANSWER` with `approvalId: null`, choice `allow` when `checkBashDecision(payload, 'allow')` passes and `deny` otherwise.
  - The closer cannot write it: `FleetJobsModule` imports `ApprovalStoreModule`, so the job repository is out of the closer's reach.
- **The bash deadline keeps today's cap.**
  - `open` is given `deadline = min(ask.deadlineAt, now + job.approvalTimeoutSec seconds)`, so the engine's 24 h default never outlasts nax's own deadline.
  - A policy whose `timeoutSec` is shorter still expires the ask earlier (new: a policy can now shorten a bash ask).
- **A budget ask now expires.**
  - `open` caps a budget ask at the policy timeout (24 h without a policy).
  - After it expires the scope stays paused, and the budgets page's resume still lifts it. Today a budget ask never expired.
  - Its DTO `expiresAt` is now a date instead of null.
- **A budget ask's input carries `requestedAt`.** The re-queue candidates are the jobs cancelled for the policy since the ask opened, so the frozen input records when.
- **The decision params cap limits a raise.** The engine refuses params over 4 096 characters of canonical JSON (fleet-core), so a raise naming more than about 140 re-queue ids is refused (400). Today the route allowed 200. This is accepted; it is listed in Out of Scope.
- **The adapter checks who may decide before what they sent.**
  - Today an unauthorised caller gets 403 whatever it sends. The adapter keeps that by checking the request is pending (409 `fleet.approvalNotPending`), then running `decideEligibility` with the caller's effective keys (403), before any body validation.
  - `ApprovalDecisionService` checks eligibility again under the request lock.
- **The budget command re-checks what the adapter pre-checked.**
  - Before deciding, the `/fleet/approvals` decide route checks that the re-queue ids are candidates (400 `fleet.approvalDecisionInvalid`) and that the amount is above the window spend (400 `fleet.budgetAmountNotAboveSpend`). Its callers therefore keep today's 400s with the ask still pending.
  - At execution the command re-checks under the policy lock. An id that is no longer a candidate is reported in `requeueResults` as `{ ok: false, error: 'not a re-queue candidate' }`. An amount not above spend makes the request `failed`.
- **The budget command closes the policy's other pending ask.** A hard stop that lands while an approve is executing (its close of the executing request is skipped by the lock rule) opens a newer ask. The command closes it with `ApprovalCloser.closeForPolicy(..., resolvedBy: 'superseded', actor: userActor(approverId))`, so its activity row, webhook and live event are written, and queues the live events with `committedEffect`.
- **Re-queues after an approval run under the request's context.** `afterCommit` runs under the request's context, so `FleetJobsService.requeue`'s audit entry names actor `SYSTEM/budget` with the approver in its `approval` block. Today it named the user.
- **Audit.**
  - The engine records `approval.decide` for every decision.
  - The bash command records `fleet.job.shell.escalate` (summary `answered <option>`) when it writes an answer.
  - The budget command records `fleet.budget.override` (summary `raised to <amount> and resumed`).
  - `fleet.approval.decide.bash` and `.budget` are no longer audit keys.
- **One recorder for engine-side changes.**
  - A new outbox subscriber, `FleetAskEventsSubscriber`, records the fleet activity row, the `fleet.approval.resolved` webhook and the `fleet_approval` live event for the four statuses the engine sets: `rejected`, `executed`, `failed`, `expired`.
  - The statuses the fleet sets itself (`pending` at open, `cancelled` at close) are recorded by `ApprovalCloser` in the producer's transaction, as today.
  - `approved` is skipped: `executed` or `failed` follows it.
  - These three outputs now arrive through the outbox relay, after the decide or expiry commits, instead of in the same transaction.
- **The recorder is idempotent per status.** `FleetApprovalAsk` gains `recordedStatus String?`, the last engine status whose events were recorded. A redelivered event with the same status records nothing.
- **The recorder fills `resolvedBy`.** When the link's `resolvedBy` is null it becomes `timeout` for `expired` and `user` for the other three. A command that already set it (`job_ended`) is left alone. `toFleetApproval` derives the same value while the column is still null, so a decide response and a GET right after it already carry `resolvedBy` as today.
- **The recorder runs in the outbox relay's context.** Like `AssistantActionOutcomeSubscriber`, it keeps the relay's `system:outbox` context (allowlisted in `audit-coverage.allowlist.ts`) and never opens `runAsSystemWriter`. Its writes (link columns, activity rows, the webhook's outbox row) are delivery bookkeeping of the change the engine already audited.
- **The engine's notifier skips the fleet keys** (ruled). `ApprovalRequestedSubscriber` returns early when the payload's `permissionKey` is a value of `ASK_KEYS_BY_COMPONENT`.
- **The two fleet ask keys stay pending surfaces.** No route, tool or system writer declares `fleet.job.shell.escalate` or `fleet.budget.override`; they are command keys only. `PENDING_SURFACE_KEYS` is unchanged.
- **The decide routes keep their guard metadata.** The project decide route still declares `fleet.approval.decide.bash` and `.budget` with `enforcedBy: 'service'` (metadata only), and the global decide route still guards `fleet.approval.read`.
- **Agent self-approval keeps its error code.**
  - The engine refuses an agent deciding an ask of a job it requested with `tier-too-low`: the agent contributes `self` to an `agent` default.
  - The adapter maps a `tier-too-low` refusal to 403 `fleet.approvalSelfDecide` when the decider is the ask's `onBehalfOf` agent.
  - Any other refusal becomes 403 `permissions`.
- **Answer delivery is stored on the link.** `APPROVAL_ANSWER`'s `approvalId` is the request id, and the command-ack processor writes `outcome.delivery` on the `FleetApprovalAsk` row.

### Shared names

`apps/api/src/fleet/approvals/domain/approval.domain.ts` keeps `APPROVAL_TYPES`, `APPROVAL_STATUSES`, `APPROVAL_DECISIONS`, `APPROVAL_RESOLVED_BY`, `MAX_REQUEUE_CANDIDATES`, `RequeueCandidate`, `PendingCount`, `ApprovalFilters` and `FleetApprovalRecord` (now the view), and gains:
```ts
/** The engine key of each fleet approval type. */
export const FLEET_ASK_KEY = { nax_bash_escalate: 'fleet.job.shell.escalate', budget_override_required: 'fleet.budget.override' } as const;
export const FLEET_ASK_KEYS: readonly string[] = Object.values(FLEET_ASK_KEY);
/** A link resolution that makes the fleet status `cancelled` whatever the request status. */
export const CANCELLING_RESOLUTIONS: readonly ApprovalResolvedBy[] = ['job_ended', 'superseded', 'policy_deleted', 'window_reset'];
```
US-012 deletes `NewFleetApproval`, `ApprovalResolution`, `APPROVAL_REPOSITORY` and `IApprovalRepository`.

### Engine adjustments (US-001)

`PrismaApprovalRequestRepository` gains:
```ts
/** SELECT ... FOR UPDATE SKIP LOCKED; null when the row is missing or held by another transaction. */
lockByIdSkipLocked(id: string): Promise<ApprovalRequestRecord | null>;
```
`ApprovalAskService.close` calls it instead of `lockById`, and its `requests` pick gains the method. Its doc comment says that null also means "held by an in-flight decide or execute". Nothing else in `close` changes.

`ApprovalRequestedSubscriber.handle` (`apps/api/src/notifications/approvals/approval-requested.subscriber.ts`): after the payload parse and before `queries.findById`, `if (Object.values(ASK_KEYS_BY_COMPONENT).includes(p.permissionKey)) return;`.

### The read model (US-002)

`apps/api/src/fleet/approvals/fleet-approval-view.ts` (new, pure):
```ts
export interface FleetAskRow {
  request: ApprovalRequestRecord;
  link: FleetApprovalAskRecord;
  /** The request's last decision row, or null. */
  decision: ApprovalDecisionRecord | null;
}
export function toFleetApproval(row: FleetAskRow): FleetApprovalRecord;
/** The Prisma where for one fleet status over ApprovalRequest (relation `fleetAsk`). */
export function fleetStatusWhere(status: ApprovalStatus): Prisma.ApprovalRequestWhereInput;
```

`toFleetApproval` fields:

| Field | Source |
|:--|:--|
| `id`, `projectId` | request |
| `type` | `nax_bash_escalate` for `fleet.job.shell.escalate`, `budget_override_required` for `fleet.budget.override` |
| `status`, `decision` | the mappings in Designer's calls |
| `jobId`, `leaseEpoch`, `naxAskId` | link |
| `policyId` | link `budgetPolicyId` |
| `payload` | bash: `input.payload`; budget: `input` without `policyId` and `requestedAt` |
| `outcome`, `updatedAt` | link |
| `resolvedBy` | link `resolvedBy`; when null, `timeout` for an `expired` request and `user` for `rejected`, `executed` or `failed` (so a response never waits for the recorder) |
| `requestedAt`, `createdAt` | request `createdAt` |
| `expiresAt` | request `expiresAt` |
| `decidedById` | manual resume: `link.outcome.resumedById`; else the decision's `deciderId`, or null |
| `decidedAt` | the decision's `decidedAt`, else the request's `settledAt` |
| `comment` | the decision's `comment`, or null |

`fleetStatusWhere` rules:
- Every branch also carries `permissionKey: { in: FLEET_ASK_KEYS }` and `fleetAsk: { isNot: null }` (merged with the branch's own `fleetAsk` filter), so a fleet-key request without a link is never listed or counted.
- `notCancelling` is `{ OR: [{ resolvedBy: null }, { resolvedBy: { notIn: CANCELLING_RESOLUTIONS } }] }`. It spells out the null case because Prisma's `notIn` drops NULLs in SQL.

| Status | Where |
|:--|:--|
| `pending` | `{ status: 'pending' }` |
| `approved` | `OR [ { status: { in: ['approved','executed'] }, fleetAsk: notCancelling }, { fleetAsk: { resolvedBy: 'manual_resume' } } ]` |
| `rejected` | `{ status: 'rejected', fleetAsk: notCancelling }` |
| `expired` | `{ status: 'expired' }` |
| `cancelled` | `OR [ { status: 'cancelled', fleetAsk: { OR: [{ resolvedBy: null }, { resolvedBy: { not: 'manual_resume' } }] } }, { status: 'failed' }, { status: { in: ['approved','executed','rejected'] }, fleetAsk: { resolvedBy: { in: CANCELLING_RESOLUTIONS } } } ]` |

`PrismaFleetApprovalAskRepository` and `FleetApprovalAskStore` gain these methods with the same signatures (each store method delegates):
```ts
findApproval(requestId: string): Promise<FleetApprovalRecord | null>;
/** Fleet-key requests that have a link; newest createdAt first, then id. */
findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>>;
countPending(projectIds: readonly string[]): Promise<PendingCount[]>;
countPendingAllProjects(): Promise<PendingCount[]>;
countPendingUnscoped(): Promise<number>;
countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>>;
findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]>;
findProjectSlug(projectId: string): Promise<string | null>;
```
- `findApproval` and `findPage` read `approvalRequest` with `include: { fleetAsk: true, decisions: { orderBy: { decidedAt: 'desc' }, take: 1 } }` (the relation names in `schema.prisma`) and map rows with `toFleetApproval`. `findPage` goes through `Paginate` with the include, and applies `projectId`, `fleetStatusWhere(status)`, the type's key (`FLEET_ASK_KEY[type]`) and `fleetAsk: { jobId }`.
- `countPending*` count `status: 'pending'` fleet-key requests that have a link. They keep the old repository's slug order, soft-delete rule (`countPendingAllProjects` only) and empty short-circuit.
- `countPendingByJob` groups pending links by `jobId`.
- `findRequeueCandidates` and `findProjectSlug` move unchanged from `PrismaApprovalRepository`.
- Every read is bounded (`.nax/rules/api-data.md`): `findPage` by its page size, the groupings by the id lists they take.

`apps/api/test/helpers/fleet-ask-fixtures.ts` (new) exports `seedFleetAsk(db, spec)`. It writes:
- one `ApprovalRequest` (key from `kind`; actor `SYSTEM/runner` or `SYSTEM/budget`; frozen input and `inputHash` through `freezeApprovalInput` and `approvalInputHash`);
- optional `ApprovalDecision` rows;
- its `FleetApprovalAsk`.

```ts
export interface SeedFleetAskSpec {
  kind: 'bash' | 'budget';
  projectId: string | null;
  input: Record<string, unknown>;            // BashAskInput or BudgetAskInput, frozen as given
  status?: ApprovalRequestStatus;             // default 'pending'
  requiredMode?: ApprovalMode;                // default 'agent' (both fleet keys' catalog default)
  onBehalfOf?: { type: 'USER' | 'AGENT'; id: string } | null;   // default null
  createdAt?: Date;                           // default now
  expiresAt?: Date;                           // default createdAt + 1 h
  settledAt?: Date | null;                    // default null
  result?: unknown;                           // default null
  decisions?: Array<{ deciderType: 'USER' | 'AGENT'; deciderId: string; decision: 'approve' | 'reject'; params?: unknown; comment?: string | null; decidedAt?: Date }>;
  link?: { jobId?: string; leaseEpoch?: number; naxAskId?: string; budgetPolicyId?: string; resolvedBy?: ApprovalResolvedBy | null; outcome?: Record<string, unknown> | null };
}
export function seedFleetAsk(db: PrismaClient, spec: SeedFleetAskSpec): Promise<{ requestId: string }>;
```
The fixture writes the request (`approverMustHoldAction: true`, `requireDistinctApprover: false`, `onTimeout: 'reject'`, `policyId: null`), the decisions and the link, and nothing else: the jobs, budget policies and re-queue candidate jobs an AC needs are created by that AC's own setup. Specs that seeded `FleetApproval` rows reseed through it.

### The bash command (US-003, US-004)

`apps/api/src/fleet/approvals/commands/fleet-shell-escalate.command.ts` (new):
```ts
export interface BashAskInput { jobId: string; leaseEpoch: number; naxAskId: string; payload: Record<string, unknown> }
export interface BashDecision { choice: 'allow' | 'allow_for_job' | 'deny'; option: ApprovalOption }
export type BashResult = { answered: true; choice: BashDecision['choice'] } | { answered: false };

@Injectable()
export class FleetShellEscalateCommand implements ApprovalCommand<BashAskInput, BashResult, BashDecision> {
  readonly key = 'fleet.job.shell.escalate';
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById' | 'createCommand'>,
    private readonly asks: FleetApprovalAskStore,
    private readonly notifier: RunnerNotifier,
    private readonly audit: AuditRecorder,
  ) {}
}
```
- **`parse(input)`:** needs an object with a non-empty string `jobId` and `naxAskId`, an integer `leaseEpoch >= 0` and a plain-object `payload`. Anything else throws. It answers those four fields only.
- **`parseDecision('approve', params, input)`:**
  - `params` undefined means choice `allow`. Otherwise `params` must be an object whose `choice` is `allow` or `allow_for_job` (other keys ignored), or it throws.
  - `checked = checkBashDecision(input.payload, choice)` must be ok; otherwise it throws with `checked.reason`.
  - It answers `{ choice, option: checked.choice }`, `checked.choice` being the nax option (`allow` or `allow-remember`). Its own output parses to itself.
- **`parseDecision('reject', params)`:** `params` must be undefined, or an object whose `choice` is `deny`. It answers `{ choice: 'deny', option: 'deny' }`.
- **`execute(input, decision)` and `onReject(input, decision)`** share one step, `answer(input, decision)`:
  1. `requestId = currentContext()?.approval?.requestId`; when absent, throw `Error('fleet ask needs its request id')`.
  2. `job = jobs.lockById(input.jobId)`. Lock order: the engine holds the request, so the job is second.
  3. (US-004) If the job is missing, not `RUNNING`, on another `leaseEpoch`, or has no `runnerId`: `asks.setResolvedBy(requestId, 'job_ended')` and answer `{ answered: false }`.
  4. Otherwise:
     - `jobs.createCommand({ runnerId, jobId, type: APPROVAL_ANSWER, leaseEpoch, payload: { approvalId: requestId, naxAskId, choice: decision.option } })`;
     - audit `{ key: 'fleet.job.shell.escalate', resourceType: 'fleet-approval', resourceId: requestId, projectId: job.projectId, summary: 'answered <option>' }`;
     - `committedEffect(() => notifier.notify(runnerId))`;
     - answer `{ answered: true, choice: decision.choice }`.
- **`toResult`** is the result itself.
- **Registration:** `ApprovalsModule` registers the command in `onModuleInit` through `ApprovalCommandRegistry`, and imports `ApprovalEngineModule`.
- **Split across two stories:** US-003 builds the command with step 4 for every job. US-004 adds step 3, the live-lease guard.

### The budget command (US-005, US-007)

`apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` (new):
```ts
export interface BudgetAskInput {
  policyId: string; scopeType: string; scopeId: string | null; windowKind: string;
  windowStart: string; spentUsd: string; amountUsd: string; requestedAt: string;   // ISO dates, decimal strings
}
export interface BudgetDecision { amountUsd: number; requeueJobIds: string[] }
export interface BudgetResult { resumedAmountUsd: string; requeue: RequeueCandidate[]; refused: string[] }

@Injectable()
export class FleetBudgetOverrideCommand implements ApprovalCommand<BudgetAskInput, BudgetResult, BudgetDecision> {
  readonly key = 'fleet.budget.override';
  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly policies: Pick<IBudgetRepository, 'lockById'>,
    private readonly budgets: BudgetsService,
    private readonly jobs: FleetJobsService,
    private readonly asks: FleetApprovalAskStore,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    private readonly audit: AuditRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}
}
```
- **`parse(input)`:** each field must be present with its type (`scopeId` a string or null). Anything else throws.
- **`parseDecision('approve', params)`:**
  - `params` must be an object with `amountUsd` a finite number above 0, at most `MAX_BUDGET_USD`, with at most 4 decimal places.
  - It may carry a `requeueJobIds` array of at most `MAX_REQUEUE_CANDIDATES` strings, each 1 to 64 characters.
  - Anything else throws.
  - It answers `{ amountUsd, requeueJobIds }` with the ids de-duplicated in first-seen order (`[]` when absent). Its own output parses to itself.
- **`parseDecision('reject', params)`:** `params` must be undefined. It answers undefined.
- **`execute(input, decision)`:**
  1. Take `requestId` and `approverId` from `currentContext()?.approval`; if either is absent, throw.
  2. `policy = policies.lockById(input.policyId)`, second after the request. When it is missing, throw `ConflictAppException({}, 'fleet.approvalNotPending')`.
  3. `candidates = asks.findRequeueCandidates(policy.id, new Date(input.requestedAt), MAX_REQUEUE_CANDIDATES)`. `requeue` is the decision's ids that are candidates; `refused` is the rest.
  4. `budgets.resume(approverId, budgetRouteOf(policy), policy.id, decision.amountUsd, now, { approvalId: requestId })`. It joins the execution transaction; its errors propagate and settle the request `failed`.
  5. (US-007) `closed = closer.closeForPolicy(policy.id, { status: 'cancelled', resolvedBy: 'superseded', actor: userActor(approverId) }, now)`, then `committedEffect(() => live.publish(closed.live))`. This closes the policy's other pending ask, if any. The executing request is not pending, so it is never the one closed.
  6. `asks.setOutcome(requestId, { resumedAmountUsd, requeueResults: refused.map((jobId) => ({ jobId, ok: false, error: 'not a re-queue candidate' })) })`.
  7. Audit `{ key: 'fleet.budget.override', resourceType: 'fleet-approval', resourceId: requestId, projectId: policy.projectId, summary: 'raised to <resumedAmountUsd> and resumed' }`.
- **`toResult(result)`** answers `{ resumedAmountUsd }`, never the candidate rows.
- **`afterCommit(input, decision, result)`:**
  - For each `requeue` candidate, `jobs.requeue(approverId, c.projectId, c.jobId)` runs in its own transaction (plan D232), recording `{ jobId, ok: true }` or `{ jobId, ok: false, error: errorText(error) }`.
  - Then, in one `txManager.run`, `asks.setOutcome(requestId, { ...current outcome, requeueResults: [...refused results, ...requeue results] })`.
- **Helpers:** `budgetRouteOf` and `errorText` move unchanged from `approvals.service.ts` to `apps/api/src/fleet/approvals/fleet-ask-helpers.ts` (new).
- **Registration:** `ApprovalsModule` registers the command in `onModuleInit`, next to the bash command.
- **Split across two stories:** US-005 builds every step but 5, which US-007 adds once `closeForPolicy` is on the engine.

### `ApprovalCloser` on the engine (US-006, US-007)

`ApprovalCloser` gains `ApprovalAskService` and `FleetApprovalAskStore` beside its existing collaborators, and keeps `APPROVAL_REPOSITORY` for `expire` until US-012. `ApprovalStoreModule` imports `ApprovalEngineModule`. Its private `record`, `dispatch` and `enqueueRequested` take the view and read the project slug through `store.findProjectSlug` (US-006); they are otherwise unchanged. `BashAsk` and `BashJob` keep their shapes (`event-payloads.ts` imports `BashAsk`). `ApprovalChange` gains `answer?: { naxAskId: string; choice: ApprovalOption }`.

**Bash: `openBash(job, ask, runnerId, now)` (US-006).**
1. When `store.findByAsk(job.id, job.leaseEpoch, ask.naxAskId)` answers `{ ask: link }`, answer `{ approval: store.findApproval(link.requestId), live: [] }`.
2. If the job is not `RUNNING`, `job.bashMode === 'raw'`, or `ask.deadlineAt <= now`: audit `runner.sync` on the job (`resourceType: 'fleet-job'`, summary `bash ask not opened: <reason>`) and answer `{ approval: null, live: [] }`.
3. Call `askService.open({ key: 'fleet.job.shell.escalate', projectId: job.projectId, component: 'runner', onBehalfOf: { type: job.requestedByType ?? 'USER', id: job.requestedById }, origin: 'runner', input: { jobId, leaseEpoch, naxAskId, payload: ask.payload }, deadline: min(ask.deadlineAt, now + job.approvalTimeoutSec s) }, now)`.
4. On `not-needed`: audit `runner.sync` with summary `bash ask answered <choice>: no approval needed`, and answer `{ approval: null, live: [], answer: { naxAskId, choice } }`. The choice is `allow` when `checkBashDecision(ask.payload, 'allow')` passes, else `deny`.
   - `JobReportProcessor.applyOne` writes the command through its own `FLEET_JOB_REPOSITORY`, inside the report transaction: `createCommand({ runnerId, jobId, type: APPROVAL_ANSWER, leaseEpoch, payload: { approvalId: null, naxAskId, choice } })`.
   - There is no runner wake: the runner reporting the ask is the one syncing, and it receives the command on its next sync.
5. On `pending`:
   - `store.insert({ requestId, kind: 'bash', projectId, jobId, leaseEpoch, naxAskId })`;
   - `view = store.findApproval(requestId)`;
   - as today: activity `approval.requested` (actor `runnerActor`), audit `runner.sync` `bash ask opened, pending`, webhook `fleet.approval.requested`, outbox `fleet_approval_requested`;
   - answer `{ approval: view, live: livePublisher.event(view) }`.

**Bash: `closeForJob(job, now)` (US-006).** For each `store.findPendingForJob(job.id)`:
1. `askService.close(link.requestId, { status: 'cancelled', reason: 'job_ended' }, now)`. If it answers null, go to the next link.
2. `store.setResolvedBy(link.requestId, 'job_ended')`.
3. `view = await store.findApproval(link.requestId)`; append `recordResolved(view, jobSystemActor(job))` to the result.

`closeForJob` answers the `LiveFleetApprovalEvent[]` accumulated over every closed link (`JobTransitionsService.leaveRunning` returns it), `[]` when none closed.

**Budget: `openBudget(policy, at, now)` (US-007).**
1. `closeForPolicy(policy.id, { status: 'cancelled', resolvedBy: 'superseded', actor: systemActor(policy) }, now)`. This closes the stray ask, as today.
2. Call `askService.open({ key: 'fleet.budget.override', projectId: policy.projectId, component: 'budget', onBehalfOf: null, origin: 'system', input: { policyId, scopeType, scopeId, windowKind, windowStart: at.windowStart.toISOString(), spentUsd: at.spentUsd, amountUsd: policy.amountUsd, requestedAt: now.toISOString() }, deadline: null }, now)`.
   - `not-needed` throws `Error('budget override resolved to none')`. The floor `self` makes it unreachable.
3. `store.insert({ requestId, kind: 'budget', projectId: policy.projectId, budgetPolicyId: policy.id })`; then, as today, activity `approval.requested` (`systemActor`), webhook, outbox and live event.

**Budget: `closeForPolicy(policyId, close, now)` (US-007).**
1. `link = store.findPendingForPolicy(policyId)`. With no link, answer `{ approval: null, live: [] }`.
2. `askService.close(link.requestId, { status: 'cancelled', reason: close.resolvedBy }, now)`. If it answers null, answer `{ approval: null, live: [] }`.
3. Otherwise `store.setResolvedBy(link.requestId, close.resolvedBy)`.
4. When `close.outcome` is given, `store.setOutcome(link.requestId, { ...close.outcome, ...(close.status === 'approved' ? { resumedById: close.actor.id } : {}) })`.
5. `view = await store.findApproval(link.requestId)`; answer `{ approval: view, live: await recordResolved(view, close.actor) }`. Callers read `approval?.id` for the incident's `approvalId` (`BudgetSweeper.resetWindow`, `BudgetsService.resume`), and it is null whenever the close was skipped.

The engine status is always `cancelled`; a manual resume shows as `approved` through the mapping. `PolicyClose` keeps its shape.

### Delivery outcome (US-008)

`CommandAckProcessor` injects `FleetApprovalAskStore` instead of `APPROVAL_REPOSITORY`.
- On an `APPROVAL_ANSWER` ack whose payload's `approvalId` is a string, it calls `link = store.lockByRequest(approvalId)`. The job is locked above, so the order is job, then link.
- When a link is found, it calls `store.setOutcome(approvalId, { ...(link.outcome ?? {}), delivery: { result, detail, at } })` as bookkeeping `runner.command-ack`, exactly as today.
- A null or unknown `approvalId` writes nothing.

### Engine-side events (US-009)

`apps/api/src/fleet/approvals/fleet-ask-events.subscriber.ts` (new):
- Provided by `ApprovalsModule`, which imports `OutboxCoreModule` for `FanOutPublisher`.
- Registers on `APPROVAL_REQUEST_CHANGED` in `onModuleInit`.
- Keeps the relay's context. It has no `@SystemWriter` and never calls `runAsSystemWriter`.

`handle(payload)`:
1. Parse with `parseApprovalRequestChangedPayload`. When it answers null, warn `approval_request_changed: malformed payload skipped` and return.
2. Return unless `permissionKey` is in `FLEET_ASK_KEYS` and `status` is `rejected`, `executed`, `failed` or `expired`.
3. In `txManager.run`:
   - `link = store.lockByRequest(requestId)`. If there is no link, or `link.recordedStatus === status`, return null.
   - When `link.resolvedBy` is null, `setResolvedBy(requestId, status === 'expired' ? 'timeout' : 'user')`.
   - `store.setRecordedStatus(requestId, status)`, a new store and repository method.
   - `view = store.findApproval(requestId)`.
   - `live = closer.recordResolved(view, actor)`. This writes the activity row and the webhook. `actor` is:
     - expired: `{ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId }`. `responsibleUserId` is the `onBehalfOf` id when it is a USER (bash), or the policy's `updatedById` (budget, `BUDGET_REPOSITORY.findById`; null when the policy is gone).
     - otherwise: `userActor(decision.deciderId)`, as today's decide wrote for users and agents alike (`FleetActivityService` resolves an agent id to actor type `AGENT`).
   - Answer `live`.
4. After the transaction, publish `live` through `ApprovalLivePublisher.publish`.

Database errors propagate, so the outbox relay retries.

Schema: `FleetApprovalAsk` gains `recordedStatus String?`; a migration adds the column.

### Decide adapter (US-010)

`ApprovalsService.decide(caller, route, id, dto, now)` runs these steps in order:
1. `view = store.findApproval(id)`. When it is missing or not visible on the route, 404 `fleet.approvals`.
2. When `view.status !== 'pending'`, 409 `fleet.approvalNotPending`.
3. Eligibility before validation. `request = ApprovalRequestQueries.findById(id)` and `keys = permissions.effectiveKeys(caller.principal, scope)`.
   - When `decideEligibility(request, caller.principal, keys)` refuses, answer 403 `fleet.approvalSelfDecide` if the reason is `tier-too-low` and the caller is the request's `onBehalfOf` agent; otherwise 403 `permissions`.
4. Bash:
   - When `amountUsd` or `requeueJobIds` is present, 400 `fleet.approvalInput`.
   - When `checkBashDecision(view.payload, dto.decision)` is not ok, 400 `fleet.approvalDecisionInvalid`.
   - Then `allow` or `allow_for_job` becomes engine `approve` with `params { choice }`, and `deny` becomes `reject`.
5. Budget:
   - A decision other than `keep_paused` or `raise_budget_and_resume` is 400 `fleet.approvalDecisionInvalid`.
   - For a raise: a missing `amountUsd` is 400 `fleet.approvalDecisionInvalid`, and so is an id not in `findRequeueCandidates(policyId, requestedAt, MAX_REQUEUE_CANDIDATES)`. `BudgetsService.assertResumable(policyId, amountUsd, now)` throws its own 409 `fleet.budgetNotPaused` or 400 `fleet.budgetAmountNotAboveSpend`.
   - Then a raise becomes `approve` with `params { amountUsd, requeueJobIds }`, and `keep_paused` becomes `reject`.
6. `decisions.decide(id, engineDecision, dto.comment ?? null, now, params)`. Errors map as follows:

   | Engine error | Adapter answer |
   |:--|:--|
   | `ApprovalRequestNotPendingError`, `ApprovalRequestExpiredError` | 409 `fleet.approvalNotPending` |
   | `ApprovalDecideForbiddenError` | Mapped as in step 3 |
   | `ApprovalDecisionParamsInvalidError` | 400 `fleet.approvalDecisionInvalid` |

7. When the reloaded view of a bash ask has `resolvedBy` `job_ended` (approve answered nothing, or reject found the job ended), 409 `fleet.approvalNotPending`. This keeps today's decide on an ended job. Otherwise answer `FleetApprovalDto.from(view)`.

The constructor gains `FleetApprovalAskStore`, `ApprovalDecisionService` and `ApprovalRequestQueries`, keeps `PermissionService` and `BudgetsService`, and drops `BUDGET_REPOSITORY`, `FleetJobsService`, `ApprovalCloser`, `ApprovalLivePublisher`, `TRANSACTION_MANAGER`, `FLEET_JOB_REPOSITORY`, `RunnerNotifier` and `AuditRecorder`. `APPROVAL_REPOSITORY` stays for `list`, `get` and `counts` until US-011.

`BudgetsService.assertResumable(policyId, amountUsd, now)` is new and read-only:
- `repo.findById`; when missing, 404 `fleet.budgets`;
- when not paused, 409 `fleet.budgetNotPaused`;
- when `isAboveSpend(String(amountUsd), windowSpend(...))` is false, 400 `fleet.budgetAmountNotAboveSpend`.

`resume` keeps its own checks.

### Readers (US-011)

- **`ApprovalsService.list`, `get`, `counts`:** the store's `findPage`, `findApproval` (with `findRequeueCandidates` for a pending budget ask) and `countPending*`, with today's route visibility and DTO mapping. `APPROVAL_REPOSITORY` leaves the constructor.
- **`FleetJobsService`:** its `APPROVAL_REPOSITORY` parameter becomes `FleetApprovalAskStore` (`countPendingByJob`), in the same position.
- **`PrismaDashboardRepository.pendingSummaryByJob`:** `fleetApprovalAsk.groupBy({ by: ['jobId'], where: { jobId: { in }, request: { status: 'pending' } }, _count, _min: { createdAt } })`. `oldestRequestedAt` is the link's `_min.createdAt`, which is written in the same transaction as the request.
- **`PrismaHomeRepository.findPendingApprovals` and `countPendingApprovals`:**
  - read `approvalRequest` where `permissionKey in FLEET_ASK_KEYS`, `status: 'pending'` and today's project scope, with the link;
  - `HomeApprovalRow` keeps `{ id, type, projectId, jobId, requestedAt, expiresAt }`: `type` comes from the key, `jobId` from the link, and `requestedAt` is `createdAt`.
- **`PrismaAssistantToolCallRepository` project counts:** `approvalRequest.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: 'pending', permissionKey: { in: FLEET_ASK_KEYS } } })`.
- **`FleetNotificationReader.approvalContext(approvalId)`:** `approvalRequest.findUnique` for the status, and its link's `jobId`. `ctx.status` is the request status; only `pending` is acted on.

### Cleanup (US-012)

US-012 deletes:
- the `FleetApproval` model and table (migration `DROP TABLE "FleetApproval"`), and its partial index in `test/helpers/partial-indexes.ts`;
- `PrismaApprovalRepository`, `APPROVAL_REPOSITORY`, `IApprovalRepository`, `NewFleetApproval` and `ApprovalResolution`;
- `ApprovalExpirySweeper` and `ApprovalCloser.expire`, with the closer's `APPROVAL_REPOSITORY` injection;
- the repository, schema and sweeper specs.

`ApprovalStoreModule` and `ApprovalsModule` drop them. The `BudgetIncident.approvalId` comment becomes "ApprovalRequest id (P3d); no FK".

Verification for the removals:
- `bun run type-check` and `bun run lint` (repo root) pass;
- `prisma migrate diff` from the migrations to the schema is empty.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `close` on a request another transaction holds | Answers null at once; nothing written | US-001 |
| Bash `parse` input malformed | Throws | US-003 |
| Bash approve choice not offered, or command truncated | `parseDecision` throws; 400 `approvals.invalidDecisionParams` on the engine route | US-003 |
| Bash reject with an allow choice | `parseDecision` throws | US-003 |
| Bash answer for a job that ended or moved lease (approve or reject) | No command; link `job_ended`; approve result `{ answered: false }` | US-004 |
| Budget approve params invalid | `parseDecision` throws; 400 | US-005 |
| Budget policy gone at execution | Request `failed` | US-005 |
| Budget amount not above spend at execution | Request `failed`; policy stays paused | US-005 |
| A re-queue id no longer a candidate at execution | Reported `{ ok: false, error: 'not a re-queue candidate' }`; nothing re-queued for it | US-005 |
| One re-queue throws | That entry `{ ok: false, error: errorText }`; the rest continue | US-005 |
| Bash ask for a non-running, raw or past-deadline job | No request; `runner.sync` audit with the reason | US-006 |
| Bash ask the policy resolves to `none` | No request; `APPROVAL_ANSWER` allow or deny | US-006 |
| Re-reported bash ask | Same request; nothing new written | US-006 |
| Job-end close of a request held by another transaction | Skipped; the job transition completes | US-006 |
| Policy close of a request held by another transaction | Skipped; the policy transaction completes | US-007 |
| Ack for a null or unknown `approvalId` | Nothing written | US-008 |
| Malformed `approval_request_changed` payload | Warn; nothing written | US-009 |
| Event for a non-fleet key, a non-engine status or a request with no link | Nothing written | US-009 |
| Redelivered event with the same status | Nothing written | US-009 |
| Adapter: request not pending | 409 `fleet.approvalNotPending` | US-010 |
| Adapter: caller may not decide | 403 `permissions`, whatever the body | US-010 |
| Adapter: agent deciding its own job's ask | 403 `fleet.approvalSelfDecide` | US-010 |
| Adapter: bash decide with budget fields | 400 `fleet.approvalInput` | US-010 |
| Adapter: bash choice refused by `checkBashDecision` | 400 `fleet.approvalDecisionInvalid` | US-010 |
| Adapter: budget raise without an amount, or with a non-candidate id | 400 `fleet.approvalDecisionInvalid`; request pending | US-010 |
| Adapter: budget raise on an unpaused policy | 409 `fleet.budgetNotPaused`; request pending | US-010 |
| Adapter: budget raise amount not above spend | 400 `fleet.budgetAmountNotAboveSpend`; request pending | US-010 |
| Adapter: bash decide on an ended job | 409 `fleet.approvalNotPending` | US-010 |

### Integration

**Read-only, verified:**
- `apps/api/src/approvals/approval-ask.service.ts`: `ApprovalAskService.open` and `close`, `ASK_KEYS_BY_COMPONENT`.
- `ApprovalDecisionService.decide(requestId, decision, comment, now?, params?)`.
- `ApprovalExecutionService`: runs `execute` under the request's context, then `afterCommit`.
- `decideEligibility(request, decider, keys)`.
- `ApprovalRequestQueries.findById`.
- `ApprovalRequestExpirySweeper`.
- `ApprovalRequestEvents` and `parseApprovalRequestChangedPayload`.
- `FleetApprovalAskStore`: `insert`, `findByRequest`, `findByAsk` (answers `{ ask, status }`), `lockByRequest`, `findPendingForJob`, `findPendingForPolicy`, `setResolvedBy`, `setOutcome`.
- `checkBashDecision` (answers `{ ok, choice, status }` or `{ ok: false, reason }`).
- `committedEffect`.
- `RunnerNotifier.notify(runnerId)`.
- `IFleetJobRepository.createCommand`.
- `BudgetsService.resume(actorId, route, id, amountUsd, now, { approvalId })`, which closes nothing when given `approvalId`.
- `FleetJobsService.requeue(actorId, projectId, jobId)`.
- `JobTransitionsService.leaveRunning`: withdraws pending `APPROVAL_ANSWER` commands, then calls `closeForJob`.
- `OutboxCoreModule`, which exports `FanOutPublisher`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `ApprovalAskService.close` | locks with `lockById` | locks with `lockByIdSkipLocked` |
| `ApprovalCloser` | writes `FleetApproval` through `IApprovalRepository` | the engine and the link, with the same method names and `ApprovalChange` shape (`expire` stays until US-012) |
| `ApprovalsService` | decides against `FleetApproval` with `permissions.can` per type | the adapter above |
| `FleetApprovalRecord` | the row type | the view built by `toFleetApproval` |

## Out of Scope

- Removing `fleet.approval.decide.bash`, `fleet.approval.decide.budget` and `fleet.approval.decide.assistant` from the catalog and the Developer seed: P3 web, with the pages that read them (ruled 2026-10-27).
- Any change to `apps/web` or `apps/cli`.
- The engine's `ApprovalRequestedSubscriber` notifying deciders of fleet asks: P3 web, with the `/approvals` page.
- Removing the `fleet_approval_requested` outbox type, `FleetApprovalRequestedSubscriber` and the `/fleet/approvals` routes: P3 web.
- Copying `FleetApproval` history into the engine (design decision 2).
- A budget ask that never expires. It now expires after the policy timeout (designer call).
- A raise whose params exceed the engine's 4 096-character cap (about 140 re-queue ids). It is refused with 400, whatever the route allowed before.
- A unique index enforcing one pending budget ask per policy. The evaluator holds the policy lock when it opens one, and the old partial index goes with the table.
- Removing the `approvalLive` return fields and `ApprovalLivePublisher`. They stay for the fleet-side open and close events.
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` for the deleted sweeper and decide paths.
- Re-checking the asker's key at execution (fleet-core designer call).
- An index for listing fleet-key requests without a project or status filter (admin `GET /fleet/approvals`); the read is page-bounded and uses the existing `(projectId, status, createdAt)` index whenever a filter is given.
- US-005 only: pinning the re-queue audit actor (`SYSTEM/budget` with the approver in its approval block) and US-006 only: pinning a policy `timeoutSec` shorter than `approvalTimeoutSec`; both follow from the engine and are described in Designer's calls.
- Mapping refusals other than an agent's own-job `tier-too-low` to `fleet.approvalSelfDecide`. A missing action key or a `requireDistinctApprover` policy answers `permissions`.
- US-003 only: pinning the missing-request-id throw. It guards a command run outside the engine, which no production path does.
- US-006 only: answering nax for an ask that was not opened (job not running, raw mode, past deadline). nax denies at its own deadline, as today.
- US-007 only: pinning `openBudget`'s throw on a `none` resolution. The floor `self` of `fleet.budget.override` makes it unreachable.
- US-010 only: pinning `assertResumable`'s 404. It is reachable only when the delete's close of the ask was skipped (its request was held by a decide that then rolled back), leaving a pending ask on a deleted policy until it expires.

## Stories

1. **US-001: Engine adjustments for fleet asks** — `Workdir: apps/api` — No dependencies. `lockByIdSkipLocked` and its use in `ApprovalAskService.close`; `ApprovalRequestedSubscriber` skips the two fleet keys.
2. **US-002: The fleet ask read model** — `Workdir: apps/api` — No dependencies. `FLEET_ASK_KEY`, `FLEET_ASK_KEYS`, `CANCELLING_RESOLUTIONS`, `toFleetApproval`, `fleetStatusWhere`, the store's eight read methods, and the `seedFleetAsk` test fixture.
3. **US-003: The bash command** — `Workdir: apps/api` — Depends on US-002. `FleetShellEscalateCommand` (parse, decision params, the answer for a live job, the reject answer) and its registration in `ApprovalsModule`.
4. **US-004: Bash answers reach only the ask's live lease** — `Workdir: apps/api` — Depends on US-003. The job-ended guard of the answer step, for approve and reject.
5. **US-005: The budget command** — `Workdir: apps/api` — Depends on US-002. `FleetBudgetOverrideCommand` without the supersede step, `fleet-ask-helpers.ts`, and its registration.
6. **US-006: Bash asks open and close on the engine** — `Workdir: apps/api` — Depends on US-001, US-002, US-003. `ApprovalCloser.openBash` and `closeForJob` on `ApprovalAskService` and the link; the report processor writes a `not-needed` answer.
7. **US-007: Budget asks open and close on the engine** — `Workdir: apps/api` — Depends on US-001, US-002, US-005. `ApprovalCloser.openBudget` and `closeForPolicy` on the engine and the link; the budget command's supersede step.
8. **US-008: Answer delivery on the link** — `Workdir: apps/api` — Depends on US-003, US-006. `CommandAckProcessor` writes `outcome.delivery` through the store.
9. **US-009: Fleet events for engine-side changes** — `Workdir: apps/api` — Depends on US-002, US-006. `FleetAskEventsSubscriber`, `FleetApprovalAsk.recordedStatus`, `setRecordedStatus`.
10. **US-010: The /fleet/approvals decide adapter** — `Workdir: apps/api` — Depends on US-002, US-004, US-006, US-007. `ApprovalsService.decide` over the engine; `BudgetsService.assertResumable`.
11. **US-011: Readers on the engine** — `Workdir: apps/api` — Depends on US-002, US-006, US-007, US-010. `ApprovalsService.list`, `get`, `counts`; job counts, dashboard, home, assistant project counts and the fleet notification reader.
12. **US-012: Drop FleetApproval** — `Workdir: apps/api` — Depends on US-008, US-009, US-010, US-011. Deletion only.

These 12 stories are one capability (ruled 2026-10-27), so expect a draft PR with a branch residual more often than for a smaller feature. Between US-006/US-007 and US-010/US-011, integration specs that open asks through the relay or the evaluator and then read `FleetApproval` are red. Each is authorised in the story that turns it green.

### Context Files

**US-001**
- `apps/api/src/approvals/approval-ask.service.ts` — `close`
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `lockById`
- `apps/api/src/notifications/approvals/approval-requested.subscriber.ts`
- `apps/api/test/integration/approvals/approval-ask.integration.spec.ts` — the ask fixtures

**US-002**
- `apps/api/src/fleet/approvals/prisma-approval.repository.ts` — the queries to mirror
- `apps/api/src/fleet/approvals/prisma-fleet-approval-ask.repository.ts`
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.ts`
- `apps/api/src/fleet/approvals/domain/approval.domain.ts`
- `apps/api/src/approvals/approval-input.ts` — `freezeApprovalInput`, `approvalInputHash`

**US-003**
- `apps/api/src/fleet/approvals/approvals.service.ts` — `decideBash`, the behaviour to reproduce
- `apps/api/src/fleet/approvals/bash-decision.ts`
- `apps/api/src/approvals/approval-command.registry.ts`
- `apps/api/src/fleet/assistant/tools/ticket-write-tools.ts` — a module registering a command in `onModuleInit`
- `apps/api/src/common/committed-effects.ts`

**US-004**
- `apps/api/src/fleet/approvals/commands/fleet-shell-escalate.command.ts` — created by US-003, extended here

**US-005**
- `apps/api/src/fleet/approvals/approvals.service.ts` — the budget branch of `decide`, the behaviour to reproduce
- `apps/api/src/fleet/budgets/budgets.service.ts` — `resume`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `requeue`
- `apps/api/src/approvals/approval-execution.service.ts` — `afterCommit` timing

**US-006**
- `apps/api/src/fleet/approvals/approval-closer.ts`
- `apps/api/src/fleet/sync/job-report.processor.ts` — `applyOne`
- `apps/api/src/fleet/jobs/job-transitions.service.ts` — `leaveRunning`
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts` — the relay flow

**US-007**
- `apps/api/src/fleet/approvals/approval-closer.ts`
- `apps/api/src/fleet/budgets/budget-evaluator.ts` — `hardStop`
- `apps/api/src/fleet/budgets/budget-sweeper.ts` — `deleteOrphan`, `resetWindow`
- `apps/api/src/fleet/budgets/budgets.service.ts` — `remove`, `resume`

**US-008**
- `apps/api/src/fleet/sync/command-ack.processor.ts`

**US-009**
- `apps/api/src/fleet/assistant/requests/assistant-action-outcome.subscriber.ts` — the subscriber pattern
- `apps/api/src/fleet/assistant/assistant.module.ts` — the `OutboxCoreModule` import
- `apps/api/src/approvals/approval-request-events.ts`
- `apps/api/src/fleet/approvals/approval-closer.ts` — `recordResolved`

**US-010**
- `apps/api/src/fleet/approvals/approvals.service.ts`
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts`
- `apps/api/src/approvals/approval-decision.service.ts`
- `apps/api/src/approvals/approval-eligibility.ts` — `decideEligibility` and its refusal reasons

**US-011**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts`
- `apps/api/src/home/prisma-home.repository.ts`
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts`
- `apps/api/src/notifications/fleet/fleet-notification.reader.ts`

**US-012**
- `apps/api/prisma/schema.prisma` — `FleetApproval`, `BudgetIncident.approvalId`
- `apps/api/src/fleet/approvals/approval-store.module.ts`, `apps/api/src/fleet/approvals/approvals.module.ts`

### Creates

- `apps/api/test/integration/approvals/approval-ask-skip-locked.integration.spec.ts` — US-001
- `apps/api/src/fleet/approvals/fleet-approval-view.ts` — US-002
- `apps/api/src/fleet/approvals/fleet-approval-view.spec.ts` — US-002
- `apps/api/test/helpers/fleet-ask-fixtures.ts` — US-002
- `apps/api/test/integration/fleet/fleet-ask-read-model.integration.spec.ts` — US-002
- `apps/api/src/fleet/approvals/commands/fleet-shell-escalate.command.ts` — US-003
- `apps/api/src/fleet/approvals/commands/fleet-shell-escalate.command.spec.ts` — US-003
- `apps/api/test/integration/fleet/fleet-shell-escalate-command.integration.spec.ts` — US-003
- `apps/api/src/fleet/approvals/fleet-ask-helpers.ts` — US-005
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.ts` — US-005
- `apps/api/src/fleet/approvals/commands/fleet-budget-override.command.spec.ts` — US-005
- `apps/api/test/integration/fleet/fleet-budget-override-command.integration.spec.ts` — US-005
- `apps/api/src/fleet/approvals/fleet-ask-events.subscriber.ts` — US-009
- `apps/api/src/fleet/approvals/fleet-ask-events.subscriber.spec.ts` — US-009
- `apps/api/prisma/migrations/20261107090000_fleet_approval_ask_recorded_status/migration.sql` — US-009
- `apps/api/prisma/migrations/20261107090100_drop_fleet_approval/migration.sql` — US-012

### Modifies

**US-001**
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — gains `lockByIdSkipLocked`
- `apps/api/src/approvals/approval-ask.service.ts` — `close` locks with `lockByIdSkipLocked`; the `requests` pick gains it
- `apps/api/src/approvals/approval-ask.service.spec.ts` — the `close` cases stub `lockByIdSkipLocked` instead of `lockById`; the assertions on the settled request are unchanged
- `apps/api/src/notifications/approvals/approval-requested.subscriber.ts` — returns early for the two fleet keys
- `apps/api/src/notifications/approvals/approval-requested.subscriber.spec.ts` — gains the two fleet-key cases

**US-002**
- `apps/api/src/fleet/approvals/domain/approval.domain.ts` — `FLEET_ASK_KEY`, `FLEET_ASK_KEYS`, `CANCELLING_RESOLUTIONS`; `FleetApprovalRecord` documented as the view
- `apps/api/src/fleet/approvals/prisma-fleet-approval-ask.repository.ts` — the eight read methods
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.ts` — the eight read methods, delegating
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.spec.ts` — the delegation cases for the new methods

**US-003**
- `apps/api/src/fleet/approvals/approvals.module.ts` — imports `ApprovalEngineModule`, provides `FleetShellEscalateCommand`, registers it in `onModuleInit`
- `apps/api/src/fleet/approvals/approvals.module.spec.ts` — the compiled module's registry holds `fleet.job.shell.escalate`

**US-005**
- `apps/api/src/fleet/approvals/approvals.module.ts` — provides and registers `FleetBudgetOverrideCommand`
- `apps/api/src/fleet/approvals/approvals.module.spec.ts` — the compiled module's registry holds `fleet.budget.override`
- `apps/api/src/fleet/approvals/approvals.service.ts` — imports `budgetRouteOf` and `errorText` from the new helpers module instead of defining them

**US-006**
- `apps/api/src/fleet/approvals/approval-closer.ts` — `openBash` and `closeForJob` on the engine and the link; `ApprovalChange.answer`
- `apps/api/src/fleet/approvals/approval-store.module.ts` — imports `ApprovalEngineModule` for `ApprovalAskService`
- `apps/api/src/fleet/approvals/approval-store.module.spec.ts` — the compiled module provides the closer with `ApprovalAskService` resolved
- `apps/api/src/fleet/sync/job-report.processor.ts` — writes the `APPROVAL_ANSWER` command of a `not-needed` ask from `ApprovalChange.answer`
- `apps/api/src/fleet/sync/job-report.processor.spec.ts` — the `openBash` double answers an `ApprovalChange` whose `approval` is the view, and a case with `answer`
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — the bash cases assert the engine request, the link and the not-opened and not-needed paths instead of `FleetApproval` rows
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts` — asserts the engine request and link where it read `FleetApproval`; the deny-at-expiry case runs `ApprovalRequestExpirySweeper.tick` instead of `ApprovalExpirySweeper`
- `apps/api/test/integration/audit/audit-fleet-system-approvals.integration.spec.ts` — its `openAsk` helper reads the engine request and link instead of `fleetApproval`; the job-end case asserts `closedBy: 'job_ended'`; the expiry cases run `ApprovalRequestExpirySweeper.tick`

**US-007**
- `apps/api/src/fleet/approvals/approval-closer.ts` — `openBudget` and `closeForPolicy` on the engine and the link
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — the budget cases assert the engine request and link
- `apps/api/test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts` — reads and seeds budget asks as engine requests and links (`seedFleetAsk`) instead of `FleetApproval`
- `apps/api/test/integration/audit/audit-fleet-budgets.integration.spec.ts` — finds the budget ask as an engine request instead of `fleetApproval.findFirstOrThrow`
- `apps/api/test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts` — closes and resets budget asks through the engine request instead of `fleetApproval.updateMany`

**US-008**
- `apps/api/src/fleet/sync/command-ack.processor.ts` — `FleetApprovalAskStore` instead of `APPROVAL_REPOSITORY`
- `apps/api/src/fleet/sync/command-ack.processor.spec.ts` — the approval double becomes a store double with `lockByRequest` and `setOutcome`

**US-009**
- `apps/api/prisma/schema.prisma` — `FleetApprovalAsk.recordedStatus String?`
- `apps/api/src/fleet/approvals/domain/fleet-approval-ask.domain.ts` — `recordedStatus` on the record; `setRecordedStatus` on the interface
- `apps/api/src/fleet/approvals/prisma-fleet-approval-ask.repository.ts` — `setRecordedStatus`
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.ts` — `setRecordedStatus`
- `apps/api/src/fleet/approvals/approvals.module.ts` — imports `OutboxCoreModule`; provides `FleetAskEventsSubscriber`
- `apps/api/src/fleet/approvals/approvals.module.spec.ts` — the compiled module resolves `FleetAskEventsSubscriber`

**US-010**
- `apps/api/src/fleet/approvals/approvals.service.ts` — `decide` as the adapter; the constructor changes listed in Design
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — the decide cases are rewritten against store, queries, permission and decision-service doubles; each case keeps its fleet input and expected fleet error or DTO, and asserts the engine call instead of `FleetApproval` writes
- `apps/api/src/fleet/budgets/budgets.service.ts` — `assertResumable`
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — its `stopped` helper and the decide cases read the engine request (and seed with `seedFleetAsk`) instead of `fleetApproval`; the list, get and counts cases are left for US-011; the route contracts asserted are unchanged
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts` — the decide cases seed asks with `seedFleetAsk`; the list and counts cases are left for US-011; the 403/200 matrix is unchanged
- `apps/api/test/integration/audit/audit-fleet-approvals.integration.spec.ts` — `startPendingBudget` reads the engine request; a decide records `approval.decide` plus `fleet.job.shell.escalate` or `fleet.budget.override`, not `fleet.approval.decide.bash`/`.budget`

**US-011**
- `apps/api/src/fleet/approvals/approvals.service.ts` — `list`, `get`, `counts` over the store; `APPROVAL_REPOSITORY` leaves the constructor
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — the list, get and counts cases use the store double
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `FleetApprovalAskStore` in place of `APPROVAL_REPOSITORY`
- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts` — `pendingSummaryByJob` over the link
- `apps/api/src/home/prisma-home.repository.ts` — the pending approvals over the engine
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — project pending counts over the engine
- `apps/api/src/notifications/fleet/fleet-notification.reader.ts` — `approvalContext` over the engine
- `apps/api/test/integration/home/home-api.integration.spec.ts` — seeds asks with `seedFleetAsk`
- `apps/api/test/integration/fleet/fleet-dashboard-api.integration.spec.ts` — seeds asks with `seedFleetAsk`
- `apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts` — seeds asks with `seedFleetAsk`
- `apps/api/test/integration/fleet/assistant-workspace-tools.integration.spec.ts` — seeds the counted asks with `seedFleetAsk`
- `apps/api/test/integration/fleet/assistant-fleet-tools.integration.spec.ts` — seeds the rows the list tool reads with `seedFleetAsk`
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — the list, get and counts cases seed with `seedFleetAsk` and read the engine instead of `fleetApproval`
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts` — the list and approval-counts cases seed asks with `seedFleetAsk`; the 403/200 matrix is unchanged
- `apps/api/test/integration/permissions/membership-fleet-consumers.integration.spec.ts` — `approvalRow` seeds with `seedFleetAsk` and the cleanup clears engine requests instead of `fleetApproval.deleteMany`

**US-012**
- `apps/api/prisma/schema.prisma` — drops `FleetApproval`; the `BudgetIncident.approvalId` comment
- `apps/api/test/helpers/partial-indexes.ts` — drops `FleetApproval_pending_policy_key`
- `apps/api/src/fleet/approvals/domain/approval.domain.ts` — drops `NewFleetApproval`, `ApprovalResolution`, `APPROVAL_REPOSITORY`, `IApprovalRepository`
- `apps/api/src/fleet/approvals/prisma-approval.repository.ts` — deleted
- `apps/api/src/fleet/approvals/approval-expiry-sweeper.ts` — deleted
- `apps/api/src/fleet/approvals/approval-expiry-sweeper.spec.ts` — deleted with the sweeper
- `apps/api/src/fleet/approvals/approval-closer.ts` — `expire` and the `APPROVAL_REPOSITORY` injection deleted
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — drops the `expire` cases and the repository double
- `apps/api/src/fleet/approvals/approval-store.module.ts` — drops the old repository and its exports
- `apps/api/src/fleet/approvals/approval-store.module.spec.ts` — no longer resolves `APPROVAL_REPOSITORY` or `PrismaApprovalRepository`
- `apps/api/src/fleet/approvals/approvals.module.ts` — drops `ApprovalExpirySweeper`
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer map loses `ApprovalExpirySweeper` and AC-4's `toHaveLength(36)` becomes 35
- `apps/api/test/integration/fleet/fleet-approval-repository.integration.spec.ts` — deleted with the repository
- `apps/api/test/integration/fleet/fleet-approvals-schema.integration.spec.ts` — deleted with the table
- `apps/api/test/integration/audit/audit-fleet-system-budgets.integration.spec.ts` — clears engine requests instead of `fleetApproval.deleteMany`
- `apps/api/test/integration/fleet/assistant-thread-gate.integration.spec.ts` — drops the `fleetApproval.count` assertion on a table that no longer exists

Files a story extends after an earlier story of this feature created them are not listed here (`nax spec lint` refuses a Modifies path that does not exist at plan time): US-004 extends `fleet-shell-escalate.command.ts`, `fleet-shell-escalate.command.spec.ts` and `fleet-shell-escalate-command.integration.spec.ts` (created by US-003) with the live-lease guard and its cases; US-007 extends `fleet-budget-override.command.ts` and `fleet-budget-override-command.integration.spec.ts` (created by US-005) with the supersede step and its case. `apps/api/test/integration/fleet/assistant-action-actor.integration.spec.ts` needs no change: its raw `FleetApproval` statements run on a scratch schema built from the migrations before `drop_pending_action` (`scratchSchemaBefore`), where the table still exists.

### Seams

- US-001 → US-006, US-007: `close` skips a held request. US-006 AC-14 and US-007 AC-11 hold a request in another transaction and run the job or policy close.
- US-002 → every later story: the store's read methods, `toFleetApproval` and `seedFleetAsk`. US-011 AC-1 lists through the project route.
- US-003 → US-006, US-010: the registered `fleet.job.shell.escalate` command. US-010 AC-6 allows through the project decide route and asserts the `APPROVAL_ANSWER` row.
- US-005 → US-007, US-010: the registered `fleet.budget.override` command. US-007 AC-1 opens one through `BudgetEvaluator.evaluate`; US-010 AC-14 decides `keep_paused` through the route.
- US-006 → US-008: `APPROVAL_ANSWER.approvalId` is the request id. US-008 AC-1 acks an answer written by a decide and reads the link.
- US-006 → US-009: the link the relay inserts. US-009 AC-3 expires a relayed ask through `ApprovalRequestExpirySweeper.tick`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. Asks are seeded with `seedFleetAsk` unless an AC opens them through a production entry point.

### US-001: Engine adjustments for fleet asks

- AC-1 [integration] While a second transaction holds `SELECT ... FOR UPDATE` on a pending ask's `ApprovalRequest` row, `ApprovalAskService.close(id, { status: 'cancelled', reason: 'job_ended' })` inside its own transaction answers null within 2 seconds.
- AC-2 [integration] After that second transaction rolls back, the request's status is still `pending`.
- AC-3 [integration] `PrismaApprovalRequestRepository.lockByIdSkipLocked(id)` inside a transaction answers the record of an unlocked pending request.
- AC-4 [integration] `lockByIdSkipLocked('missing')` answers null.
- AC-5 [unit] `ApprovalAskService.close` on a pending ask calls `lockByIdSkipLocked` with the id and never calls `lockById`.
- AC-6 [unit] `ApprovalRequestedSubscriber` handling a pending payload with `permissionKey: 'fleet.job.shell.escalate'` calls neither `queries.findById` nor `writer.deliver`.
- AC-7 [unit] The same holds for `permissionKey: 'fleet.budget.override'`.
- AC-8 [unit] (regression pin) A pending payload for `ticket.delete` whose request has one eligible user still calls `writer.deliver` once.

### US-002: The fleet ask read model

- AC-1 [unit] `toFleetApproval` of a pending bash row answers an object matching `{ type: 'nax_bash_escalate', status: 'pending', payload: <the input's payload>, jobId, leaseEpoch, naxAskId, decision: null }`, with the three ids taken from the link.
- AC-2 [unit] An executed bash row whose last decision is an approve with params `{ choice: 'allow_for_job' }` maps to an object matching `{ status: 'approved', decision: 'allow_for_job', decidedById: <the decider>, resolvedBy: 'user' }` while the link's `resolvedBy` is null.
- AC-3 [unit] A rejected bash row with a null link `resolvedBy` maps to an object matching `{ status: 'rejected', decision: 'deny', resolvedBy: 'user' }`.
- AC-4 [unit] An executed bash row whose link `resolvedBy` is `job_ended` maps to `status: 'cancelled'`.
- AC-5 [unit] A cancelled budget row whose link `resolvedBy` is `manual_resume` and outcome `resumedById: 'u1'` maps to an object matching `{ status: 'approved', decision: 'raise_budget_and_resume', decidedById: 'u1' }`.
- AC-6 [unit] A pending budget row maps to an object whose `payload` is its input without `policyId` and `requestedAt`, and whose `policyId` is the link's `budgetPolicyId`.
- AC-7 [unit] A failed row maps to `status: 'cancelled'`.
- AC-8 [unit] An expired row with no decision maps to an object matching `{ status: 'expired', decidedAt: <the request's settledAt> }`.
- AC-9 [integration] `FleetApprovalAskStore.findPage({ status: 'approved' }, page)` over seeded asks returns exactly the executed bash ask resolved `user` and the manual-resume budget ask.
- AC-10 [integration] `findPage({ status: 'cancelled' })` returns exactly a `job_ended` executed ask, a `job_ended` rejected ask, a failed ask and a `superseded` ask.
- AC-11 [integration] `findPage({ type: 'nax_bash_escalate', jobId })` returns exactly that job's two bash asks, newest first, with a pending `ticket.delete` request in the same project absent.
- AC-12 [integration] `countPending([p1, p2])` answers `[{ projectId: p1, slug, pending: 2 }, { projectId: p2, slug, pending: 1 }]` (slug order) for those projects' pending fleet asks, with settled asks uncounted.
- AC-13 [integration] `countPendingByJob([j1, j2])` answers a map equal to `{ j1 → 2 }` when `j2`'s only ask is settled.
- AC-14 [integration] `countPendingUnscoped()` answers 1 for one pending budget ask with no project and one with a project.
- AC-15 [integration] `findRequeueCandidates(policyId, since, 10)` answers exactly the jobs `CANCELLED` with the policy's budget reason, never started and finished at or after `since`, oldest `queuedAt` first.

### US-003: The bash command

- AC-1 [unit] After `ApprovalsModule` initialises, `ApprovalCommandRegistry.get('fleet.job.shell.escalate')` answers a `FleetShellEscalateCommand`.
- AC-2 [unit] `parse` of an input whose `leaseEpoch` is `1.5` throws.
- AC-3 [unit] `parseDecision('approve', undefined, input)` with `options: ['allow', 'deny']` answers `{ choice: 'allow', option: 'allow' }`.
- AC-4 [unit] `parseDecision('approve', { choice: 'allow_for_job' }, input)` with `options` including `allow-remember` answers `{ choice: 'allow_for_job', option: 'allow-remember' }`.
- AC-5 [unit] `parseDecision('approve', { choice: 'allow' }, input)` with `commandTruncated: true` throws.
- AC-6 [unit] `parseDecision('approve', { choice: 'allow_for_job' }, input)` with `options: ['allow', 'deny']` throws.
- AC-7 [unit] `parseDecision('reject', { choice: 'allow' }, input)` throws.
- AC-8 [unit] `parseDecision('reject', undefined, input)` answers `{ choice: 'deny', option: 'deny' }`.
- AC-9 [unit] `parseDecision('approve', output, input)` answers `output` for `output` = the result of AC-4.
- AC-10 [integration] Approving a pending bash ask of a `RUNNING` job through `ApprovalDecisionService.decide(id, 'approve', null)` writes one `APPROVAL_ANSWER` command with the job's runner and lease epoch and payload `{ approvalId: id, naxAskId, choice: 'allow' }`.
- AC-11 [integration] That approve settles the request `executed` with result `{ answered: true, choice: 'allow' }`.
- AC-12 [integration] With a spied `RunnerNotifier.notify`, that approve calls `notify` once with the job's runner id.
- AC-13 [integration] Rejecting the ask of a `RUNNING` job through `decide(id, 'reject', null)` writes one `APPROVAL_ANSWER` command with choice `deny`.
- AC-14 [integration] The approve of AC-10 records an audit entry with key `fleet.job.shell.escalate`, summary `answered allow` and `approval.requestId` equal to the request id.
- AC-15 [integration] The reject of AC-13 records an audit entry with key `fleet.job.shell.escalate` and summary `answered deny`.

### US-004: Bash answers reach only the ask's live lease

- AC-1 [integration] Approving when the job is `COMPLETED` writes no `APPROVAL_ANSWER` command, settles the request `executed` with result `{ answered: false }`, and sets the link's `resolvedBy` to `job_ended`.
- AC-2 [integration] Approving when the job's `leaseEpoch` is one above the ask's writes no command and sets `resolvedBy` to `job_ended`.
- AC-3 [integration] Rejecting when the job is `COMPLETED` writes no command, leaves the request `rejected`, and sets `resolvedBy` to `job_ended`.

### US-005: The budget command

- AC-1 [unit] After `ApprovalsModule` initialises, `ApprovalCommandRegistry.get('fleet.budget.override')` answers a `FleetBudgetOverrideCommand`.
- AC-2 [unit] `parseDecision('approve', { amountUsd: 12.5, requeueJobIds: ['a', 'a', 'b'] }, input)` answers `{ amountUsd: 12.5, requeueJobIds: ['a', 'b'] }`.
- AC-3 [unit] `parseDecision('approve', {}, input)` throws.
- AC-4 [unit] `parseDecision('approve', { amountUsd: 0 }, input)` throws.
- AC-5 [unit] `parseDecision('approve', { amountUsd: 1.23456 }, input)` throws.
- AC-6 [unit] `parseDecision('approve', { amountUsd: 5, requeueJobIds: <201 ids> }, input)` throws.
- AC-7 [unit] `parseDecision('reject', { amountUsd: 5 }, input)` throws.
- AC-8 [integration] Approving a pending budget ask of a paused policy with params `{ amountUsd: 20 }` through `ApprovalDecisionService.decide` leaves the policy matching `{ amountUsd: '20', pausedAt: null }`.
- AC-9 [integration] That approve writes one `resumed` incident matching `{ approvalId: <the request id>, actorId: <the decider> }`.
- AC-10 [integration] With `requeueJobIds` naming one re-queue candidate, after `decide` returns the job is `QUEUED` and the link's `outcome.requeueResults` equals `[{ jobId, ok: true }]`.
- AC-11 [integration] With `requeueJobIds: ['not-a-job']`, the link's `outcome.requeueResults` equals `[{ jobId: 'not-a-job', ok: false, error: 'not a re-queue candidate' }]`.
- AC-12 [integration] Approving with an `amountUsd` not above the window spend settles the request `failed` and leaves the policy paused.
- AC-13 [integration] Approving after the policy row was deleted settles the request `failed`.
- AC-14 [unit] `afterCommit` with two candidates, where `FleetJobsService.requeue` throws a `ConflictAppException` for the first, stores `requeueResults` with the first `{ ok: false, error: <JSON of its code and args> }` and the second `{ ok: true }`.
- AC-15 [integration] The approve of AC-8 records an audit entry with key `fleet.budget.override` and summary `raised to 20 and resumed`, and the request's `result` equals `{ resumedAmountUsd: '20' }`.

### US-006: Bash asks open and close on the engine

- AC-1 [integration] A runner sync (`POST /fleet/runner/sync`) whose report carries an `approval_request` event for a `RUNNING` job creates one `ApprovalRequest` matching `{ permissionKey: 'fleet.job.shell.escalate', status: 'pending', actor: SYSTEM/runner, onBehalfOf: <the job's requester>, origin: 'runner' }`, and one `FleetApprovalAsk` with that job's id, lease epoch and nax ask id.
- AC-2 [integration] With `approvalTimeoutSec` 60 and the ask's deadline 10 minutes away, the request's `expiresAt` is 60 seconds after the relay time.
- AC-3 [integration] With `approvalTimeoutSec` 600 and the deadline 30 seconds away, `expiresAt` equals the deadline.
- AC-4 [integration] A second sync re-reporting the same ask leaves one request and one link.
- AC-5 [integration] An ask relayed for a job in `raw` bash mode creates no request and records a `runner.sync` audit entry with summary `bash ask not opened: raw mode`.
- AC-6 [integration] An ask whose deadline has passed creates no request and records summary `bash ask not opened: past deadline`.
- AC-7 [integration] An ask reported in the same sync as the job's move from `RUNNING` to `COMPLETED`, after the transition event, creates no request and records summary `bash ask not opened: job not running`.
- AC-8 [integration] With an approval policy that resolves `fleet.job.shell.escalate` to `none` in the project, the ask creates no request and one `APPROVAL_ANSWER` command whose payload matches `{ approvalId: null, choice: 'allow' }`.
- AC-9 [integration] With that policy and `commandTruncated: true`, the command's choice is `deny`.
- AC-10 [integration] The pending open of AC-1 records a fleet activity row `approval.requested` with actor type `RUNNER` and `responsibleUserId` the job's user requester.
- AC-11 [integration] The pending open dispatches `fleet.approval.requested` to a project webhook with `approvalId` equal to the request id.
- AC-12 [integration] The pending open records an outbox event `fleet_approval_requested` whose `metadata.eventId` is the request id.
- AC-13 [integration] A runner report moving the job from `RUNNING` to `COMPLETED` settles its pending ask `cancelled` with result `{ closedBy: 'job_ended' }`, and sets the link's `resolvedBy` to `job_ended`.
- AC-14 [integration] While another transaction holds the ask's request row, that `COMPLETED` report commits and the ask stays `pending`.
- AC-15 [integration] The job-end close of AC-13 records a fleet activity row `approval.cancelled`.

### US-007: Budget asks open and close on the engine

- AC-1 [integration] `BudgetEvaluator.evaluate` on a project policy whose window spend crosses its hard stop creates one `ApprovalRequest` matching `{ permissionKey: 'fleet.budget.override', status: 'pending', actor: SYSTEM/budget, onBehalfOf: null, origin: 'system' }`, and one `FleetApprovalAsk` of kind `budget` with the policy's id.
- AC-2 [integration] That hard stop's `hard_stop` incident has `approvalId` equal to the request id.
- AC-3 [integration] With no approval policy for the key, the request's `expiresAt` is 86 400 seconds after its `createdAt`.
- AC-4 [integration] A second hard stop on the same policy settles the first ask `cancelled` with result `{ closedBy: 'superseded' }` and link `resolvedBy` `superseded`, leaving one pending ask.
- AC-5 [integration] `BudgetSweeper` resetting a stale monthly pause settles the pending ask `cancelled` with link `resolvedBy` `window_reset`, and the `window_reset` incident's `approvalId` is the request id.
- AC-6 [integration] `BudgetSweeper` deleting a policy whose scope is gone settles its pending ask with link `resolvedBy` `policy_deleted`.
- AC-7 [integration] `DELETE` on the policy's budget route settles its pending ask with link `resolvedBy` `policy_deleted`, and records a fleet activity row `approval.cancelled` with actor type `USER`.
- AC-8 [integration] Resuming the paused policy through the budgets resume route settles the pending ask `cancelled` with result `{ closedBy: 'manual_resume' }` and link `resolvedBy` `manual_resume`.
- AC-9 [integration] That resume leaves the link outcome equal to `{ resumedAmountUsd, requeueResults: [], resumedById: <the caller> }`.
- AC-10 [integration] A hard stop on a global policy creates a request with `projectId` null and records no `fleet_approval_requested` event.
- AC-11 [integration] While another transaction holds the pending ask's request row, the budgets `DELETE` commits and the ask stays `pending`.
- AC-12 [integration] When the policy has a second pending budget ask, approving the first through `ApprovalDecisionService.decide` settles the second with link `resolvedBy` `superseded`, and records a fleet activity row `approval.cancelled` for it.

### US-008: Answer delivery on the link

- AC-1 [integration] After a bash ask is allowed and the runner acks the `APPROVAL_ANSWER` with result `ok`, the link's `outcome.delivery` equals `{ result: 'ok', detail: null, at: <the ack time> }`.
- AC-2 [unit] An `error` ack with a 300-character detail stores `delivery.detail` as its first 200 characters.
- AC-3 [unit] An ack on a link whose outcome already has `resumedAmountUsd` keeps that key beside `delivery`.
- AC-4 [unit] An `APPROVAL_ANSWER` ack whose payload's `approvalId` is null calls neither `lockByRequest` nor `setOutcome`.
- AC-5 [unit] An ack whose `approvalId` has no link calls no `setOutcome`.

### US-009: Fleet events for engine-side changes

- AC-1 [integration] After a principal rejects a bash ask through `ApprovalDecisionService.decide` and the outbox relays the change, a fleet activity row `approval.decided` exists with the decider's id and payload `decision: 'deny'`.
- AC-2 [integration] After an approve executes and is relayed, the activity row's payload matches `{ status: 'approved', decision: 'allow' }`.
- AC-3 [integration] After `ApprovalRequestExpirySweeper.tick` expires a relayed bash ask and the change is relayed, the link's `resolvedBy` is `timeout` and an activity row `approval.expired` with actor type `SYSTEM` exists.
- AC-4 [integration] The change of AC-1 dispatches `fleet.approval.resolved` with `status: 'rejected'`.
- AC-5 [unit] With a spied `ApprovalLivePublisher.publish`, handling an executed change publishes one `fleet_approval` event with the mapped status after the transaction returns.
- AC-6 [unit] Handling the same executed payload twice records one activity row (the second sees `recordedStatus` equal).
- AC-7 [unit] A payload for `ticket.delete` writes nothing.
- AC-8 [unit] A payload with status `approved` writes nothing.
- AC-9 [unit] A malformed payload logs `approval_request_changed: malformed payload skipped` and writes nothing.
- AC-10 [unit] A fleet-key payload whose request has no link writes nothing.
- AC-11 [unit] An executed change whose link `resolvedBy` is `job_ended` records `approval.cancelled` and leaves `resolvedBy` `job_ended`.

### US-010: The /fleet/approvals decide adapter

- AC-1 [integration] Posting `decision: 'allow'` to `POST /projects/:slug/fleet/approvals/:id/decide` on an ask that is already `rejected` answers 409 `fleet.approvalNotPending`.
- AC-2 [integration] A Viewer posting `decision: 'allow'` with `amountUsd: 5` answers 403 `permissions`.
- AC-3 [integration] An agent posting `decision: 'allow'` on an ask of a job it requested answers 403 `fleet.approvalSelfDecide`.
- AC-4 [integration] A Developer posting `decision: 'allow'` with `amountUsd: 5` on a bash ask answers 400 `fleet.approvalInput`.
- AC-5 [integration] Posting `decision: 'allow'` on an ask whose payload has `commandTruncated: true` answers 400 `fleet.approvalDecisionInvalid`, and the request stays `pending`.
- AC-6 [integration] A Developer posting `decision: 'allow'` for a `RUNNING` job's ask answers 200 with `status: 'approved'`, `decision: 'allow'` and `resolvedBy: 'user'`, and writes one `APPROVAL_ANSWER` command.
- AC-7 [integration] Posting `decision: 'deny'` for a `RUNNING` job's ask answers 200 with `status: 'rejected'`.
- AC-8 [integration] Posting `decision: 'allow'` when the job has already `COMPLETED` answers 409 `fleet.approvalNotPending`.
- AC-9 [integration] Posting `decision: 'deny'` when the job has already `COMPLETED` answers 409 `fleet.approvalNotPending`.
- AC-10 [integration] An admin posting `raise_budget_and_resume` without `amountUsd` answers 400 `fleet.approvalDecisionInvalid`, and the request stays `pending`.
- AC-11 [integration] Posting `raise_budget_and_resume` with `requeueJobIds: ['not-a-job']` answers 400 `fleet.approvalDecisionInvalid`, and the request stays `pending`.
- AC-12 [integration] Posting `raise_budget_and_resume` with an `amountUsd` not above the window spend answers 400 `fleet.budgetAmountNotAboveSpend`, and the request stays `pending`.
- AC-13 [integration] Posting `raise_budget_and_resume` with `amountUsd: 20` on a seeded pending budget ask whose policy is not paused answers 409 `fleet.budgetNotPaused`.
- AC-14 [integration] Posting `keep_paused` answers 200 with `status: 'rejected'` and `decision: 'keep_paused'`, and the policy stays paused.
- AC-15 [integration] Posting `raise_budget_and_resume` with `amountUsd: 20` answers 200 with `status: 'approved'`, and the policy is no longer paused.

### US-011: Readers on the engine

- AC-1 [integration] `GET /projects/:slug/fleet/approvals` lists a seeded pending bash ask as a `FleetApprovalDto` matching `{ id: <the request id>, type: 'nax_bash_escalate', status: 'pending', jobId: <the link's> }`.
- AC-2 [integration] `GET /fleet/approvals?status=approved` as an admin returns the executed bash ask and not the rejected one.
- AC-3 [integration] `GET /projects/:slug/fleet/approvals/:id` of a pending budget ask includes `requeueCandidates` with one candidate and `requeueCandidatesTruncated: false`.
- AC-4 [integration] `GET /projects/:slug/fleet/approvals/:id` of another project's ask answers 404 `fleet.approvals`.
- AC-5 [integration] `GET /fleet/approval-counts` for an admin with one pending ask in each of two projects answers `total` 2 with one entry per project.
- AC-6 [integration] `GET /projects/:slug/fleet/jobs` reports `pendingApprovals: 1` for a job with one pending and one settled bash ask.
- AC-7 [integration] `GET /projects/:slug/fleet/jobs/:id` reports `pendingApprovals: 1` for that job.
- AC-8 [integration] `PrismaDashboardRepository.pendingSummaryByJob([jobId])` answers `[{ jobId, count: 2, oldestRequestedAt: <the older link's createdAt> }]` for two pending asks.
- AC-9 [integration] `GET /home` for the job's requester lists the pending ask matching `{ id: <the request id>, type: 'nax_bash_escalate', jobId: <the link's> }`.
- AC-10 [integration] For a global admin, the home approvals count includes a pending budget ask with no project.
- AC-11 [integration] The assistant's workspace project counts report `pendingApprovals: 1` for a project with one pending fleet ask and one pending `ticket.delete` request.
- AC-12 [integration] `FleetNotificationReader.approvalContext(requestId)` for a pending bash ask answers status `pending` and the job's repo.
- AC-13 [integration] `approvalContext` of a pending budget ask answers status `pending` and repo null.
- AC-14 [integration] Relaying a bash ask (as in US-006 AC-1) and running the outbox relay delivers one notification with `kind: 'approval_requested'` and `sourceType: 'fleet_approval'` to each global admin.

### US-012: Drop FleetApproval

- AC-1 [integration] (regression pin) Relaying a bash ask, posting `decision: 'allow'` to `POST /projects/:slug/fleet/approvals/:id/decide` and acking the answer `ok` leaves `GET /projects/:slug/fleet/approvals/:id` answering `status: 'approved'` with `outcome.delivery.result` `ok`.

Verification note (US-012): the deletions are verified by `bun run type-check` and `bun run lint` from the repo root, and by an empty `prisma migrate diff` from the migrations to the schema.
