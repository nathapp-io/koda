# SPEC: Permissions P2g — Audit Entries for the Runner Protocol and the Fleet System Writers

## Summary

This feature makes the runner protocol routes and the fleet system writers in `apps/api` record an `AuditEntry` in the same transaction as the write. It uses the recorder and the rules from `permissions-p2-audit-core`: `AuditRecorder.record` inside an existing `txManager.run`, and `AuditRecorder.audited` when there is none. The writes:
- **Runner sync.** A job state change a runner reports or causes through a command ack, and the boot reconcile that queues `READOPT`s.
- **Runner enroll and bundle upload.** `EnrollmentService.enroll` and `BundleService.upload`.
- **Server-side job transitions.** `FleetSweeper` crashing a silent runner's job, placement cancelling a job in a paused budget scope, and the bundle ingest drain.
- **Budget enforcement.** `BudgetSweeper`'s orphan delete and window reset, `BudgetEvaluator`'s warn and hard stop.
- **Approvals.** A bash ask opened by a runner report, and the expiry and job-end closes that the sweepers and the decide requests commit.
- **Schedules.** A scheduled fire, a coalesce, an auto-disable, and the schedule-fire test hook.
- **Retention and PR refresh.** `FleetLogRetentionProcessor`, `EnrollmentRetentionProcessor` and `FleetPrStateRefresher`.
- **Knowledge and threads.** A knowledge index pass that completes, and a thread turn's `turn_end` folded from the runner's thread stream.

Runner traffic that changes no state records nothing: heartbeats, command delivery and acks that change nothing, log chunks, event bookkeeping, placement's assignments. The Bookkeeping table lists every such write, so `permissions-p2-audit-integrations` can put them on its coverage guard's allowlist.

This is the seventh of nine features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, audit-fleet-routes, audit-fleet-ops, **audit-fleet-system**, audit-integrations, web.

## Motivation

