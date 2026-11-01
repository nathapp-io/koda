# SPEC: Fleet PR fix follow-up review (S6 K3, part B1)

## Summary

When a `FIX` job ends `COMPLETED` with fix outcome `pushed`, koda queues one follow-up `REVIEW` of the same PR.
The terminal transition records a `fleet_fix_follow_up` outbox event in the same transaction. After commit, a new
outbox subscriber, `FixFollowUpSubscriber`, re-checks that the FIX requester still holds `fleet.job.dispatch` and that the repo still exists. It then
claims the pushed head in `FleetPrReview`, the K1-B auto-review head table, so the auto-review poller does not review
that head again. Finally it dispatches the `REVIEW` with the FIX's profiles and `maxCostUsd`, on behalf of the requester,
under the new system writer key `system.pr-fix.follow-up`. Every outcome, whether a dispatch or a skip, writes one audit
entry on the FIX job. Part B2 (`fleet-pr-fix-surfaces`) adds the CLI, assistant tool and web dispatch surfaces and is
specified separately.

## Motivation

K3-A (`fleet-pr-fix`, PR #364) runs `nax bot fix --no-rereview`. nax's own post-push re-review cannot take koda's
decisions, so it could raise again a finding the team already settled. The approved design
(`docs/superpowers/specs/2026-11-01-fleet-s6-k3-pr-fix-design.md` §D4) moves that re-review into koda. koda re-reviews
the pushed head with decisions as a normal `REVIEW` job, which marks fixed threads and feeds K2 review memory. Today
nothing reviews the head a FIX pushed unless auto-review is on for the repo. Live check §9.155 (sandbox PR #22) showed
the fix commit landing with no follow-up review. K3-A's spec left this to part B and asked part B to settle how the K1-B
head poller interacts with it.

## Design

### Calls made in this spec

1. **Trigger: an outbox event recorded in the terminal transaction.** `FleetJobOutcomeRecorder.onTerminal` already runs
   inside `JobTransitionsService.apply`'s transaction for every terminal job. It gains a first step: for a `FIX` job in
   `COMPLETED` whose `fixOutcome` is `pushed`, it records one `fleet_fix_follow_up` outbox event. This step comes before
   the method's existing agent-requester and thread-kind early return, because an agent's FIX gets a follow-up too. The
   step needs `resultSha` non-null and a feature `prNumberOfReviewFeature` can parse. Without both, nothing is
   recorded. The outbox relay delivers the event after commit, so no dispatch runs inside the job report transaction.
   (A dispatch opens its own transaction, and a 409 must not poison the caller's, the `ScheduleTicker` rule.)
   `FleetJobOutcomeRecorder` keeps its constructor, so no injection site changes.
2. **The event's payload is a snapshot**: `{ jobId, leaseEpoch, projectId, repoId, prNumber, headSha, requestedById,
   requestedByType, profiles, maxCostUsd }`. `headSha` is the FIX's `resultSha`. `requestedByType` is the record's
   value, or `'USER'` when the record has none (the column default). `maxCostUsd` is the record's decimal string.
   `metadata` is `{ projectId, eventId: '<jobId>:<leaseEpoch>:fix-follow-up' }`, so a requeued FIX that pushes again
   gets its own event.
3. **One subscriber, one new system key.** `FixFollowUpSubscriber` (`apps/api/src/fleet/reviews/`) is
   `@SystemWriter('system.pr-fix.follow-up')`. It registers its handler for `fleet_fix_follow_up` on `FanOutPublisher`
   in `onModuleInit`, the pattern of `FleetJobOutcomeSubscriber`. The handler runs its body in
   `runAsSystem('pr-fix', fn, { onBehalfOf: { type: requestedByType, id: requestedById } })`. The component id is the
   key's second segment, so `SYSTEM_ACTOR_IDS` picks it up from the catalog unchanged.
4. **Requester re-check (the K1-B enabler rule).** The handler loads the requester's access with
   `FleetPrReviewRepository.findPrincipalAccess` and its keys with `PermissionService.effectiveKeys(requester,
   { projectId })`. It goes on only when `mayDispatch(access, keys)` holds. Otherwise it skips with reason
   `requester_lost_access`. Nothing is turned off, because there is no setting to turn off. Next it reads the repo with
   `FleetReposService.findReviewRepo(repoId)`. A `null` result skips with reason `repo_gone`, before any claim:
   `FleetPrReview.repoId` is a foreign key to `FleetRepo`, so a claim on a deleted repo would throw instead of
   returning `null`. A repo deleted between this read and the claim makes the claim throw; the relay redelivers, and
   the redelivery skips with `repo_gone`.
5. **The head claim settles the poller race.** Before dispatching, the handler calls
   `insertPending(repoId, prNumber, headSha)` under `bookkeeping('fleet.pr-review-bookkeeping', ...)`. A `null` claim
   means the auto-review poller (or an earlier delivery of this event) already claimed that head. The handler then skips
   with reason `head_already_claimed`, and the poller's review covers the head. A successful dispatch calls
   `markDispatched(claim.id, reviewJob.id)`. The poller's `headIsOpen` then treats the head as settled. The handler
   never reopens a `pending` claim; only the poller's existing stale-claim recovery does, and only for repos with
   auto-review on.
6. **The dispatch.** `FleetJobsService.dispatch(requestedById, projectId, { command: 'REVIEW', repoId, prNumber,
   profiles, maxCostUsd: Number(maxCostUsd) }, { auditKey: 'system.pr-fix.follow-up' })`, with no transaction open. The
   `auditKey` union gains `'system.pr-fix.follow-up'`. Decisions are selected inside `dispatch` as for every `REVIEW`
   (K2), so the follow-up carries them. A follow-up `REVIEW` never queues anything itself: only a `FIX` records the
   event, so there is one round.
7. **Dispatch failures mirror `ReviewHeadDispatcher`.** The checks run in this order, because
   `BudgetPausedException` extends `ConflictAppException`:
   - `BudgetPausedException`: remove the claim, reason `budget_paused`.
   - `ConflictAppException` with response prefix `fleet.jobs`: remove the claim, reason `review_active`.
   - `ValidationAppException`, `NotFoundAppException` or `FleetDispatchException`: `markFailed(claim.id,
     'failed:<reason>')` (cut to 200 characters), reason `<reason>`. `<reason>` is the validation response's
     `args.reason` when it is a string, else the exception's class name.
   - Any other error: remove the claim, log a warning naming the FIX job id and the error class, reason
     `dispatch_error`.
8. **One audit entry per handled event, on the FIX job.** `AuditRecorder.record({ key: 'system.pr-fix.follow-up',
   resourceType: 'fleet-job', resourceId: <FIX job id>, projectId, summary })` runs inside
   `txManager.run(() => audit.record(entry))`, with `TRANSACTION_MANAGER` injected, as `AuditRecorder.record`
   requires (`AuditRecorder.audited` is not used). The summary is `follow-up review dispatched: <review job id>` or
   `follow-up review skipped: <reason>`. A successful dispatch also has the job's own dispatch audit (key
   `system.pr-fix.follow-up`, actor `SYSTEM/pr-fix`, on behalf of the requester); the entry on the FIX job is the link
   between the two jobs.
9. **The handler throws only on database failure**, the `FleetJobOutcomeSubscriber` rule. A malformed payload logs a
   warning and returns. A throw from the requester reads (`findPrincipalAccess`, `effectiveKeys`), the repo read, a
   claim, a mark, a removal or an audit write makes the relay redeliver. When the claim still exists (after a dispatch
   or a `markFailed`), the redelivery finds the head already claimed and skips with `head_already_claimed` instead of
   dispatching twice. When the claim was removed (`budget_paused`, `review_active`, `dispatch_error`) and the audit
   write then failed, the redelivery claims again and retries the dispatch, which is safe because the first dispatch
   created no job. A
   database error thrown inside `FleetJobsService.dispatch` is not a handler throw: call 7's catch-all turns it into
   a final `dispatch_error` skip, as `ReviewHeadDispatcher` does.
10. **Head equality is not checked.** The follow-up reviews the PR's current head, which is whatever `nax bot review
    <pr>` sees when it runs. The claim names the head the FIX pushed. If someone pushes after the fix, the poller (when
    auto-review is on) reviews that newer head under its own claim.

### Integration

Symbols read unchanged:

- `FleetPrReviewRepository` (`apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts:29-39`): `findHead`,
  `insertPending(repoId: string, prNumber: number, headSha: string): Promise<FleetPrReviewRecord | null>` (`null` on a
  unique violation), `markDispatched(id: string, jobId: string): Promise<void>`, `markFailed(id: string, outcome: string):
  Promise<void>`, `remove(id: string): Promise<void>`, `findPrincipalAccess(ref: PrincipalRef):
  Promise<PrincipalAccess>`. Token `FLEET_PR_REVIEW_REPOSITORY`.
- `mayDispatch(access, keys)` (`apps/api/src/fleet/schedules/schedule-access.ts:12`).
- `FleetReposService.findReviewRepo(id: string): Promise<Pick<FleetRepoRecord, 'id' | 'projectId' | 'owner' | 'name' |
  'githubInstallationId'> | null>` (`apps/api/src/fleet/repos/fleet-repos.service.ts:109`); `FleetReposModule` exports
  `FleetReposService` and `FleetReviewsModule` already imports it.
- `TRANSACTION_MANAGER` / `ITransactionManager` (`@nathapp/nestjs-data`), injected as in `fleet-repos.service.ts:36`.
- `PermissionService.effectiveKeys` (used the same way at `apps/api/src/fleet/reviews/enabler-gate.ts:24-27`).
- `runAsSystem(component, fn, opts?: { onBehalfOf? })` (`apps/api/src/action-context/action-context.ts:130`).
- `bookkeeping(reason, fn)` (`apps/api/src/action-context/audit-coverage.ts`), reason `'fleet.pr-review-bookkeeping'`.
- `FanOutPublisher.register(type, handler)` (`apps/api/src/outbox/fan-out-publisher.ts`); `publish(record)` runs each
  handler in `runAsSystem('outbox')` and throws one aggregate error when any handler throws.
- `AuditRecorder.record(input: AuditRecordInput)` (`apps/api/src/audit/audit-recorder.service.ts:44`); must run inside
  a transaction.
- `prNumberOfReviewFeature(feature: string): number | null` (`apps/api/src/fleet/common/review-jobs.ts:7`).
- `BudgetPausedException` (`apps/api/src/fleet/budgets/budget.exceptions.ts:5`, extends `ConflictAppException`),
  `ConflictAppException`, `ValidationAppException`, `NotFoundAppException`, `FleetDispatchException`, as imported by
  `apps/api/src/fleet/reviews/review-head-dispatcher.ts:1-6`.
- Patterns to mirror: `ReviewHeadDispatcher.dispatch` (`review-head-dispatcher.ts:98-133`) for the error mapping;
  `FleetJobOutcomeSubscriber` (`apps/api/src/notifications/fleet/fleet-job-outcome.subscriber.ts`) for the registration
  and payload parsing; `buildJobOutcomePayload` / `parseJobOutcomePayload`
  (`apps/api/src/notifications/fleet/fleet-notification-events.ts:37,65`) for the payload helpers.

Symbols this feature changes. Each baseline only locates the code; the target is the interface to implement.

- `FleetJobOutcomeRecorder.onTerminal(job: FleetJobRecord): Promise<void>` (`apps/api/src/fleet/jobs/job-outcome.recorder.ts:28`).
  Baseline: returns at once for an agent requester or a thread kind, then enqueues `fleet_job_outcome` when
  `jobOutcomeOf` gives an outcome. Target: same signature. First it records `fleet_fix_follow_up` for a qualifying
  `FIX` (call 1), whatever the requester type. Then it runs the baseline unchanged.
- `FleetJobsService.dispatch` opts (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:79`). Baseline: `auditKey?:
  'fleet.job.dispatch' | 'thread.plan' | 'thread.run' | 'system.schedule.dispatch' | 'system.pr-review.dispatch'`.
  Target: the union also accepts `'system.pr-fix.follow-up'`. Behaviour is unchanged.
- `INVENTORY_SCOPE_ROWS` (`apps/api/src/permissions/catalog.ts:154`). Target: gains `'system.pr-fix.follow-up':
  ['system']` right after `'system.pr-review.dispatch'` (line 345).
- `FleetReviewsModule` (`apps/api/src/fleet/reviews/fleet-reviews.module.ts`). Target: also imports `OutboxModule`
  (`apps/api/src/outbox/outbox.module.ts`, which exports `FanOutPublisher` through `OutboxCoreModule`), and provides
  `FixFollowUpSubscriber`.

New code:

- `apps/api/src/fleet/common/fix-follow-up-events.ts`: `FIX_FOLLOW_UP = 'fleet_fix_follow_up'`, the
  `FixFollowUpPayload` type (call 2), `buildFixFollowUpPayload(job: FleetJobRecord, prNumber: number, headSha:
  string): FixFollowUpPayload`, and `parseFixFollowUpPayload(raw: unknown): FixFollowUpPayload | null`. The parser
  returns `null` when any field is missing or mistyped: `requestedByType` must be `'USER'` or `'AGENT'`, `prNumber` a
  positive safe integer, `profiles` an array of strings, and `maxCostUsd` a string.
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts`: `FixFollowUpSubscriber` with `onModuleInit()` and
  `readonly handle: (payload: unknown) => Promise<void>`. Its constructor is fixed from the first story so later
  stories do not change it: `(registry: FanOutPublisher, @Inject(FLEET_PR_REVIEW_REPOSITORY) reviews:
  IFleetPrReviewRepository, jobs: FleetJobsService, repos: FleetReposService, permissions: PermissionService,
  audit: AuditRecorder, @Inject(TRANSACTION_MANAGER) txManager: ITransactionManager)`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Malformed payload | warning logged, nothing written, handler returns |
| Requester lacks `fleet.job.dispatch`, is disabled, or is gone | no claim, no dispatch; audit `follow-up review skipped: requester_lost_access` |
| Repo gone (`findReviewRepo` returns `null`) | no claim, no dispatch; audit `follow-up review skipped: repo_gone` |
| Head already claimed (`insertPending` returns `null`) | no dispatch; audit `follow-up review skipped: head_already_claimed` |
| `BudgetPausedException` | claim removed; audit `... skipped: budget_paused` |
| `ConflictAppException` prefix `fleet.jobs` (a REVIEW or FIX of the PR is active) | claim removed; audit `... skipped: review_active` |
| `ValidationAppException` / `NotFoundAppException` / `FleetDispatchException` (not GitHub, other dispatch refusals) | claim marked `failed:<reason>`; audit `... skipped: <reason>` |
| Any other dispatch error | claim removed; warning names the FIX job id and error class; audit `... skipped: dispatch_error` |
| Database failure in a repo read, claim, mark or audit write | the handler throws; the outbox relay redelivers |

## Out of Scope

- Dispatching `REVIEW` or `FIX` from the CLI, the assistant tool `koda_dispatch_job` or the web dispatch form, and a `Fix` action on a `REVIEW` job page; part B2 (`fleet-pr-fix-surfaces`).
- A follow-up after a `FIX` whose outcome is `nothing`, including `nothing; pushed advisor ledger <sha>`: no code changed, so no review is queued.
- A follow-up after a `FIX` that ends `FAILED`, `CANCELLED`, `ESCALATED` or `CRASHED`.
- Checking that the PR's current head still equals the pushed sha before dispatching: the follow-up reviews whatever head the PR has when the review runs.
- A second fix round, or a follow-up queued by a follow-up `REVIEW`: only a `FIX` records the event.
- Retrying a skipped follow-up later (for example after a budget pause lifts or an active review ends): a skip is final, and auto-review covers the head when it is enabled for the repo.
- A duplicate skip audit entry whenever the relay redelivers an event (after a database failure or a reclaimed delivery): the redelivery is audited as `head_already_claimed`.
- Recovering a follow-up whose handler stopped between the claim and `markDispatched` (a crash or a database failure): the `pending` claim makes every redelivery skip as `head_already_claimed`; only the K1-B poller's stale-claim recovery reopens it, and only when auto-review is on for the repo. When the stop came after a successful dispatch (`markDispatched` failed), that recovery dispatches a second `REVIEW` of an already-reviewed head.
- Redelivering after a database error thrown inside `FleetJobsService.dispatch`: it is a final `dispatch_error` skip, as in `ReviewHeadDispatcher`.
- Logging or auditing a `FIX` that ends `COMPLETED` with `fixOutcome` `pushed` but no `resultSha` (the runner sets `resultSha` only when the pushed sha resolves): no event is recorded and nothing else happens.
- A skip audited as `dispatch_error` although `FleetJobsService.dispatch` created the `REVIEW` row before it threw (for example from placement): this mirrors `ReviewHeadDispatcher`, and the queued `REVIEW` still runs.
- Checking that the PR is still open: a `FIX` whose PR was closed or merged before the follow-up runs still queues the `REVIEW`, and that job fails with nax's reason.
- Turning anything off when the requester has lost access: there is no stored setting for a follow-up.
- Web, CLI or notification display of the follow-up link: it lives in the audit log only.
- Changing the K1-B poller, `ReviewHeadDispatcher` or the `fleet.pr-review-bookkeeping` reason text; that text names `system.pr-review.dispatch` and is reused unchanged for the follow-up's claims.

## Stories

All stories run in `Workdir: apps/api`.

### US-001: API fix follow-up event

No dependencies. Workdir: apps/api. Adds `fix-follow-up-events.ts` (the event type, payload builder and parser) and
the first step of `FleetJobOutcomeRecorder.onTerminal`, which records the event for a `COMPLETED` `FIX` with outcome
`pushed`, inside the terminal transaction (calls 1 and 2).

### US-002: API fix follow-up subscriber, system key and dispatch

Depends on US-001. Workdir: apps/api. Adds the catalog key `system.pr-fix.follow-up` and its inventory row, the
`auditKey` union member, and `FixFollowUpSubscriber`, the key's `@SystemWriter`, registered in `FleetReviewsModule`
with `OutboxModule` imported. The key, the writer class and its module registration land together, because the writer
contract checks every system key against a booted writer. The subscriber takes its full constructor (Integration)
here. The handler covers parsing, the head claim, the successful dispatch in the `pr-fix` system context and its audit
entry (calls 3, 5, 6, 8, 9). The requester and repo checks are US-003; dispatch failures are US-004. The US-002 test
fixtures already stub a granted requester (`findPrincipalAccess` returns an existing, enabled principal;
`effectiveKeys` includes `fleet.job.dispatch`) and an existing repo (`findReviewRepo` returns it), so US-003's checks
do not change them.

### US-003: API fix follow-up skips

Depends on US-002. Workdir: apps/api. Adds the requester re-check, the repo read and the claimed-head skip, each
audited on the FIX job (calls 4 and 5), and the database-failure throw for a skip's audit write (call 9).

### US-004: API fix follow-up dispatch failures

Depends on US-003. Workdir: apps/api. Adds the dispatch error mapping of call 7.

### US-005: API fix follow-up end-to-end flow

Depends on US-004. Workdir: apps/api. Adds an integration test from a `FIX` terminal report on the runner sync path
through `FanOutPublisher.publish` to the follow-up `REVIEW` row, its head claim and its audit entry, on the real test
database.

### Context Files

**US-001**

- `apps/api/src/fleet/jobs/job-outcome.recorder.ts` — the method gaining the first step.
- `apps/api/src/notifications/fleet/fleet-notification-events.ts` — payload builder and parser pattern.
- `apps/api/src/fleet/common/review-jobs.ts` — `prNumberOfReviewFeature`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobRecord` fields (`fixOutcome`, `resultSha`, `profiles`, `maxCostUsd`, `requestedByType`).
- `apps/api/src/fleet/jobs/job-transitions.service.ts` — where `onTerminal` is called, inside the transaction.

**US-002**

- `apps/api/src/notifications/fleet/fleet-job-outcome.subscriber.ts` — the subscriber pattern.
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — claim, dispatch and mark pattern.
- `apps/api/src/fleet/reviews/fleet-pr-review.pass.ts` — `runAsSystem` with `onBehalfOf`, `@SystemWriter` usage.
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `txManager.run` with `audit.record` inside (`disableAutoReview`).
- `apps/api/src/fleet/common/fix-follow-up-events.ts` — created by US-001, consumed here.

**US-003**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — created by US-002, extended here.
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.spec.ts` — created by US-002; its fixtures already stub a granted requester and an existing repo, reused here.
- `apps/api/src/fleet/reviews/enabler-gate.ts` — the access re-check pattern.
- `apps/api/src/fleet/schedules/schedule-access.ts` — `mayDispatch`.
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `findReviewRepo`.

**US-004**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — created by US-002, extended here.
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — the error mapping to mirror.
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.spec.ts` — created by US-002; fixture pattern reused.

**US-005**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — created by US-002, exercised here.
- `apps/api/test/integration/fleet/fleet-pr-review.integration.spec.ts` — integration fixture pattern for repos, jobs and `FleetPrReview`.
- `apps/api/test/integration/fleet/runner-sync-lifecycle.integration.spec.ts` — reports `UPLOADING` then `COMPLETED` through the runner sync path (lines 112-114).
- `apps/api/test/integration/fleet/runner-sync.integration.spec.ts` — reports a `FIX` snapshot carrying `fixOutcome`.
- `apps/api/src/outbox/fan-out-publisher.ts` — `publish(record)`.

### Creates

**US-001**

- `apps/api/src/fleet/common/fix-follow-up-events.ts`
- `apps/api/src/fleet/common/fix-follow-up-events.spec.ts`

**US-002**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts`
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.spec.ts`

**US-003**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.skips.spec.ts`

**US-004**

- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.outcomes.spec.ts`

**US-005**

- `apps/api/test/integration/fleet/fleet-fix-follow-up.integration.spec.ts`

### Modifies

**US-001**

- `apps/api/src/fleet/jobs/job-outcome.recorder.ts` — `onTerminal` gains the follow-up step before its existing agent-requester and thread-kind early return; the rest of the method is unchanged.
- `apps/api/src/fleet/jobs/job-outcome.recorder.spec.ts` — gains tests for the follow-up step; its existing assertions keep holding because the default job fixture has no `FIX` command, so `outbox.record` is still not called for the cases that assert it is not.

**US-002**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — the `dispatch` opts `auditKey` union gains `'system.pr-fix.follow-up'`; no behaviour change.
- `apps/api/src/permissions/catalog.ts` — `INVENTORY_SCOPE_ROWS` gains `'system.pr-fix.follow-up': ['system']` right after `'system.pr-review.dispatch'`.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the catalog spec re-derives the catalog from this file; it gains one system row for FixFollowUpSubscriber (outbox fleet_fix_follow_up) with key system.pr-fix.follow-up and catalog scope system, placed right after the FleetPrReviewPass row at line 261 and mirroring its columns.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writers map (lines 41-79) gains FixFollowUpSubscriber with key system.pr-fix.follow-up placed after FleetPrReviewPass, and the length assertion (line 103) changes from 36 to 37; AC-5 then holds for the new system key.
- `apps/api/src/permissions/role-matrix.spec.ts` — the per-role cell count (line 224) changes from 223 to 224 for the new system key; it stays an exact count.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role gains system.pr-fix.follow-up, placed right after system.pr-review.dispatch, as non-role-key, non-role-key, like system.pr-review.dispatch. Every other entry stays identical.
- `apps/api/src/fleet/reviews/fleet-reviews.module.ts` — imports OutboxModule and provides FixFollowUpSubscriber.
- `apps/api/src/fleet/reviews/fleet-reviews.module.spec.ts` — gains a test that the compiled module resolves FixFollowUpSubscriber; the existing compile tests keep compiling with OutboxModule imported (GlobalStubsModule already loads the outbox config).

**US-003**

None. US-003 extends `fix-follow-up.subscriber.ts` and its spec, both created by US-002 in this branch (listed in its Context Files), and adds a new test file; no pre-existing file breaks.

**US-004**

None. US-004 extends `fix-follow-up.subscriber.ts`, created by US-002 in this branch (listed in its Context Files), and adds a new test file; no pre-existing file breaks.

**US-005**

None. US-005 adds one new integration test file and changes no production code.

### Seams

- `buildFixFollowUpPayload`, `parseFixFollowUpPayload` and `FIX_FOLLOW_UP` (US-001) are consumed by `FixFollowUpSubscriber` (US-002). US-002's seam AC publishes a record built with `buildFixFollowUpPayload` through `FanOutPublisher.publish` and asserts the subscriber's dispatch.
- The outermost entry point for the whole flow is the runner sync report (`JobReportProcessor`) applying a `FIX`'s snapshot and its `COMPLETED` state. US-005's integration AC enters there and ends at the follow-up `REVIEW` row.

## Acceptance Criteria

### US-001: API fix follow-up event

- `[unit]` `FleetJobOutcomeRecorder.onTerminal` with a `FIX` job in `COMPLETED`, `fixOutcome` `'pushed'`, `resultSha` `'a'.repeat(40)` and feature `review-pr-22` calls `outbox.record` with `type` `'fleet_fix_follow_up'`.
- `[unit]` in that call the payload deep-equals `{ jobId, leaseEpoch, projectId, repoId, prNumber: 22, headSha: 'a'.repeat(40), requestedById, requestedByType, profiles, maxCostUsd }` with each value taken from the job.
- `[unit]` in that call `metadata` deep-equals `{ projectId: <job projectId>, eventId: '<job id>:<leaseEpoch>:fix-follow-up' }`.
- `[unit]` the same qualifying `FIX` job with `requestedByType` `'AGENT'` records a `fleet_fix_follow_up` payload whose `requestedByType` is `'AGENT'`.
- `[unit]` a qualifying `FIX` job whose record has no `requestedByType` records a `fleet_fix_follow_up` payload whose `requestedByType` is `'USER'`.
- `[unit]` table-driven: `onTerminal` records no `fleet_fix_follow_up` event for each of a `FIX` in `COMPLETED` with `fixOutcome` `'nothing'`, a `FIX` in `FAILED` with `fixOutcome` `'pushed'`, a `REVIEW` in `COMPLETED`, a qualifying `FIX` with `resultSha` null, and a qualifying `FIX` with feature `review-pr-x`.
- `[unit]` `parseFixFollowUpPayload` returns a value deep-equal to its input for the object `buildFixFollowUpPayload` returns.
- `[unit]` table-driven: `parseFixFollowUpPayload` returns null for a valid payload with `requestedByType` `'SYSTEM'`, with `prNumber` `0`, with `profiles` `[1]`, with `maxCostUsd` the number `1`, and with `jobId` missing.

### US-002: API fix follow-up subscriber, system key and dispatch

- `[unit]` `FixFollowUpSubscriber.onModuleInit` calls `FanOutPublisher.register` with `'fleet_fix_follow_up'` and the subscriber's `handle`.
- `[unit]` `handle` with a payload `parseFixFollowUpPayload` rejects logs a warning and does not call `FleetJobsService.dispatch`.
- `[unit]` `handle` with a valid payload whose requester is granted calls `insertPending` with the payload's `repoId`, `prNumber` and `headSha`.
- `[unit]` in that case `FleetJobsService.dispatch` is called with arguments deep-equal to `(requestedById, projectId, { command: 'REVIEW', repoId, prNumber, profiles, maxCostUsd: <Number of the payload's maxCostUsd> }, { auditKey: 'system.pr-fix.follow-up' })` from the payload.
- `[unit]` the `dispatch` call runs in an action context whose actor is `{ type: 'SYSTEM', id: 'pr-fix' }`.
- `[unit]` the `dispatch` call runs in an action context whose `onBehalfOf` is `{ type: <payload requestedByType>, id: <payload requestedById> }`.
- `[unit]` after `dispatch` resolves with job id `rev-1`, `markDispatched` is called with the claim's id and `'rev-1'`.
- `[unit]` after that dispatch, `AuditRecorder.record` is called inside `txManager.run` with `{ key: 'system.pr-fix.follow-up', resourceType: 'fleet-job', resourceId: <payload jobId>, projectId: <payload projectId>, summary: 'follow-up review dispatched: rev-1' }`.
- `[unit]` `FanOutPublisher.publish` of an outbox record with type `fleet_fix_follow_up` and a payload from `buildFixFollowUpPayload`, with the subscriber registered and the requester granted, results in one `FleetJobsService.dispatch` call whose DTO command is `'REVIEW'`.
- `[unit]` the class-to-key declaration map from `@SystemWriter` maps `FixFollowUpSubscriber` to `'system.pr-fix.follow-up'`.
- `[unit]` compiling `FleetReviewsModule` with the global test stubs resolves `FixFollowUpSubscriber`.

### US-003: API fix follow-up skips

- `[unit]` when `mayDispatch` is false for the requester (its effective keys lack `fleet.job.dispatch`), `handle` does not call `insertPending`.
- `[unit]` in that case `AuditRecorder.record` is called with summary `'follow-up review skipped: requester_lost_access'` and `resourceId` the payload's `jobId`.
- `[unit]` when the requester's access is disabled although its keys include `fleet.job.dispatch`, `handle` does not call `insertPending`.
- `[unit]` when `FleetReposService.findReviewRepo` returns null for the payload's `repoId`, `handle` does not call `insertPending`.
- `[unit]` in that case `AuditRecorder.record` is called with summary `'follow-up review skipped: repo_gone'`.
- `[unit]` when `insertPending` returns null, `handle` does not call `dispatch`.
- `[unit]` in that case `AuditRecorder.record` is called with summary `'follow-up review skipped: head_already_claimed'`.
- `[unit]` when `AuditRecorder.record` rejects with a database error after a `head_already_claimed` skip, `handle` rejects.

### US-004: API fix follow-up dispatch failures

- `[unit]` table-driven over `dispatch` rejections that remove the claim, each row asserting one deep-equal of `{ removed: <ids passed to remove>, summary: <audit summary> }`: `BudgetPausedException` -> `{ removed: [claim.id], summary: 'follow-up review skipped: budget_paused' }`; `ConflictAppException` with prefix `fleet.jobs` -> `{ removed: [claim.id], summary: 'follow-up review skipped: review_active' }`; a plain `Error` -> `{ removed: [claim.id], summary: 'follow-up review skipped: dispatch_error' }`.
- `[unit]` table-driven over `dispatch` rejections that fail the claim, each row asserting one deep-equal of `{ failed: <markFailed arguments>, summary: <audit summary> }`: `ValidationAppException` with `args.reason` `'review is GitHub-only'` -> `{ failed: [claim.id, 'failed:review is GitHub-only'], summary: 'follow-up review skipped: review is GitHub-only' }`; `NotFoundAppException` -> `{ failed: [claim.id, 'failed:NotFoundAppException'], summary: 'follow-up review skipped: NotFoundAppException' }`; `FleetDispatchException` -> `{ failed: [claim.id, 'failed:FleetDispatchException'], summary: 'follow-up review skipped: FleetDispatchException' }`.
- `[unit]` when `dispatch` rejects with `BudgetPausedException`, `handle` does not call `markFailed`.
- `[unit]` when `dispatch` rejects with `ValidationAppException` whose `args.reason` is 300 characters long, `markFailed` receives an outcome of exactly 200 characters starting with `failed:`.
- `[unit]` when `dispatch` rejects with a plain `Error`, `handle` logs one warning whose text contains the payload's `jobId` and the error's class name.
- `[unit]` when `dispatch` rejects with a plain `Error`, `handle` resolves.
- `[unit]` when `dispatch` rejects with `BudgetPausedException` and the following `remove` rejects with a database error, `handle` rejects.

### US-005: API fix follow-up end-to-end flow

- `[integration]` on the real test database, a running `FIX` job reported through the runner sync path with a snapshot carrying `fixOutcome` `'pushed'` and a `resultSha`, then state `UPLOADING`, then state `COMPLETED`, followed by `FanOutPublisher.publish` of the `fleet_fix_follow_up` outbox row that report left, creates exactly one `REVIEW` job for the same repo with feature `review-pr-<n>`.
- `[integration]` that `REVIEW` job's `profiles`, `maxCostUsd` and `requestedById` equal the FIX job's.
- `[integration]` after that, `FleetPrReview` holds one row for `(repoId, prNumber, resultSha)` with outcome `dispatched` and `jobId` the new `REVIEW` job's id.
- `[integration]` after that, an audit entry with key `system.pr-fix.follow-up`, `resourceId` the FIX job id and summary `follow-up review dispatched: <REVIEW job id>` exists.
- `[integration]` publishing the same outbox row a second time creates no second `REVIEW` job and writes an audit entry with summary `follow-up review skipped: head_already_claimed`.