`permissions-p2-audit-fleet-ops` (PR #331, deployed `407c36d0` on 2026-10-25) records the fleet's admin writes: on koda-wk a budget create, update and delete now leave `fleet.budget.*` entries. A job that a runner finishes, a job crashed by the sweeper, a budget hard stop, an expired approval, a scheduled fire or a nightly log purge records none. Those are the writes nobody clicked, and the Audit log (`GET /api/audit`) is the only place that would show who or what made them.

audit-fleet-ops left this feature with the runner protocol routes, the fleet system writers, job placement, the key a scheduled fire records under, the closes a decide request commits on its way to a 409, and the test hooks.

**Rulings that bind this feature** (user, 2026-10-24):
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The runner is actor type `RUNNER` (its runner id)**, not `SYSTEM`. `ActionContextInterceptor` already gives a runner request that actor and origin `runner`.
- **The coverage guard and the walker test belong to audit-integrations.** This feature does not add them.

The user skipped the design questions for this feature ("skip questions and proceed, you make the call", 2026-10-25). Every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Runner traffic records only state changes.** A job transition, a bash ask opened, a `READOPT` queued after a reboot, an enrollment, a bundle stored. Heartbeats, command delivery, acks that change nothing, log chunks, event rows, cost mirrors and fences record nothing (see the Bookkeeping table). This follows the audit-fleet-routes call "audited only where they change state".
- **A system writer records under its own catalog key; the summary names the event.** `BudgetSweeper` and `BudgetEvaluator` both belong to the `system.budget.window-reset` family, so an orphan delete, a window reset, a warn, a hard stop and placement's pause-cancel all record `system.budget.window-reset` and differ by summary. Adding a catalog key per event would change the inventory TSV, `NEW_KEY_SCOPES` in `catalog.spec.ts` and the role-matrix snapshot. This is the same pattern as audit-fleet-ops' `fleet.schedule.update` for enable and disable.
- **An entry under a `system.*` key always carries that component's actor.** The actor is `SYSTEM/<id>`, where `<id>` is the key's second segment (`system.approval.expire` → `approval`). It holds even when a request, a runner sync or another component triggered the write. Such a write calls `runAsSystem('<id>', () => this.audit.record(...))`, and in the schedule case passes the owner as `onBehalfOf`. `runAsSystem` inherits the enclosing context's `correlationId`, so the entry still joins the request that caused it. The domain write keeps its own context; only the entry's actor changes. Where the writer already runs as that component (a sweeper's `tick`, the ingest drain, the knowledge drain), it calls `record` or `audited` directly.
- **Runner-reported transitions record `runner.sync`.** `JobReportProcessor` and `CommandAckProcessor` record after each `JobTransitionsService.apply`, with the summary `<FROM> -> <TO>` (the job's state before and after). `JobTransitionsService` itself does not record: audit-fleet-routes already records `fleet.job.cancel` and `fleet.job.requeue` around its route calls, and a recording in `apply` would double them.
- **A reboot records once per reconcile that writes its activity row.** `CommandAckProcessor.reconcileBoot` records `runner.sync` on the runner when it writes `runner.rebooted`, with summary `rebooted, <n> readopts queued` (or `<n> readopts queued` when the boot id did not change).
- **The enroll entry is the new runner's.** `POST /fleet/runner/enroll` is `@Public`, so its request context is `SYSTEM/anonymous`. `EnrollmentService.enroll` records `runner.enroll` inside `runWithActionContext({ actor: { type: 'RUNNER', id: created.id }, origin: 'runner' }, ...)`, so the entry names the runner that enrolled.
- **Placement's assignments are not recorded; its pause-cancels are.** Assigning a `QUEUED` job to a runner is the scheduler's mechanics. The dispatch entry already records who asked for the job, and the runner's `ASSIGNED -> RUNNING` entry records which runner took it. Cancelling a `QUEUED` job because its budget scope is paused is a state change nobody asked for, so `PlacementService.cancelForPause` records it.
- **A scheduled fire records `system.schedule.dispatch`.** `FleetJobsService.dispatch`'s `opts.auditKey` union gains `'system.schedule.dispatch'`, and `ScheduleTicker.dispatchFresh` passes it. The fire records one entry under that key, as `SYSTEM/schedule` on the owner's behalf, and no `fleet.job.dispatch` entry beside it. A coalesce and an auto-disable record the same key on the schedule. A skip records nothing; neither does `linkDispatched` (the pointer and its activity row), because the dispatch entry covers the fire. An auto-disable for `owner_lost_access` is decision 7's "the refusal recorded".
- **The fire test hook records its own entry.** `POST /fleet/test-hooks/schedules/:id/fire` records `testhook.schedule.fire` on the schedule, as the caller, through `audited` with a callback that writes nothing, before it runs the tick. The tick's own entries follow under the rules above. `PUT /fleet/test-hooks/repos/:repoId/nax-files` writes no row (it fills the in-memory fake reader) and records nothing.
- **Expiry closes record in the shared closer, so a sweeper and a decide record the same way.** `ApprovalCloser.expire` (called by `ApprovalExpirySweeper` and by a bash decide past `expiresAt`) records `system.approval.expire`. `AssistantActionDecisions.expireLocked` (called by `PendingActionExpirySweeper` and by an assistant decide past `expiresAt`) records `system.assistant-action.expire`. The bash decide's job-end close (`resolvedBy: 'job_ended'`, `approvals.service.ts:172`) records `system.approval.expire` in `ApprovalsService.decideBash`. The decide then refuses with 409 as today; the close and its entry have already committed.
- **A bash ask opened by a runner records in `ApprovalCloser.openBash`.** Only `openBash` knows whether it created the row: it returns an existing ask unchanged. It records `runner.sync` on the new approval after creating it (after the resolve, for an ask born closed, so the summary carries the stored status), and not on the existing-ask return. A close of a job's asks when the job leaves `RUNNING` (`closeForJob`) is in the transition's transaction and is covered by the transition's entry.
- **The ingest drain records on its write transaction only.** `BundleIngestService.write` records `system.ingest.drain` on the job. A claim, a retry mark, a failure mark and an expired-bundle failure are the ingest queue's bookkeeping.
- **A knowledge pass records once, when it completes.** A pass that only moves the head (no file written or deleted) still records, with `indexed 0 changed, 0 removed`, because it changed the stored `indexedSha`. `KnowledgeRepoIndexer.indexRepo` runs its final idle `finish` (`knowledge-repo-indexer.ts:142`) inside `audit.audited`, with summary `indexed <changed> changed, <removed> removed`. A skipped, unchanged, busy or failed pass, and the claim, renew and per-file rows of any pass, are bookkeeping. An outcome pass (`indexOutcomes`) writes only the LanceDB table, not Postgres, and records nothing.
- **A thread turn records once, at its `turn_end`.** `PrismaThreadIngestRepository.fold` records `system.thread.ingest` on the thread for each `turn_end` line it folds (not skipped), with summary `turn ended <status>`. Text deltas, tool lines, usage, questions, session and write lines, and the cursor are the transcript's bookkeeping.
- **The enrollment purge records one entry per run that deleted rows.** `EnrollmentRetentionProcessor` runs `deleteSpentEnrollmentsBefore` inside `audit.audited`, whose `entriesOf` returns `[]` when the count is 0.
- **The PR refresher records only its own link update.** `FleetPrStateRefresher.apply` runs `updateTicketLinkWithPrState` inside `audit.audited` and records when it returned `'updated'`. The merged path calls `VcsPrSyncService.applyMergedPr`, a VCS writer (`system.vcs.pr-merge-transition`), which audit-integrations records.
- **`AuditRecorder` is a required constructor dependency, last.** The exceptions: `CommandAckProcessor`'s last parameter is the optional `threadEffects`, and `KnowledgeRepoIndexer`'s last is the defaulted `clock`. In both, `AuditRecorder` goes right before that parameter. Classes that already inject it (`EnrollmentService`, `ApprovalsService`, `AssistantActionDecisions`, `FleetJobsService`) reuse their `this.audit`.
- **`projectId` is the row's project.** A job's, an approval's, a budget policy's (`null` for a global or runner policy), a schedule's, a thread's, a ticket link's ticket's, a repo's. A runner and an enrollment purge have no project (`null`).

### The summary and resource contract

| Write | Key | `resourceType` | `resourceId` | `projectId` | `summary` |
|:--|:--|:--|:--|:--|:--|
| job transition reported by the runner | `runner.sync` | `fleet-job` | job id | job's project | `<FROM> -> <TO>` (e.g. `ASSIGNED -> RUNNING`) |
| job transition from a command ack (`ASSIGN` or `CANCEL` rejected, `READOPT` rejected) | `runner.sync` | `fleet-job` | job id | job's project | `<FROM> -> <TO>` |
| boot reconcile that writes `runner.rebooted` | `runner.sync` | `fleet-runner` | runner id | `null` | `rebooted, <n> readopts queued`, or `<n> readopts queued` |
| bash ask opened by a runner report | `runner.sync` | `fleet-approval` | approval id | job's project | `bash ask opened, <status>` (`pending`, or `cancelled` / `expired` for an ask born closed) |
| runner enroll | `runner.enroll` | `fleet-runner` | new runner id | `null` | `enrolled from enrollment <enrollmentId>` |
| bundle upload | `runner.bundle.upload` | `fleet-job` | job id | job's project | `bundle uploaded at epoch <E>`, or `bundle replaced at epoch <E>` when the epoch already had one |
| silent runner's job crashed | `system.job.crash-silent-runner` | `fleet-job` | job id | job's project | `<FROM> -> CRASHED` |
| placement cancels a job in a paused scope | `system.budget.window-reset` | `fleet-job` | job id | job's project | `QUEUED -> CANCELLED: budget <policyId> paused` |
| bundle ingested | `system.ingest.drain` | `fleet-job` | job id | job's project | `ingested done`, or `ingested partial` |
| orphan budget policy deleted | `system.budget.window-reset` | `fleet-budget` | policy id | policy's project | `deleted: scope gone` |
| monthly pause cleared | `system.budget.window-reset` | `fleet-budget` | policy id | policy's project | `window reset` |
| budget warn incident | `system.budget.window-reset` | `fleet-budget` | policy id | policy's project | `warn incident` |
| budget hard stop | `system.budget.window-reset` | `fleet-budget` | policy id | policy's project | `hard stop: <c> cancelled, <r> cancel requested` |
| bash ask expired (sweeper or decide) | `system.approval.expire` | `fleet-approval` | approval id | approval's project | `expired` |
| bash ask closed at decide, job ended | `system.approval.expire` | `fleet-approval` | approval id | approval's project | `closed: job ended` |
| assistant action expired (sweeper or decide) | `system.assistant-action.expire` | `fleet-approval` | approval id | approval's project | `expired` |
| scheduled fire | `system.schedule.dispatch` | `fleet-job` | job id | job's project | the dispatch summary of audit-fleet-routes (`RUN on repo <repoId>, schedule <scheduleId>`) |
| scheduled fire coalesced | `system.schedule.dispatch` | `fleet-schedule` | schedule id | schedule's project | `coalesced into job <jobId>` |
| schedule auto-disabled by the ticker | `system.schedule.dispatch` | `fleet-schedule` | schedule id | schedule's project | `disabled: <reason>` (`owner_lost_access`, `template_invalid`) |
| fire test hook | `testhook.schedule.fire` | `fleet-schedule` | schedule id | schedule's project | `fired` |
| job logs expired | `system.log.retention` | `fleet-job` | job id | the locked job's `projectId` (a retention candidate carries none) | `logs expired through epoch <E>` |
| spent enrollments purged | `system.enrollment.retention` | `fleet-enrollment` | `all` | `null` | `purged <n> spent enrollments` |
| fleet PR link state refreshed | `system.ticket-link.pr-refresh` | `ticket-link` | link id | ticket's project | `pr <before> -> <after>` (`none` when the link had no state) |
| knowledge index pass completed | `system.knowledge.index` | `fleet-repo` | repo id | repo's project | `indexed <changed> changed, <removed> removed` |
| thread turn ended | `system.thread.ingest` | `thread` | thread id | thread's project | `turn ended <status>` (any `TURN_END_STATUSES` value: `completed`, `cancelled`, `errored`, `timed_out`, `interrupted`) |

`<FROM>`, `<TO>` are `FleetJobState` values. `<E>` is the lease epoch. `<status>`, `<reason>` and the PR states are stored enum values. `<c>` and `<r>` are the lengths of `cancelForBudget`'s `cancelled` and `requested` lists. `<changed>` counts the files the pass wrote or deleted because their blob changed or vanished from the tree; `<removed>` counts files deleted because they left the selection. The table never prints a reason text a runner sent, a cost, a path or a label.

Every `system.*` row's actor is `SYSTEM` with the key's second segment as id, and origin `system`. Every `runner.*` row's actor is `RUNNER` with the runner's id, and origin `runner`. The schedule rows carry `onBehalfOf` the schedule's owner. The test hook's actor is the caller.

### The writers

| Story | Service.method | Today | Change |
|:--|:--|:--|:--|
| US-001 | `JobReportProcessor.applyOne` | inside `process`'s `txManager.run`, `job-report.processor.ts:116` | `record` after the `transitions.apply` |
| US-001 | `CommandAckProcessor.processOne` | inside `process`'s per-ack `txManager.run`, `command-ack.processor.ts:39` | `record` after each of the three `transitions.apply` calls |
| US-001 | `CommandAckProcessor.reconcileBoot` | `txManager.run`, `:111` | `record` next to the `runner.rebooted` activity row |
| US-002 | `EnrollmentService.enroll` | `txManager.run`, `enrollment.service.ts:59` | `record` inside, as the new runner |
| US-002 | `BundleService.upload` | `txManager.run`, `bundle.service.ts:69` | `record` inside, after the activity row |
| US-003 | `FleetSweeper.crashSilent` | per-job `txManager.run`, `fleet-sweeper.ts:60` | `record` after the `transitions.apply` |
| US-003 | `PlacementService.cancelForPause` | inside `placeJob`'s, `fillRunner`'s and `fillRunnerThreads`' transactions, `placement.service.ts:184` | `record` as `SYSTEM/budget` after the `transitions.apply` |
| US-003 | `BundleIngestService.write` | `txManager.run`, `bundle-ingest.service.ts:91` | `record` inside, after `markOutcome` |
| US-004 | `BudgetSweeper.deleteOrphan`, `resetWindow` | `txManager.run`, `budget-sweeper.ts:85`, `:100` | `record` inside, after the activity row |
| US-004 | `BudgetEvaluator.warn`, `hardStop` | inside `evaluate`'s `txManager.run` (`budget-evaluator.ts:77`) | `record` as `SYSTEM/budget` after the activity row (`warn` only when it inserted the incident) |
| US-005 | `ApprovalCloser.openBash` | inside the report transaction, `approval-closer.ts:120` | `record` after creating the row (after its resolve for an ask born closed), not on the existing-ask return |
| US-005 | `ApprovalCloser.expire` | inside the caller's transaction, `:174` | `record` as `SYSTEM/approval` |
| US-005 | `ApprovalsService.decideBash` (job-end close) | `txManager.run` (`approvals.service.ts:160`), the job-ended `resolve` at `:172` | `record` as `SYSTEM/approval` after the resolve |
| US-005 | `AssistantActionDecisions.expireLocked` | inside the caller's transaction, `assistant-action-decisions.ts:105` | `record` as `SYSTEM/assistant-action` |
| US-006 | `ScheduleTicker.dispatchFresh` | `jobs.dispatch` in `runAsSystem('schedule', …, { onBehalfOf: owner })`, `schedule-ticker.ts:140` | passes `auditKey: 'system.schedule.dispatch'` |
| US-006 | `ScheduleTicker.fire` (coalesce) | `coalesceIntoQueued` then the activity row, no transaction, `:130` | both inside `txManager.run`, then `record` as `SYSTEM/schedule` on the owner's behalf when a job absorbed the fire |
| US-006 | `ScheduleTicker.disable` | `txManager.run(() => progress.disable(...))`, `:205` | `record` as `SYSTEM/schedule` on the owner's behalf when `disable` returned `true` |
| US-006 | `FleetTestHooksController.fire` | `ticker.tick(at)` | `audit.audited` with a callback that writes nothing, then the tick |
| US-007 | `FleetLogRetentionProcessor.expireJob` | `txManager.run`, `fleet-log-retention.processor.ts:84` | `record` inside, when the job row was locked |
| US-007 | `EnrollmentRetentionProcessor.purgeSpentEnrollments` | one `deleteSpentEnrollmentsBefore`, no transaction, `enrollment-retention.processor.ts:36` | the call inside `audit.audited`, `[]` when it returned 0 |
| US-007 | `FleetPrStateRefresher.apply` (non-merge path) | one `updateTicketLinkWithPrState`, no transaction, `fleet-pr-state.refresher.ts:142` | the call inside `audit.audited`, `[]` unless it returned `'updated'` |
| US-008 | `KnowledgeRepoIndexer.indexRepo` | the final idle `finish`, `knowledge-repo-indexer.ts:142` | that `finish` inside `audit.audited` |
| US-008 | `PrismaThreadIngestRepository.fold` | `txManager.run`, `prisma-thread-ingest.repository.ts:74` | `record` as `SYSTEM/thread` per folded `turn_end` |

### Bookkeeping writes (record nothing)

This list is the input for audit-integrations' coverage-guard allowlist; this feature does not build the guard.

| Write | Where |
|:--|:--|
| runner heartbeat (`lastSeenAt`, boot id, versions, capabilities) | `IFleetJobRepository.recordRunnerSync` in `SyncService.sync` |
| command delivery (`deliveredAt`) | `SyncService.deliver` |
| a command ack that changes no job (`ackCommand`, `APPROVAL_ANSWER` delivery outcome, `READOPT` ok, thread input acks, stale acks) | `CommandAckProcessor.processOne` |
| runner event rows, `ackedRunnerSeq`, `snapshot` cost/progress mirrors, rejected events (activity row only) | `JobReportProcessor` |
| a fence's `ABANDON` command and its activity row | `FenceService.abandon` |
| the boot reconcile's `runnerBootId` update for a job with a pending `ASSIGN` | `CommandAckProcessor.reconcileBoot` |
| placement's assignment (`casAssign`, `ASSIGN` command, thread runner pin, `job.assigned` row) | `PlacementService.assign` |
| log chunk appends (`FleetJobLog` size and flags) | `LogUploadService.write` |
| thread transcript batches without a `turn_end`, and the ingest cursor | `PrismaThreadIngestRepository.fold` |
| ingest queue claims, retries and failure marks | `BundleIngestService.ingestOne`, `recordFailure` |
| a schedule's fire claim (`nextFireAt`), a skip's activity row, `linkDispatched` | `ScheduleTicker` |
| knowledge pass claims, lease renewals, per-file rows, and the `finish` of a skipped, unchanged or failed pass | `KnowledgeRepoIndexer.indexRepo` |
| the PR attribution claim (`claimAttribution`) | `PrAttributionService.attribute` |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `record` rejects inside a writer's transaction | the transaction rolls back with the domain rows and the writer's existing error path runs: a sync logs and skips that job or ack; `BudgetSweeper`, `ApprovalExpirySweeper`, `PendingActionExpirySweeper`, `ScheduleTicker`, `FleetLogRetentionProcessor` and `FleetPrStateRefresher` log and skip that row; `EnrollmentRetentionProcessor` logs and resolves; the ingest drain marks the row for retry; `FleetSweeper.sweep` and a direct `BudgetEvaluator.evaluate` reject (no per-row catch today); a request returns an error status; a thread fold falls back to its line-by-line retry; a knowledge pass returns `failed` | US-001 to US-008 |
| a runner resends events already applied | no transition runs; no new entry | US-001 |
| a runner reports a transition the state table refuses | the `job.event_rejected` activity row only; no entry | US-001 |
| a runner request on a stale lease | `ABANDON` queued (bookkeeping); no entry | US-001, US-002 |
| an enroll with a used, wrong or expired token | 401; no entry | US-002 |
| an enroll with a taken runner name | 409; no entry; the token stays usable | US-002 |
| a bundle upload for a job not `RUNNING` or `UPLOADING` | 409; no entry | US-002 |
| the sweeper's runner was seen within the crash cutoff | no transition; no entry | US-003 |
| an evaluation that inserts no incident and does not stop | no entry | US-004 |
| a hard stop of a policy already paused | no write; no entry | US-004 |
| a runner resends an ask already stored | `openBash` returns the existing row; no entry | US-005 |
| a decide finds the ask expired or its job ended | the close and its `system.approval.expire` entry commit; 409 `fleet.approvalNotPending`; no `fleet.approval.decide.bash` entry | US-005 |
| a decide finds the assistant action expired | the expiry and its `system.assistant-action.expire` entry commit; 409; no `fleet.approval.decide.assistant` entry | US-005 |
| a tick finds the schedule's job running | `schedule.tick_skipped` activity only; no entry | US-006 |
| the fire test hook is off, the schedule unknown or disabled | 404 / 404 / 409; no entry | US-006 |
| a retention or purge run with nothing to delete | no entry | US-007 |
| the PR state did not change, or the link is already merged | no entry | US-007 |
| a knowledge pass that is skipped, unchanged or busy, or fails before its idle finish | no entry; a failure after the idle finish (`rag.optimizeTable`) keeps the committed entry and the catch restores `indexedSha` | US-008 |
| a knowledge pass that moves the head but changes no file | the idle finish records `indexed 0 changed, 0 removed` (the stored `indexedSha` changed) | US-008 |

### Integration

Verified at main `407c36d0`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input)` and `AuditRecorder.audited(fn, entriesOf)` (`entriesOf` may return `[]`), `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. `record` throws for a key outside the catalog and outside a transaction, and reads the actor, `onBehalfOf`, origin and correlation id from `currentContext()`.
- `runAsSystem(component, fn, opts?)`, `runWithActionContext(input, fn)`, `SYSTEM_ACTOR_IDS` — `src/action-context/action-context.ts`. `runAsSystem` refuses an id outside `SYSTEM_ACTOR_IDS` and sets origin `system`; every id this feature uses (`job`, `budget`, `ingest`, `approval`, `assistant-action`, `schedule`, `log`, `enrollment`, `ticket-link`, `knowledge`, `thread`) is the second segment of a `system.*` catalog key.
- `ActionContextInterceptor` gives a runner request `{ type: 'RUNNER', id }` and origin `runner`, and a public request `SYSTEM/anonymous` — `src/action-context/action-context.interceptor.ts`.
- `mockAuditRecorder` — `src/common/test-helpers/global-stubs.module.ts`. `GlobalStubsModule` provides it as `AuditRecorder`, so the module specs (`fleet.module.spec.ts`, `ingest.module.spec.ts`, `budgets.module.spec.ts`, `schedules.module.spec.ts`, `approval-store.module.spec.ts`, `knowledge.module.spec.ts`, `thread-ingest.module.spec.ts`, `fleet-tickets.module.spec.ts`) keep compiling.
- `AuditLogModule` is `@Global()`, so every fleet module resolves `AuditRecorder` without importing it.
- Every key in the contract table is in `PERMISSION_CATALOG` (`src/permissions/catalog.ts`).
- `JobTransitionsService.apply` and `record` — `src/fleet/jobs/job-transitions.service.ts`; unchanged.
- `withTestActor(actor, fn)`, `fixtureDb(app)`, `expectGuardActive(app)` — `test/helpers/action-context.ts`; `bootHttpApp`, `data`, `resetThrottle` — `test/helpers/http-app.ts`; `seedFleetHttpWorld`, `seedFleetBase`, `insertRunner`, `enrollRunner`, `syncBody` — `test/helpers/fleet-fixtures.ts`; `seedThreadJob`, `putThreadLines` — `test/helpers/thread-fixtures.ts`; `tarGz` — `test/helpers/tar-gz.ts`.
- Test precedent: `test/integration/fleet/runner-sync-lifecycle.integration.spec.ts`, `runner-sync.integration.spec.ts`, `runner-enrollment.integration.spec.ts`, `fleet-bundles.integration.spec.ts`, `fleet-sweep.integration.spec.ts`, `fleet-budget-placement.integration.spec.ts`, `fleet-ingest.integration.spec.ts`, `fleet-budget-sweeper.integration.spec.ts`, `fleet-budget-evaluator.integration.spec.ts`, `fleet-approval-relay.integration.spec.ts`, `assistant-actions-expiry.integration.spec.ts`, `fleet-schedule-ticker.integration.spec.ts`, `fleet-log-retention.integration.spec.ts`, `fleet-pr-refresher.integration.spec.ts`, `thread-assistant-lifecycle.integration.spec.ts`, `test/integration/audit/audit-fleet-approvals.integration.spec.ts`, and the unit spec `src/fleet/knowledge/knowledge-repo-indexer.spec.ts`.

Changed (baseline → target):
- `FleetJobsService.dispatch` — Baseline: `opts.auditKey?: 'fleet.job.dispatch' | 'thread.plan' | 'thread.run'`. Target: `opts.auditKey?: 'fleet.job.dispatch' | 'thread.plan' | 'thread.run' | 'system.schedule.dispatch'`.
- The constructors of `JobReportProcessor`, `CommandAckProcessor`, `BundleService`, `FleetSweeper`, `PlacementService`, `BundleIngestService`, `BudgetSweeper`, `BudgetEvaluator`, `ApprovalCloser`, `ScheduleTicker`, `FleetTestHooksController`, `FleetLogRetentionProcessor`, `EnrollmentRetentionProcessor`, `FleetPrStateRefresher`, `KnowledgeRepoIndexer` and `PrismaThreadIngestRepository` — Baseline: no `AuditRecorder`. Target: a required `AuditRecorder`, last (before the optional `threadEffects` in `CommandAckProcessor`, before the defaulted `clock` in `KnowledgeRepoIndexer`).

## Out of Scope

- Recording placement's assignments (`PlacementService.assign` through `placeJob`, `fillRunner` and `fillRunnerThreads`) is out of scope; the dispatch entry and the runner's `ASSIGNED -> RUNNING` entry cover who asked for the job and which runner took it.
- Recording the writes in the Bookkeeping table is out of scope; they are the input for audit-integrations' coverage-guard allowlist.
- The runner tool route (`POST /fleet/runner/jobs/:jobId/tools/:name`) is out of scope: its `AssistantToolCall` row is the call's bookkeeping, the tools' writes are recorded by the services audit-core and audit-fleet-routes audit, and the tools that reach no audited service are audit-integrations'.
- `FleetJobTicketEffects` (the failure comment and the PR link written after a job ends, and the late PR link after an ingest) is out of scope (feature `permissions-p2-audit-integrations`); these are ticket writes with no fleet system key.
- `VcsPrSyncService.applyMergedPr`, which the PR refresher calls for a merged PR, is out of scope (feature `permissions-p2-audit-integrations`, with the other VCS writers).
- Every non-fleet system writer (email, outbox, notifications, memory, RAG, entity graph, code intel, VCS, CI, webhook delivery) is out of scope (feature `permissions-p2-audit-integrations`).
- `KnowledgePoller` writes no row (it only enqueues) and records nothing; outcome passes (`indexOutcomes`) write only LanceDB and record nothing.
- Recording a close inside a transition's or an action's own transaction (`closeForJob` when a job leaves `RUNNING`, `closeForPolicy` in a budget delete, reset or hard stop, `cancelForBudget`'s cancels in a hard stop, `ScheduleProgressService` counters and auto-disables when a scheduled job ends) is out of scope; the entry of that transaction covers it, as audit-core's rule says.
- Adding catalog keys (one per system event) is out of scope; each writer records under its existing `system.*` key and the summary names the event.
- Changing `JobTransitionsService`, `FleetActivityService`, `FleetJobEvent`, outbox payloads or any activity row's shape is out of scope.
- Recording refused or failed attempts (401, 403, 404, 409, validation errors, rejected runner events) is out of scope; only committed writes are recorded, and refusal records belong to P3's approval engine.
- Putting a runner-sent reason or detail text, a cost or amount, a file path, a label, a PR URL or a log line into an audit summary is out of scope; summaries carry only the states, ids, epochs, counts and enum values in the contract table.
- Naming an ingest's verdict correction (`job.verdict_corrected`) in the `system.ingest.drain` summary is out of scope; the correction commits in the same transaction and is covered by that entry, whose summary stays `ingested done` or `ingested partial`.
- Deleting the stored bundle file when `BundleService.upload`'s transaction throws (a rejected `record`, or any other error after `store.put`) is out of scope; the file stays until log retention removes it, as it does today for any throw in that transaction.
- A before/after diff of values in `AuditEntry` is out of scope.
- Changing any route's status codes, response bodies or `@Requires` keys is out of scope; `openapi.json` does not change.
- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-integrations`).
- The web Audit log page is out of scope (feature `permissions-p2-web`).

## Stories

1. **US-001: Runner-reported job transitions and the boot reconcile are audited** — `Workdir: apps/api` — No dependencies. `JobReportProcessor` and `CommandAckProcessor` record `runner.sync` for each transition and for a reconcile that queues `READOPT`s.
2. **US-002: Runner enroll and bundle upload are audited** — `Workdir: apps/api` — No dependencies. `EnrollmentService.enroll` records `runner.enroll` as the new runner; `BundleService.upload` records `runner.bundle.upload`.
3. **US-003: Server-side job transitions and the ingest drain are audited** — `Workdir: apps/api` — No dependencies. `FleetSweeper`, `PlacementService.cancelForPause` and `BundleIngestService.write`.
4. **US-004: Budget sweeps and evaluations are audited** — `Workdir: apps/api` — No dependencies. `BudgetSweeper`'s orphan delete and window reset, `BudgetEvaluator`'s warn and hard stop, always as `SYSTEM/budget`.
5. **US-005: Bash asks opened, approval expiries and job-end closes are audited** — `Workdir: apps/api` — No dependencies. `ApprovalCloser.openBash` and `expire`, `ApprovalsService.decideBash`'s job-end close, `AssistantActionDecisions.expireLocked`.
6. **US-006: Scheduled fires, coalesces, auto-disables and the fire test hook are audited** — `Workdir: apps/api` — No dependencies. `ScheduleTicker` and `FleetTestHooksController`; `FleetJobsService.dispatch`'s `auditKey` union gains `system.schedule.dispatch`.
7. **US-007: Log retention, enrollment retention and the PR refresher are audited** — `Workdir: apps/api` — No dependencies. `FleetLogRetentionProcessor.expireJob`, `EnrollmentRetentionProcessor` and `FleetPrStateRefresher.apply`.
8. **US-008: Knowledge index passes and thread turn ends are audited** — `Workdir: apps/api` — No dependencies. `KnowledgeRepoIndexer.indexRepo` and `PrismaThreadIngestRepository.fold`.

Eight stories, one capability: every story wires the same recorder into a different set of runner-protocol or system writers, and none is useful as a separate PR. They touch disjoint files, so none depends on another.

### Context Files

**US-001**
- `apps/api/src/fleet/sync/job-report.processor.ts`
- `apps/api/src/fleet/sync/command-ack.processor.ts`
- `apps/api/src/fleet/sync/sync.service.ts`
- `apps/api/test/integration/fleet/runner-sync-lifecycle.integration.spec.ts`
- `apps/api/test/integration/fleet/runner-sync.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/runners/enrollment.service.ts`
- `apps/api/src/fleet/artifacts/bundle.service.ts`
- `apps/api/test/integration/fleet/runner-enrollment.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/sync/fleet-sweeper.ts`
- `apps/api/src/fleet/jobs/placement.service.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/test/integration/fleet/fleet-sweep.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-budget-placement.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/budgets/budget-sweeper.ts`
- `apps/api/src/fleet/budgets/budget-evaluator.ts`
- `apps/api/test/integration/fleet/fleet-budget-sweeper.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-budget-evaluator.integration.spec.ts`

**US-005**
- `apps/api/src/fleet/approvals/approval-closer.ts`
- `apps/api/src/fleet/approvals/approvals.service.ts`
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts`
- `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts`
- `apps/api/test/integration/fleet/assistant-actions-expiry.integration.spec.ts`

**US-006**
- `apps/api/src/fleet/schedules/schedule-ticker.ts`
- `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts`

**US-007**
- `apps/api/src/fleet/logs/fleet-log-retention.processor.ts`
- `apps/api/src/fleet/runners/enrollment-retention.processor.ts`
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts`
- `apps/api/test/integration/fleet/fleet-log-retention.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-pr-refresher.integration.spec.ts`

**US-008**
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts`
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts`
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts`
- `apps/api/test/integration/fleet/thread-assistant-lifecycle.integration.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-fleet-runner-sync.integration.spec.ts`

**US-002**
- `apps/api/test/integration/audit/audit-fleet-runner-enroll-bundle.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-fleet-system-jobs.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-fleet-system-budgets.integration.spec.ts`

**US-005**
- `apps/api/test/integration/audit/audit-fleet-system-approvals.integration.spec.ts`

**US-006**
- `apps/api/test/integration/audit/audit-fleet-system-schedules.integration.spec.ts`

**US-007**
- `apps/api/test/integration/audit/audit-fleet-system-retention.integration.spec.ts`

**US-008**
- `apps/api/test/integration/audit/audit-fleet-system-thread-ingest.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/sync/job-report.processor.ts` — injects AuditRecorder as the last constructor parameter and records runner.sync on the job after each transition applyOne applies; dedup, fencing, mirrors, rejected events and the ack are unchanged.
- `apps/api/src/fleet/sync/job-report.processor.spec.ts` — its direct new JobReportProcessor(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/sync/command-ack.processor.ts` — injects AuditRecorder right before the optional threadEffects parameter, records runner.sync on the job after each of processOne's three transitions, and on the runner when reconcileBoot writes its runner.rebooted row; acks that change no job are unchanged.
- `apps/api/src/fleet/sync/command-ack.processor.spec.ts` — its direct new CommandAckProcessor(...) passes mockAuditRecorder (from global-stubs.module.ts) right before the threadEffects argument; the existing assertions are kept.

**US-002**
- `apps/api/src/fleet/runners/enrollment.service.ts` — records runner.enroll inside enroll's transaction after the activity row, within runWithActionContext with the new runner as RUNNER actor and origin runner; the token checks and the response are unchanged.
- `apps/api/src/fleet/runners/enrollment.service.spec.ts` — gains the US-002 AC-12 case (enroll records as the new runner); the existing assertions are kept.
- `apps/api/src/fleet/artifacts/bundle.service.ts` — injects AuditRecorder as the last constructor parameter and records runner.bundle.upload inside upload's transaction after the activity row; the fence, the state check, the ingest enqueue and the kick are unchanged.
- `apps/api/src/fleet/artifacts/bundle.service.spec.ts` — its direct new BundleService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-003**
- `apps/api/src/fleet/sync/fleet-sweeper.ts` — injects AuditRecorder as the last constructor parameter and records system.job.crash-silent-runner inside the per-job transaction after the transition; the scan, the re-check and the post-commit effects are unchanged.
- `apps/api/src/fleet/sync/fleet-sweeper.spec.ts` — its direct new FleetSweeper(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/placement.service.ts` — injects AuditRecorder as the last constructor parameter and records system.budget.window-reset as SYSTEM/budget in cancelForPause after the transition; assignments record nothing and are unchanged.
- `apps/api/src/fleet/jobs/placement.service.project-code.spec.ts` — its direct new PlacementService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/placement.service.thread-write.spec.ts` — its direct new PlacementService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/placement.service.project-thread.spec.ts` — its direct new PlacementService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/jobs/placement.service.koda-tools.spec.ts` — its direct new PlacementService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — injects AuditRecorder as the last constructor parameter and records system.ingest.drain inside write's transaction after markOutcome; claims, retries, failures and the post-commit hooks are unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts` — its direct new BundleIngestService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts` — its direct new BundleIngestService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/ingest/bundle-ingest.workflow.spec.ts` — its direct new BundleIngestService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/ingest/bundle-ingest.outcomes.spec.ts` — its direct new BundleIngestService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-004**
- `apps/api/src/fleet/budgets/budget-sweeper.ts` — injects AuditRecorder as the last constructor parameter and records system.budget.window-reset inside deleteOrphan's and resetWindow's transactions after the activity row; evaluation and the approval closes are unchanged.
- `apps/api/src/fleet/budgets/budget-sweeper.spec.ts` — its direct new BudgetSweeper(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/budgets/budget-evaluator.ts` — injects AuditRecorder as the last constructor parameter and records system.budget.window-reset as SYSTEM/budget in warn (when it inserted the incident) and hardStop after the activity row; signal, debounce and webhooks are unchanged.
- `apps/api/src/fleet/budgets/budget-evaluator.spec.ts` — its direct new BudgetEvaluator(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-005**
- `apps/api/src/fleet/approvals/approval-closer.ts` — injects AuditRecorder as the last constructor parameter, records runner.sync in openBash after creating the row (not on the existing-ask return), and records system.approval.expire as SYSTEM/approval in expire; the other closers are unchanged.
- `apps/api/src/fleet/approvals/approval-closer.spec.ts` — its direct new ApprovalCloser(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument, and it gains the US-005 AC-14 case (an existing ask records nothing); the existing assertions are kept.
- `apps/api/src/fleet/approvals/approvals.service.ts` — decideBash records system.approval.expire as SYSTEM/approval after the job-ended resolve; the 409, the decided path and its fleet.approval.decide.bash entry are unchanged.
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — its direct new ApprovalCloser(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — expireLocked records system.assistant-action.expire as SYSTEM/assistant-action after resolving the approval; approve, reject and their entries are unchanged.

**US-006**
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — injects AuditRecorder as the last constructor parameter; dispatchFresh passes auditKey system.schedule.dispatch; the coalesce runs with its activity row in one transaction and records as SYSTEM/schedule on the owner's behalf; disable records likewise when progress.disable returned true; skips record nothing.
- `apps/api/src/fleet/schedules/schedule-ticker.spec.ts` — its direct new ScheduleTicker(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument, and its dispatch expectations name the new auditKey option; the existing assertions are kept otherwise.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — dispatch's opts.auditKey union gains system.schedule.dispatch; the recording itself is unchanged.
- `apps/api/src/fleet/schedules/fleet-test-hooks.controller.ts` — injects AuditRecorder as the last constructor parameter and records testhook.schedule.fire through audit.audited with a callback that writes nothing, after the off, unknown and disabled refusals and before the tick; the response is unchanged.
- `apps/api/src/fleet/schedules/fleet-test-hooks.controller.spec.ts` — its direct new FleetTestHooksController(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-007**
- `apps/api/src/fleet/logs/fleet-log-retention.processor.ts` — injects AuditRecorder as the last constructor parameter and records system.log.retention inside expireJob's transaction when the job row was locked; file deletes and batching are unchanged.
- `apps/api/src/fleet/logs/fleet-log-retention.processor.spec.ts` — its direct new FleetLogRetentionProcessor(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/runners/enrollment-retention.processor.ts` — injects AuditRecorder as the last constructor parameter and runs deleteSpentEnrollmentsBefore inside audit.audited with one system.enrollment.retention entry, none when it deleted 0; the log lines and the swallowed error are unchanged.
- `apps/api/src/fleet/runners/enrollment-retention.processor.spec.ts` — its direct new EnrollmentRetentionProcessor(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts` — injects AuditRecorder as the last constructor parameter and runs apply's updateTicketLinkWithPrState inside audit.audited with one system.ticket-link.pr-refresh entry when it returned updated; the merged path and the knowledge event are unchanged.
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.spec.ts` — its direct new FleetPrStateRefresher(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-008**
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts` — injects AuditRecorder right before the defaulted clock parameter, counts changed and removed files, and runs the final idle finish of indexRepo inside audit.audited with one system.knowledge.index entry; other finishes and indexOutcomes are unchanged.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — its direct new KnowledgeRepoIndexer(...) passes a stub recorder whose audited runs its fn right before the clock argument, and it gains the US-008 AC-10 to AC-14 cases; the existing assertions are kept.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — injects AuditRecorder as the last constructor parameter and records system.thread.ingest as SYSTEM/thread inside fold's transaction for each folded turn_end line; the other lines, the cursor and the live events are unchanged.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.spec.ts` — its direct new PrismaThreadIngestRepository(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/threads/ingest/prisma-thread-cost-review.spec.ts` — its direct new PrismaThreadIngestRepository(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

### Seams

- No story introduces a symbol another story calls. US-006 widens `FleetJobsService.dispatch`'s `auditKey` union, which only `ScheduleTicker` passes the new member to.
- Every story's integration ACs enter through the real wiring of the booted `AppModule`: a runner route over HTTP with the runner's key (US-001, US-002, US-005 AC1, US-008 AC1 to AC7), a decide route over HTTP (US-005), a test-hook route over HTTP (US-006), or the component's own background entry fetched with `app.get` and called the way its timer or cron calls it (`FleetSweeper.sweep`, `BudgetSweeper.tick`, `ApprovalExpirySweeper.tick`, `PendingActionExpirySweeper.tick`, `ScheduleTicker.tick` inside `withTestActor({ type: 'SYSTEM', id: 'schedule' })`, `FleetLogRetentionProcessor.purge` inside `withTestActor({ type: 'SYSTEM', id: 'log' })`, `EnrollmentRetentionProcessor.scheduledPurge`, `FleetPrStateRefresher.refresh`). Each asserts the stored `AuditEntry` row, so it proves the writer reaches the recorder rather than a stub. US-008's knowledge half does the same through `app.get(KnowledgeRepoIndexer).indexRepo` (AC8, AC9); its unit ACs cover the branches that need no real GitHub tree.
- The "triggered from another context" ACs (US-003 AC5, US-004 AC9, US-005 AC6 and AC7, US-006 AC9, US-008 AC1) run the write under a different actor and assert the entry's `SYSTEM` actor, pinning the `runAsSystem` wrap at its call site.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database with `bootHttpApp({ registrationEnabled: false })`, create their fixtures with `seedFleetHttpWorld` (or `seedFleetBase`, where the precedent spec does) and `fixtureDb(app)`, and read `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. `root` is the Owner; `dev` is a `developer` on project `web`. A runner is enrolled with `enrollRunner` (protocol 1) unless the AC names `insertRunner`. A runner sync is `POST /api/fleet/runner/sync` with the runner's key and a `syncBody`, with `FLEET_SYNC_WAIT_MS` set to `800` before boot and restored in `afterAll`, as `runner-sync-lifecycle.integration.spec.ts` does. "Start a job running" is that spec's `startRunning`: dispatch `RUN` as `dev`, take the `ASSIGN` from a sync, ack it and report `{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }`. A spec that enrolls more than one runner, or logs in after the fourth login, calls `resetThrottle(app)` first. Every fixture id is created by the spec itself, so entries from other specs cannot collide. A spec that leaves jobs held moves them to `COMPLETED` in `afterEach`, as the precedent does. A spec that sets a `FLEET_CFG` field (`testHooksEnabled`, `enrollmentRetentionDays`) reads the config with `app.get(FLEET_CFG, { strict: false })`, saves the old value and restores it in `afterAll`. The US-007 enrollment ACs clear every `RunnerEnrollment` row in `beforeEach`, because `deleteSpentEnrollmentsBefore` deletes across the whole table. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource (and key, where named) returns an empty array; "unchanged" compares a `count` taken before and after the call. "Spied to reject" means `vi.spyOn(app.get(AuditRecorder), 'record')` with an implementation that rejects with `new Error('audit down')` the first call whose `input.key` is the key the AC's writer records and delegates every other call to the original, so a background writer (the ingest kick, the debounced budget signal, a thread fold) cannot consume it; the spy is restored after the AC.

### US-001: Runner-reported job transitions and the boot reconcile are audited

1. [integration] After a `RUN` job's `ASSIGN` is acked, a sync reporting `{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }` leaves one entry for the job with `key` `runner.sync`, `resourceType` `fleet-job`, `projectId` web's id, `actorType` `RUNNER`, `actorId` the runner's id, `origin` `runner` and `summary` `ASSIGNED -> RUNNING`.
2. [integration] A sync reporting `{ seq: 2, type: 'state', payload: { to: 'UPLOADING' } }` and `{ seq: 3, type: 'state', payload: { to: 'COMPLETED' } }` for a running job leaves two new `runner.sync` entries for the job, with summaries `RUNNING -> UPLOADING` and `UPLOADING -> COMPLETED`.
3. [integration] Resending AC2's two events with the same seqs and payloads in a later sync leaves the count of `runner.sync` entries for the job unchanged.
4. [integration] A sync reporting a `state` event with `payload: { to: 'QUEUED' }` for a running job (a transition the runner may not make) leaves the job `RUNNING` and the count of `runner.sync` entries for the job unchanged.
5. [integration] A sync reporting a `snapshot` event for a running job, as `fleet-budget-evaluator.integration.spec.ts` reports one, leaves the count of `runner.sync` entries for the job unchanged.
6. [integration] A sync reporting a `state` event for a running job at a lease epoch other than the job's leaves the count of entries for the job unchanged.
7. [integration] A sync acking a job's `ASSIGN` with `result: 'rejected'` leaves the job `FAILED` and one entry for it with `key` `runner.sync` and `summary` `ASSIGNED -> FAILED`.
8. [integration] A sync with `bootId` `boot-2` while the runner holds a `RUNNING` job leaves one entry for the runner's id with `key` `runner.sync`, `resourceType` `fleet-runner`, `projectId` `null`, `actorType` `RUNNER` and `summary` `rebooted, 1 readopts queued`.
9. [integration] A sync acking the `READOPT` that AC8 queued with `result: 'rejected'` leaves the job `CRASHED` and one entry for it with `key` `runner.sync` and `summary` `RUNNING -> CRASHED`.
10. [integration] After a second running job's runner reboots (a sync with `bootId` `boot-3`), a sync acking its `READOPT` with `result: 'ok'` leaves the count of entries for that job unchanged.
11. [integration] A sync with no events, no acks and the runner's current boot id leaves the count of entries with `actorId` the runner's id unchanged.
12. [integration] A sync acking a job's `ASSIGN` with `result: 'rejected'`, while `record` is spied to reject, returns 200 and the job is still `ASSIGNED`.
13. [integration] A sync reporting `{ to: 'RUNNING' }` for an `ASSIGNED` job, while `record` is spied to reject, returns 200 with no `jobAcks` entry for the job, and the job is still `ASSIGNED`.

### US-002: Runner enroll and bundle upload are audited

1. [integration] `POST /api/fleet/runner/enroll` with a fresh enrollment token returns 201 and leaves one entry for the returned `runnerId` with `key` `runner.enroll`, `resourceType` `fleet-runner`, `projectId` `null`, `actorType` `RUNNER`, `actorId` the new runner's id, `origin` `runner` and `summary` `enrolled from enrollment <enrollmentId>`.
2. [integration] `POST /api/fleet/runner/enroll` with a token already used returns 401 and the count of `runner.enroll` entries is unchanged.
3. [integration] `POST /api/fleet/runner/enroll` with a fresh token and a runner name already taken returns 409, the count of `runner.enroll` entries is unchanged, and a second enroll with that token and a free name returns 201.
4. [integration] `POST /api/fleet/runner/enroll` with a fresh token, while `record` is spied to reject, returns an error status, the count of `Runner` rows is unchanged, and the token's `RunnerEnrollment` row has `usedAt` `null`.
5. [integration] `PUT /api/fleet/runner/jobs/:jobId/bundle?leaseEpoch=<E>` with a valid gzip bundle for a job the runner holds `RUNNING` at epoch `<E>` returns 201 and leaves one entry for the job with `key` `runner.bundle.upload`, `resourceType` `fleet-job`, `projectId` web's id, `actorType` `RUNNER`, `actorId` the runner's id, `origin` `runner` and `summary` `bundle uploaded at epoch <E>`.
6. [integration] A second bundle upload for that job at the same epoch leaves a new entry for the job with `key` `runner.bundle.upload` and `summary` `bundle replaced at epoch <E>`.
7. [integration] A bundle upload at an epoch other than the job's returns 409 and the count of `runner.bundle.upload` entries for the job is unchanged.
8. [integration] A bundle upload for a job the runner held that is now `COMPLETED` returns 409 and the count of `runner.bundle.upload` entries for the job is unchanged.
9. [integration] A bundle upload, while `record` is spied to reject, returns an error status and leaves no `FleetJobArtifact` row and no `FleetBundleIngest` row for the job.
10. [integration] `PUT /api/fleet/runner/jobs/:jobId/logs/stdout?leaseEpoch=<E>&offset=0` with one chunk for a running job returns 200 and leaves the count of entries with `actorId` the runner's id unchanged.
11. [integration] `GET /api/fleet/runner/me` with the runner's key returns 200 and leaves the count of entries with `actorId` the runner's id unchanged.
12. [unit] `EnrollmentService.enroll` with stub collaborators, a stub transaction manager whose `run` calls its callback, and a stub recorder whose `record` captures `currentActor()` when called, records once with `key` `runner.enroll`, and the captured actor is `{ type: 'RUNNER', id: <the created runner's id> }`.

### US-003: Server-side job transitions and the ingest drain are audited

1. [integration] `app.get(FleetSweeper).sweep(now)` with a job `RUNNING` on an `insertRunner` runner last seen 301 s before `now` (as `fleet-sweep.integration.spec.ts` sets it up) leaves the job `CRASHED` and one entry for it with `key` `system.job.crash-silent-runner`, `resourceType` `fleet-job`, `projectId` the job's project, `actorType` `SYSTEM`, `actorId` `job`, `origin` `system` and `summary` `RUNNING -> CRASHED`.
2. [integration] A second `sweep(now)` leaves the count of `system.job.crash-silent-runner` entries for that job unchanged.
3. [integration] `sweep(now)` with a job `RUNNING` on a runner last seen 10 s before `now` leaves the job `RUNNING` and no entry for the job.
4. [integration] `sweep(now)` over a silent runner's `RUNNING` job, while `record` is spied to reject, rejects, and the job is still `RUNNING`.
5. [integration] `fillRunner(runnerId, 1)` inside `withTestActor({ type: 'RUNNER', id: runnerId })`, with one `QUEUED` job in a project whose project budget policy is paused (as `fleet-budget-placement.integration.spec.ts` sets it up), leaves the job `CANCELLED` and one entry for it with `key` `system.budget.window-reset`, `actorType` `SYSTEM`, `actorId` `budget` and `summary` `QUEUED -> CANCELLED: budget <policyId> paused`.
6. [integration] `fillRunner(runnerId, 1)` inside `withTestActor({ type: 'RUNNER', id: runnerId })`, with one `QUEUED` job and no paused policy, leaves the job `ASSIGNED` and no entry for the job.
7. [integration] `app.get(BundleIngestService).drain(now)` inside `withTestActor({ type: 'SYSTEM', id: 'ingest' })`, with one pending ingest row of a `COMPLETED` job whose bundle is stored (as `fleet-ingest.integration.spec.ts` sets it up), returns 1 and leaves one entry for the job with `key` `system.ingest.drain`, `resourceType` `fleet-job`, `actorType` `SYSTEM`, `actorId` `ingest` and `summary` `ingested done`.
8. [integration] `drain(now)` with no claimable ingest row returns 0 and leaves the count of `system.ingest.drain` entries unchanged.
9. [integration] `drain(now)` for a pending row whose artifact has `expiredAt` set leaves the row `failed` and no `system.ingest.drain` entry for the job.
10. [integration] `drain(now)` over one pending row, while `record` is spied to reject, leaves the row's `status` not `done` and its `attempts` 1.
11. [integration] AC5's `fillRunner`, while `record` is spied to reject, rejects, and the job is still `QUEUED`.

### US-004: Budget sweeps and evaluations are audited

1. [integration] `app.get(BudgetSweeper).tick(now)` with a `runner`-scope policy whose runner row was deleted (as `fleet-budget-sweeper.integration.spec.ts` sets up an orphan) returns `deleted: 1` and leaves one entry for the policy's id with `key` `system.budget.window-reset`, `resourceType` `fleet-budget`, `projectId` `null`, `actorType` `SYSTEM`, `actorId` `budget`, `origin` `system` and `summary` `deleted: scope gone`.
2. [integration] `tick(now)` with a `calendar_month_utc` project policy paused in the previous month's window returns `reset: 1` and leaves one entry for the policy with `key` `system.budget.window-reset`, `projectId` the policy's project and `summary` `window reset`.
3. [integration] `tick(now)` over a policy whose scope exists, which is not paused and whose spend reaches neither its warn nor its amount, leaves no entry for the policy.
4. [integration] `evaluate(policyId)` inside `withTestActor({ type: 'SYSTEM', id: 'budget' })` on a project policy with `warnPercent` 50, `amountUsd` 10 and `hardStop` `false`, over a `COMPLETED` job of that project with `costSpentUsd` 6 started in the window (as `fleet-budget-evaluator.integration.spec.ts` sets spend), leaves one entry for the policy with `summary` `warn incident`.
5. [integration] A second `evaluate(policyId)` of AC4's policy leaves the count of `warn incident` entries for the policy unchanged.
6. [integration] `evaluate(policyId)` on a project policy with `amountUsd` 5, `warnPercent` `null` and `hardStop` `true`, over spend of 6 from a `COMPLETED` job and one `QUEUED` job of the project (no job held by a runner), pauses the policy, cancels the job, and leaves one entry for the policy with `summary` `hard stop: 1 cancelled, 0 cancel requested`.
7. [integration] After AC6, the `QUEUED` job cancelled by the hard stop has no entry of its own (`findMany` for the job's id returns no `system.budget.window-reset` row).
8. [integration] A second `evaluate(policyId)` of AC6's paused policy leaves the count of `hard stop` entries for the policy unchanged.
9. [integration] `evaluate(policyId)` of a policy with `warnPercent` `null` that reaches its hard stop, run inside `withTestActor({ type: 'RUNNER', id: <a runner id> })`, leaves the `hard stop` entry with `actorType` `SYSTEM` and `actorId` `budget`.
10. [integration] `evaluate(policyId)` of a policy with `warnPercent` `null` that reaches its hard stop, while `record` is spied to reject, rejects, the policy's `pausedAt` is still `null` and the project's `QUEUED` job is still `QUEUED`.
11. [integration] `BudgetSweeper.tick(now)` over AC1's orphan setup, while `record` is spied to reject, returns `failed: 1` and `deleted: 0`, and the orphan policy row is still stored.

### US-005: Bash asks opened, approval expiries and job-end closes are audited

1. [integration] A sync reporting an `approval_request` event for a `RUNNING` job with `bashMode` `escalate`, as `fleet-approval-relay.integration.spec.ts` reports one, leaves one entry for the new approval's id with `key` `runner.sync`, `resourceType` `fleet-approval`, `projectId` web's id, `actorType` `RUNNER`, `actorId` the runner's id and `summary` `bash ask opened, pending`.
2. [integration] A sync reporting an `approval_request` event for a `RUNNING` job with `bashMode` `raw` leaves one entry for the new approval with `key` `runner.sync` and `summary` `bash ask opened, cancelled`.
3. [integration] Resending AC1's `approval_request` with the same seq and payload leaves the count of entries for that approval unchanged.
4. [integration] `app.get(ApprovalExpirySweeper).tick(now)` with a pending bash ask whose `expiresAt` is before `now` (created as `audit-fleet-approvals.integration.spec.ts`'s `bashApproval` does) returns `expired: 1` and leaves one entry for the approval with `key` `system.approval.expire`, `actorType` `SYSTEM`, `actorId` `approval`, `origin` `system` and `summary` `expired`.
5. [integration] A second `tick(now)` leaves the count of `system.approval.expire` entries for AC4's approval unchanged.
6. [integration] `POST /api/fleet/approvals/:id/decide` with `{ decision: 'allow' }`, as `root`, on a pending bash ask whose `expiresAt` has passed returns 409 and leaves one entry for the approval with `key` `system.approval.expire`, `actorType` `SYSTEM`, `actorId` `approval` and `summary` `expired`, and no `fleet.approval.decide.bash` entry for it.
7. [integration] `POST /api/fleet/approvals/:id/decide` with `{ decision: 'allow' }`, as `root`, on a pending bash ask whose job is `COMPLETED` returns 409 and leaves one entry for the approval with `key` `system.approval.expire`, `actorType` `SYSTEM`, `actorId` `approval` and `summary` `closed: job ended`.
8. [integration] A sync reporting `{ to: 'UPLOADING' }` for a `RUNNING` job with one pending bash ask closes the ask and leaves no `system.approval.expire` entry for it.
9. [integration] `app.get(PendingActionExpirySweeper, { strict: false }).tick(now)` with one proposed assistant action past its `expiresAt` (as `assistant-actions-expiry.integration.spec.ts` sets it up) returns `expired: 1` and leaves one entry for the action's approval with `key` `system.assistant-action.expire`, `resourceType` `fleet-approval`, `actorType` `SYSTEM`, `actorId` `assistant-action` and `summary` `expired`.
10. [integration] `POST /api/fleet/approvals/:id/decide` with `{ decision: 'approve' }`, by the action's requester, on a pending assistant action past its `expiresAt` returns 409 and leaves one entry for the approval with `key` `system.assistant-action.expire` and `actorId` `assistant-action`, and no `fleet.approval.decide.assistant` entry for it.
11. [integration] `ApprovalExpirySweeper.tick(now)` over one expired pending bash ask, while `record` is spied to reject, returns `failed: 1`, and the approval's `status` is still `pending`.
12. [integration] `POST …/decide` on a pending bash ask whose job is `COMPLETED`, while `record` is spied to reject, returns an error status other than 409, and the approval's `status` is still `pending`.
13. [integration] `POST …/decide` with `{ decision: 'allow' }` on a pending, unexpired bash ask of a `RUNNING` job returns 200 and leaves no `system.approval.expire` entry for the approval.
14. [unit] `ApprovalCloser.openBash` with a stub repository whose `findByAsk` returns an existing approval and a stub recorder does not call the recorder's `record`.

### US-006: Scheduled fires, coalesces, auto-disables and the fire test hook are audited

1. [integration] `ScheduleTicker.tick(now)` inside `withTestActor({ type: 'SYSTEM', id: 'schedule' })`, for an enabled schedule `dev` created on web's repo whose `nextFireAt` is before `now` and which has no active job (as `fleet-schedule-ticker.integration.spec.ts` sets it up), leaves one entry for the dispatched job's id with `key` `system.schedule.dispatch`, `resourceType` `fleet-job`, `actorType` `SYSTEM`, `actorId` `schedule`, `onBehalfOfType` `USER`, `onBehalfOfId` dev's id and `summary` `RUN on repo <repoId>, schedule <scheduleId>`.
2. [integration] After AC1, the dispatched job has no `fleet.job.dispatch` entry.
3. [integration] A tick at the schedule's next `nextFireAt` while its job is still `QUEUED` (no runner enrolled) leaves one entry for the schedule's id with `key` `system.schedule.dispatch`, `resourceType` `fleet-schedule`, `onBehalfOfId` dev's id and `summary` `coalesced into job <jobId>`.
4. [integration] A tick that fires the schedule while its job is `RUNNING` leaves the count of entries for the schedule's id unchanged.
5. [integration] A tick that fires a schedule whose owner no longer holds the dispatch key in the project (the schedule's owner made with the precedent's `owner(null)`, a user with no role in web) disables it and leaves one entry for the schedule's id with `key` `system.schedule.dispatch`, `actorId` `schedule` and `summary` `disabled: owner_lost_access`.
6. [integration] A tick that fires a schedule whose `cron` was set to `not a cron` directly disables it and leaves one entry for the schedule with `summary` `disabled: template_invalid`.
7. [integration] A tick that fires AC5's setup, while `record` is spied to reject, leaves the schedule `enabled`.
8. [integration] `POST /api/fleet/test-hooks/schedules/:id/fire`, as `root`, with `app.get(FLEET_CFG).testHooksEnabled` set to `true`, on an enabled schedule returns 200 and leaves one entry for the schedule with `key` `testhook.schedule.fire`, `resourceType` `fleet-schedule`, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `fired`.
9. [integration] A fire through the test hook that coalesces into the schedule's `QUEUED` job leaves the `coalesced into job <jobId>` entry with `actorType` `SYSTEM` and `actorId` `schedule`.
10. [integration] `POST /api/fleet/test-hooks/schedules/:id/fire` with `testHooksEnabled` `false` returns 404 and leaves no `testhook.schedule.fire` entry for the schedule.
11. [integration] `POST /api/fleet/test-hooks/schedules/:id/fire` with hooks enabled and an id no schedule has returns 404 and the count of `testhook.schedule.fire` entries is unchanged.
12. [integration] `POST /api/fleet/test-hooks/schedules/:id/fire` on a disabled schedule, with hooks enabled, returns 409 and leaves no `testhook.schedule.fire` entry for the schedule.
13. [integration] `POST /api/projects/web/fleet/jobs` as `dev` still leaves a `fleet.job.dispatch` entry for the dispatched job and no `system.schedule.dispatch` entry for it.

### US-007: Log retention, enrollment retention and the PR refresher are audited

1. [integration] `FleetLogRetentionProcessor.purge(before, now)` inside `withTestActor({ type: 'SYSTEM', id: 'log' })`, over one job of web that finished before `before` at lease epoch 1 (as `fleet-log-retention.integration.spec.ts` sets it up), leaves one entry for the job with `key` `system.log.retention`, `resourceType` `fleet-job`, `projectId` web's id, `actorType` `SYSTEM`, `actorId` `log`, `origin` `system` and `summary` `logs expired through epoch 1`.
2. [integration] `purge(before, now)` when no job finished before `before` leaves the count of `system.log.retention` entries unchanged.
3. [integration] `purge(before, now)` over one due job, while `record` is spied to reject, leaves the job's log rows unexpired.
4. [integration] `app.get(EnrollmentRetentionProcessor).scheduledPurge()` with `app.get(FLEET_CFG).enrollmentRetentionDays` set to 7 and two `RunnerEnrollment` rows used 30 days ago leaves one entry with `key` `system.enrollment.retention`, `resourceType` `fleet-enrollment`, `resourceId` `all`, `projectId` `null`, `actorType` `SYSTEM`, `actorId` `enrollment` and `summary` `purged 2 spent enrollments`.
5. [integration] `scheduledPurge()` when no enrollment is spent before the cutoff leaves the count of `system.enrollment.retention` entries unchanged.
6. [integration] `scheduledPurge()` with `enrollmentRetentionDays` `null` leaves the count of `system.enrollment.retention` entries unchanged and every `RunnerEnrollment` row in place.
7. [integration] `scheduledPurge()` over two spent enrollments, while `record` is spied to reject, resolves and leaves both `RunnerEnrollment` rows in place.
8. [integration] `app.get(FleetPrStateRefresher).refresh()` over a fleet PR link with `prState` `open` whose PR the stubbed GitHub client reports closed (as `fleet-pr-refresher.integration.spec.ts` stubs it) leaves one entry for the link's id with `key` `system.ticket-link.pr-refresh`, `resourceType` `ticket-link`, `projectId` the ticket's project, `actorType` `SYSTEM`, `actorId` `ticket-link` and `summary` `pr open -> closed`.
9. [integration] `refresh()` when the stubbed PR is still open leaves no entry for the link.
10. [integration] `refresh()` when the stubbed PR is merged leaves no `system.ticket-link.pr-refresh` entry for the link.
11. [integration] `refresh()` over AC8's setup, while `record` is spied to reject, leaves the link's `prState` `open`.

### US-008: Knowledge index passes and thread turn ends are audited

Every turn in AC1 to AC6 is opened by a `turn_start` line (the precedent's `start(turnId)`) before its other lines; a `turn_end` for a turn with no assistant message is skipped and records nothing.

1. [integration] `putThreadLines` for a `RUNNING` THREAD job (from `seedThreadJob`), with an assistant turn `t1` opened by `{ type: 'turn_start', turnId: 't1' }` and ended by `{ type: 'turn_end', turnId: 't1', status: 'completed', output: 'Done', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 }` (as `thread-assistant-lifecycle.integration.spec.ts` writes one), leaves one entry for the thread's id with `key` `system.thread.ingest`, `resourceType` `thread`, `projectId` web's id, `actorType` `SYSTEM`, `actorId` `thread`, `origin` `system` and `summary` `turn ended completed`.
2. [integration] `putThreadLines` with a `turn_start` and `text_delta` lines for turn `t2`, and no `turn_end`, leaves the count of `system.thread.ingest` entries for the thread unchanged.
3. [integration] A `turn_start` and a `turn_end` for turn `t3` with `status` `cancelled` leaves one entry for the thread with `summary` `turn ended cancelled`.
4. [integration] A `turn_start` and a `turn_end` for each of turns `t4` and `t5` in one upload leave two new `system.thread.ingest` entries for the thread.
5. [integration] A `turn_start` then a `turn_end` upload for turn `t6` (the `turn_start` in an earlier upload), while `record` is spied with `mockRejectedValue` (every call rejects, so the ingestor's line-by-line retry fails too), returns 200, the count of `system.thread.ingest` entries for the thread is unchanged, and the assistant message for `t6` does not have `status` `complete`.
6. [integration] A `turn_start` and `turn_end` upload at lease epoch 1 after the job's `leaseEpoch` was set to 2 directly returns 409 and leaves the count of `system.thread.ingest` entries for the thread unchanged.
7. [integration] After AC1, the assistant message for `t1` has `status` `complete`.
8. [integration] `app.get(KnowledgeRepoIndexer).indexRepo(repoId)` inside `withTestActor({ type: 'SYSTEM', id: 'knowledge' })`, for web's GitHub repo with a stored `KnowledgeRepoIndex` row (`projectId` web's id, `indexedSha` `sha-1`, `status` `idle`, `leaseUntil` `null`, `patternsKey` the key of web's default patterns) and one stored `KnowledgeRepoFile` (`path` `README.md`, `blobSha` `b1`, `unembeddedCount` 0), with `GitHubAppClient`'s `mintReadOnlyToken`, `getBranchHead` (returning `sha-2`) and `getTree` (returning `{ entries: [{ path: 'README.md', type: 'blob', sha: 'b1', size: 10 }], truncated: false }`) spied and `getFile` spied, returns `indexed`, does not call `getFile`, and leaves one entry for the repo's id with `key` `system.knowledge.index`, `resourceType` `fleet-repo`, `projectId` web's id, `actorType` `SYSTEM`, `actorId` `knowledge` and `summary` `indexed 0 changed, 0 removed`.
9. [integration] AC8's pass, while `record` is spied to reject, returns `failed` and the repo's `KnowledgeRepoIndex` row still has `indexedSha` `sha-1`.
10. [unit] `KnowledgeRepoIndexer.indexRepo` with the stubs of `knowledge-repo-indexer.spec.ts`, a changed head, two kept files whose blob changed and one stored file no longer selected, and a stub recorder whose `audited` runs its `fn`, calls `audited` once with an entry of `key` `system.knowledge.index`, `resourceType` `fleet-repo`, `resourceId` the repo id, `projectId` the repo's project and `summary` `indexed 2 changed, 1 removed`.
11. [unit] `indexRepo` whose head, file states and patterns key are unchanged returns `unchanged` and does not call the recorder's `audited`.
12. [unit] `indexRepo` for a repository that is not on GitHub returns `skipped` and does not call the recorder's `audited`.
13. [unit] `indexRepo` whose state's `claim` returns `false` returns `busy` and does not call the recorder's `audited`.
14. [unit] `indexRepo` whose recorder's `audited` rejects returns `failed`, and its last `finish` call has `status` `failed`.
