# SPEC: Permissions P2f — Audit Entries for the Fleet Admin Routes

## Summary

This feature makes the fleet's admin writes in `apps/api` record an `AuditEntry` in the same transaction as the write. It uses the recorder and the rules from `permissions-p2-audit-core`: `AuditRecorder.record` inside an existing `txManager.run`, and `AuditRecorder.audited` when there is none. The writes:
- **Budgets.** `BudgetsService.create`, `update`, `remove` and `resume`, through both the admin prefix (`/fleet/budgets`) and the project prefix (`/projects/:slug/fleet/budgets`).
- **Schedules.** `SchedulesService.create`, `update`, `remove`, `enable` and `disable`.
- **Runners, enrollments and repos.** `RunnersService.update` and `remove`, `EnrollmentService.create`, `FleetReposService.create` and `remove`.
- **Config jobs and knowledge.** The config edit, regenerate and drift-check dispatches of `ConfigJobsService`, the knowledge patterns save, and the knowledge reindex request.
- **Ingest and analytics.** The three ingest re-queue routes of `FleetIngestController`, and `AnalyticsService.deleteRows`.

Each entry carries a short summary of ids, field names, counts, modes and scope types. It never carries a value a user typed: a name, a cron expression, a label, a pattern, a PR title, an amount or a confirmation string.

This is the sixth of nine features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, audit-fleet-routes, **audit-fleet-ops**, audit-fleet-system, audit-integrations, web.

## Motivation

`permissions-p2-audit-fleet-routes` (PR #330, deployed `3ad6f466` on 2026-10-25) records the fleet's job, thread and approval writes: on koda-wk a thread create and archive now leave `thread.create` and `thread.archive` entries. The fleet's admin writes record none. A budget raised, a schedule edited, a runner disabled or a repo removed leaves only a `FleetActivity` row, which the Audit log (`GET /api/audit`) does not show.

`permissions-p2-audit-fleet-routes` left "audit-fleet-ops" with the admin routes, the runner protocol routes and every fleet system writer. That is about 20 admin service methods, plus the runner sync, enroll, log, bundle and tool routes, plus about 14 system writers, which together need 12 to 14 stories in two independent arcs. They are split into two features:
- **audit-fleet-ops** (this feature): the admin routes a human or an agent calls to configure the fleet.
- **audit-fleet-system**: the runner protocol routes (`/fleet/runner/sync`, `/fleet/runner/enroll`, log and bundle upload, tool calls), the fleet system writers (sweepers, the schedule ticker, retention processors, the ingest drain, the knowledge poller and index queue, the PR-state refresher, thread ingest), job placement, the closes a decide request commits on its way to a 409, and the test hooks.

**Rulings that bind this feature** (user, 2026-10-24):
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The coverage guard and the walker test belong to audit-integrations.** This feature does not add them.

The user skipped the design questions for the fleet audit features ("skip questions", 2026-10-25). The split above and every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The split.** audit-fleet-ops keeps the admin routes; the runner protocol and the fleet system writers move to a new feature, audit-fleet-system. P2 has nine features. The admin routes and the system writers share no writer, and each arc is five to seven stories.
- **Record next to the activity row.** Every admin write in this feature except the knowledge routes already calls `FleetActivityService.record` inside its `txManager.run`. It records its entry inside that same callback, right after the activity row, so the two commit or roll back together.
- **The key is the route's `@Requires` key.** Schedule enable and disable record `fleet.schedule.update` (the key both routes require), told apart by summary. Config edit and regenerate record `fleet.job.config.edit`, and the drift check records `fleet.repo.drift.check`.
- **`resume` records only on the budget routes.** `BudgetsService.resume` records `fleet.budget.resume` only when `opts.approvalId` is absent. A `raise_budget_and_resume` decide calls `resume` with `opts.approvalId` inside its own transaction, and its `fleet.approval.decide.budget` entry (audit-fleet-routes) covers that write.
- **Only the action is recorded, not its follow-ons in the same transaction.** Deleting a paused budget closes its pending approval (`ApprovalCloser.closeForPolicy`) and a budget resume from the budgets page closes it as `manual_resume`. Both happen in the action's own transaction, so they are covered by the action's entry, as audit-core's rule says.
- **Only committed writes are recorded.** A refused request (401, 403, 404, 409, 400) records nothing. So does a write that finds nothing to do:
  - an `enable` of a schedule that is already enabled, or a `disable` of one already disabled (both return the row unchanged);
  - an ingest re-queue that queues no row (`queued: 0`);
  - an analytics delete that deletes no row and marks no ingest row (every count in `DeletedCounts` is 0).
- **A repo check records nothing.** `FleetReposService.check` runs the forge check and writes no row.
- **The knowledge patterns save wraps its write in `audited`.** `KnowledgeIndexService.savePatterns` calls `saveProjectPatterns` with no transaction. It runs that call inside `this.audit.audited(...)`.
- **The knowledge reindex records an entry with no other write.** `POST …/knowledge/repos/:repoId/reindex` only adds the repo to the in-memory `KnowledgeIndexQueue`, but it is a human's action that starts an index pass, and the inventory lists it as a write. `ProjectKnowledgeController.reindex` records `fleet.knowledge.repo.reindex` through `this.audit.audited(...)`, with a callback that writes nothing, and calls `this.queue.enqueue` after `audited` resolves. So a failed record queues no pass.
- **The ingest controller records in its `queue` helper.** `FleetIngestController.queue` owns the ingest transaction. It gains the entry's key, `resourceType` and summary label next to its existing `action`, `entityType` and `entityId` arguments, and records inside its `txManager.run` when `run()` returned more than 0.
- **`AuditRecorder` is a required constructor dependency, last.** None of `BudgetsService`, `SchedulesService`, `RunnersService`, `EnrollmentService`, `FleetReposService`, `ConfigJobsService`, `KnowledgeIndexService`, `ProjectKnowledgeController`, `FleetIngestController` or `AnalyticsService` has an `@Optional()` parameter, so audit-core's rule puts it last in each constructor.
- **`projectId` is the row's project.** A budget's `projectId` (`null` for a global or runner policy), a schedule's, a repo's and a config job's project, a rerun job's project. Runners and enrollments have no project (`null`). An analytics delete has the query's `projectId`, `null` for a delete across every project.

### The summary and resource contract

| Write | Key | `resourceType` | `resourceId` | `projectId` | `summary` |
|:--|:--|:--|:--|:--|:--|
| budget create | `fleet.budget.create` | `fleet-budget` | policy id | policy's `projectId` | `created <scopeType> policy` (`global`, `runner`, `project`, `repo`) |
| budget update | `fleet.budget.update` | `fleet-budget` | policy id | policy's `projectId` | `fieldsSummary(dto)`, e.g. `fields: amountUsd, hardStop` |
| budget delete | `fleet.budget.delete` | `fleet-budget` | policy id | policy's `projectId` | `deleted`, or `deleted while paused` when the policy had `pausedAt` |
| budget resume (route) | `fleet.budget.resume` | `fleet-budget` | policy id | policy's `projectId` | `resumed` |
| schedule create | `fleet.schedule.create` | `fleet-schedule` | schedule id | schedule's project | `created on repo <repoId>` |
| schedule update | `fleet.schedule.update` | `fleet-schedule` | schedule id | schedule's project | `fieldsSummary(dto)`, e.g. `fields: cron, timezone` |
| schedule enable | `fleet.schedule.update` | `fleet-schedule` | schedule id | schedule's project | `enabled` |
| schedule disable | `fleet.schedule.update` | `fleet-schedule` | schedule id | schedule's project | `disabled` |
| schedule delete | `fleet.schedule.delete` | `fleet-schedule` | schedule id | schedule's project | `deleted` |
| enrollment create | `fleet.enrollment.create` | `fleet-enrollment` | enrollment id | `null` | `created` |
| runner update | `fleet.runner.update` | `fleet-runner` | runner id | `null` | `fieldsSummary(clean)`, e.g. `fields: enabled` |
| runner delete | `fleet.runner.delete` | `fleet-runner` | runner id | `null` | `deleted` |
| repo create | `fleet.repo.create` | `fleet-repo` | repo id | repo's project | `registered <provider>` (`github`, `gitlab`) |
| repo delete | `fleet.repo.delete` | `fleet-repo` | repo id | repo's project | `deleted` |
| config edit | `fleet.job.config.edit` | `fleet-job` | job id | repo's project | `edit on repo <repoId>` |
| config regenerate | `fleet.job.config.edit` | `fleet-job` | job id | repo's project | `regenerate on repo <repoId>` |
| drift check | `fleet.repo.drift.check` | `fleet-job` | job id | repo's project | `drift on repo <repoId>` |
| knowledge patterns save | `fleet.knowledge.patterns.update` | `project` | project id | project id | `custom patterns`, or `default patterns` for the `null` body |
| knowledge reindex | `fleet.knowledge.repo.reindex` | `fleet-repo` | repo id | project id | `reindex queued` |
| ingest backfill | `fleet.ingest.backfill` | `fleet-ingest` | `all` | `null` | `backfill queued <n>` |
| ingest rerun of one job | `fleet.ingest.rerun` | `fleet-job` | job id | job's project | `rerun queued <n>` |
| ingest rerun of outdated rows | `fleet.ingest.rerun` | `fleet-ingest` | `all` | `null` | `rerun outdated queued <n>` |
| analytics delete | `fleet.analytics.delete` | `fleet-analytics` | query `projectId`, or `all` | query `projectId` or `null` | `deleted <costEvents> cost events, <stories> stories, <reviews> reviews, <ingestRowsMarked> ingest rows marked` |

`<n>` is the count the ingest repository method returned. `fieldsSummary` is `src/audit/audit-summary.ts`: it lists the sorted names of the defined fields and never their values. `<repoId>` and `<provider>` are the stored repo's id and provider. The table never lists a value from a request body other than field names.

### The writers

| Story | Service.method | Today | Change |
|:--|:--|:--|:--|
| US-001 | `BudgetsService.create` | `txManager.run`, `budgets.service.ts:59` | `record` inside, after `this.record` (the activity row) |
| US-001 | `BudgetsService.update` | `txManager.run`, `:77` | `record` inside, after the activity row |
| US-001 | `BudgetsService.remove` | `txManager.run`, `:98` | `record` inside, after the activity row; the summary reads `policy.pausedAt` from the locked row |
| US-001 | `BudgetsService.resume` | `txManager.run`, `:116` | `record` inside, after the activity row, only when `opts.approvalId` is absent |
| US-002 | `SchedulesService.create`, `update`, `remove` | `txManager.run`, `schedules.service.ts:92`, `:107`, `:134` | `record` inside, after the activity row |
| US-002 | `SchedulesService.enable`, `disable` | `txManager.run`, `:144`, `:165` | `record` inside, after the activity row; not on the early `return current` |
| US-003 | `EnrollmentService.create` | `txManager.run`, `enrollment.service.ts:34` | `record` inside, after the activity row |
| US-003 | `RunnersService.update`, `remove` | `txManager.run`, `runners.service.ts:51`, `:65` | `record` inside, after the activity row |
| US-003 | `FleetReposService.create`, `remove` | `txManager.run`, `fleet-repos.service.ts:38`, `:69` | `record` inside, after the activity row |
| US-004 | `ConfigJobsService.create` (private, behind `submitEdit`, `submitRegenerate`, `submitDrift`) | `txManager.run`, `config-jobs.service.ts:125` | `record` inside, after the activity row; key from `mode` (`drift` → `fleet.repo.drift.check`, else `fleet.job.config.edit`) |
| US-004 | `KnowledgeIndexService.savePatterns` | one `saveProjectPatterns` call, no transaction | wrap the call in `audit.audited` |
| US-004 | `ProjectKnowledgeController.reindex` | `this.queue.enqueue(repo.id, 'admin')`, no write | `audit.audited` with a callback that writes nothing, then `enqueue` |
| US-005 | `FleetIngestController.queue` | `txManager.run`, `fleet-ingest.controller.ts:77` | `record` inside, after the activity row, when `n > 0` |
| US-005 | `AnalyticsService.deleteRows` | `txManager.run`, `analytics.service.ts:144` | `record` inside, after the activity row, when any count is above 0 |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| a write route refuses (401, 403, 404, 409, 400) before writing | no `AuditEntry` row; each story pins at least one refusal by permission | US-001 to US-005 |
| an ingest rerun for an unknown job | 404 `fleet.jobs`; no entry (covered by the row above) | US-005 |
| `record` rejects inside the write's transaction | the transaction rolls back with the domain row; the rejection propagates as an error status | US-001 to US-005 |
| a second budget policy for the same scope and window (`DuplicateBudgetPolicyError`) | 409 `fleet.budgets`; no entry | US-001 |
| `resume` of a policy that is not paused | 409 `fleet.budgetNotPaused`; no entry | US-001 |
| `resume` called by a budget decide (`opts.approvalId` set) | no `fleet.budget.resume` entry; the decide's entry covers it | US-001 |
| `enable` of an enabled schedule, `disable` of a disabled one | the row is returned unchanged; no entry | US-002 |
| a developer updates another user's schedule | 403 `permissions`; no entry | US-002 |
| deleting a runner or a repo with an unfinished job | 409 `fleet.runnerBusy` / `fleet.repoBusy`; no entry | US-003 |
| registering a repo that is already registered | 409; no entry | US-003 |
| `POST /fleet/repos/:id/check` | no write; no entry | US-003 |
| a config job is already active for the repo (`DuplicateActiveJobError`) | 409 `fleet.configJobActive` (`ConfigJobActiveException`); no entry | US-004 |
| a reindex while knowledge indexing is disabled | 409 `knowledge.disabled`; no entry; nothing queued | US-004 |
| an ingest re-queue that queues 0 rows | `{ queued: 0 }`; no entry | US-005 |
| an analytics delete whose counts are all 0 | the counts are returned; no entry | US-005 |
| an analytics delete with the wrong `confirm` | 400 `fleet.analyticsDelete`; no entry | US-005 |

### Integration

Verified at main `3ad6f466`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input)` and `AuditRecorder.audited(fn, entriesOf)`, `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. `record` throws for a key outside the catalog and outside a transaction.
- `fieldsSummary(patch)` — `src/audit/audit-summary.ts`.
- `mockAuditRecorder` — `src/common/test-helpers/global-stubs.module.ts` (`record` resolves `undefined`, `audited` runs its `fn` and returns its result). `GlobalStubsModule` provides it as `AuditRecorder`, so the module specs (`budgets.module.spec.ts`, `schedules.module.spec.ts`, `ingest.module.spec.ts`, `knowledge.module.spec.ts`, `fleet.module.spec.ts`) keep compiling.
- `AuditLogModule` is `@Global()`, so every fleet module resolves `AuditRecorder` without importing it.
- Every key in the contract table is in `PERMISSION_CATALOG` (`src/permissions/catalog.ts`).
- The seeded `developer` role (`src/permissions/system-roles.ts`) holds `fleet.schedule.create`, `fleet.schedule.update.own`, `fleet.schedule.delete.own`, `fleet.repo.drift.check` and `fleet.knowledge.repo.reindex`, `fleet.job.*` (so `fleet.job.config.edit` too, through the `.*` prefix match in `entry-matcher.ts`), and no budget or `fleet.knowledge.patterns.update` key. `viewer` holds none of them. The Owner holds every key.
- `ApprovalsService.decide` calls `BudgetsService.resume(…, { approvalId: id })` — `src/fleet/approvals/approvals.service.ts:127`.
- `withTestActor(actor, fn)`, `fixtureDb(app)` — `test/helpers/action-context.ts`; `seedFleetHttpWorld`, `insertRunner`, `enrollRunner` — `test/helpers/fleet-fixtures.ts`; `startFakeForge` — the fake GitHub API used by `fleet-repos.integration.spec.ts` and `fleet-repo-config-api.integration.spec.ts`.
- Route-test precedent: `test/integration/fleet/fleet-budgets-api.integration.spec.ts`, `fleet-schedules-api.integration.spec.ts`, `runner-admin.integration.spec.ts`, `fleet-repos.integration.spec.ts`, `fleet-repo-config-api.integration.spec.ts`, `fleet-ingest-api.integration.spec.ts`, `fleet-analytics-admin-api.integration.spec.ts`, `test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts`, `test/integration/audit/audit-fleet-approvals.integration.spec.ts`.

Changed (baseline → target):
- The constructors of `BudgetsService`, `SchedulesService`, `RunnersService`, `EnrollmentService`, `FleetReposService`, `ConfigJobsService`, `KnowledgeIndexService`, `ProjectKnowledgeController`, `FleetIngestController` and `AnalyticsService` — Baseline: no `AuditRecorder`. Target: a required `AuditRecorder` as the last parameter.
- `FleetIngestController.queue` (private) — Baseline: `queue(actorId, action, entityType, entityId, projectId, run)`. Target: it also takes the entry's `key`, `resourceType`, `resourceId` and summary label, and records when `run()` returned more than 0.

## Out of Scope

- The runner protocol routes (`/fleet/runner/sync` with its command acks and job reports, `/fleet/runner/enroll`, log append, bundle upload, runner tool calls) are out of scope (feature `permissions-p2-audit-fleet-system`).
- The fleet system writers (`ApprovalExpirySweeper`, `PendingActionExpirySweeper`, `BudgetSweeper`, `BundleIngestSweeper`, `KnowledgePoller`, `KnowledgeIndexQueue`, `FleetLogRetentionProcessor`, `EnrollmentRetentionProcessor`, `ScheduleTicker`, `FleetSweeper`, `FleetPrStateRefresher`, `ThreadIngestHook`) and job placement are out of scope (feature `permissions-p2-audit-fleet-system`).
- The key a scheduled fire records under and the closes a bash or assistant decide commits before its 409 are out of scope (feature `permissions-p2-audit-fleet-system`).
- The test hooks (`POST /fleet/test-hooks/schedules/:id/fire`, `PUT /fleet/test-hooks/repos/:repoId/nax-files`) are out of scope (feature `permissions-p2-audit-fleet-system`).
- Recording the approval close that a budget delete or a budget-page resume commits in its own transaction is out of scope; the action's own entry covers that transaction.
- Recording `BudgetsService.resume` when `ApprovalsService.decide` calls it with `opts.approvalId` is out of scope; the decide's `fleet.approval.decide.budget` entry covers it.
- Recording the knowledge index passes that a patterns save queues is out of scope; the passes are the index queue's (feature `permissions-p2-audit-fleet-system`).
- Recording refused or failed attempts (403, 404, 409, validation errors) is out of scope; only committed writes are recorded, and refusal records belong to P3's approval engine.
- Putting any request value (a budget amount, a schedule name or cron, an enrollment label, a repo owner or name, a PR title or edit content, a knowledge pattern, an analytics cutoff or confirmation) into an audit summary is out of scope; summaries carry only the ids, field names, counts, modes, providers and scope types in the contract table.
- ACs for the `runner` and `repo` budget scopes and for budget update and resume through the admin prefix are out of scope; the contract table defines their summaries, and the project-prefix ACs exercise the same `BudgetsService` methods.
- Pinning the summary of an empty `PATCH` body (no field set) is out of scope; `fieldsSummary` returns `undefined` for it and the entry's `summary` is `null`.
- A before/after diff of values in `AuditEntry` is out of scope.
- Changing `FleetActivityService`, its `FleetActivity` rows or their payloads is out of scope; they keep their current shapes.
- Changing any route's status codes, response bodies or `@Requires` keys is out of scope; `openapi.json` does not change.
- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-integrations`).
- The web Audit log page is out of scope (feature `permissions-p2-web`).

## Stories

1. **US-001: Budget create, update, delete and resume are audited** — `Workdir: apps/api` — No dependencies. `BudgetsService` records inside its four transactions, through both route prefixes; `resume` records only when it was not called by a budget decide.
2. **US-002: Schedule create, update, enable, disable and delete are audited** — `Workdir: apps/api` — No dependencies. `SchedulesService` records inside its five transactions, not on the unchanged `enable` and `disable` returns.
3. **US-003: Enrollment create, runner update and delete, repo create and delete are audited** — `Workdir: apps/api` — No dependencies. `EnrollmentService.create`, `RunnersService.update` and `remove`, and `FleetReposService.create` and `remove` record inside their transactions.
4. **US-004: Config jobs, the knowledge patterns save and the reindex request are audited** — `Workdir: apps/api` — No dependencies. `ConfigJobsService`'s dispatch, `KnowledgeIndexService.savePatterns` and `ProjectKnowledgeController.reindex`.
5. **US-005: Ingest re-queues and the analytics delete are audited** — `Workdir: apps/api` — No dependencies. `FleetIngestController.queue` and `AnalyticsService.deleteRows`, each only when it wrote a row.

Five stories, one capability: every story wires the same recorder into a different set of fleet admin writers, and none is useful as a separate PR. They touch disjoint files, so none depends on another.

### Context Files

**US-001**
- `apps/api/src/fleet/budgets/budgets.service.ts`
- `apps/api/src/fleet/approvals/approvals.service.ts`
- `apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts`
- `apps/api/test/integration/audit/audit-fleet-approvals.integration.spec.ts`
- `apps/api/test/integration/audit/audit-fleet-jobs.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/schedules/schedules.service.ts`
- `apps/api/src/fleet/schedules/project-fleet-schedules.controller.ts`
- `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts`
- `apps/api/test/integration/permissions/enforce-fleet-schedules.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/runners/enrollment.service.ts`
- `apps/api/src/fleet/runners/runners.service.ts`
- `apps/api/src/fleet/repos/fleet-repos.service.ts`
- `apps/api/test/integration/fleet/runner-admin.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/repo-config/config-jobs.service.ts`
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts`
- `apps/api/src/fleet/knowledge/knowledge-index.service.ts`
- `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts`
- `apps/api/test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts`

**US-005**
- `apps/api/src/fleet/ingest/fleet-ingest.controller.ts`
- `apps/api/src/fleet/analytics/analytics.service.ts`
- `apps/api/test/integration/fleet/fleet-ingest-api.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-fleet-budgets.integration.spec.ts`
- `apps/api/src/fleet/budgets/budgets.service.spec.ts`

**US-002**
- `apps/api/test/integration/audit/audit-fleet-schedules.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-fleet-runners-repos.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-fleet-config-knowledge.integration.spec.ts`

**US-005**
- `apps/api/test/integration/audit/audit-fleet-ingest-analytics.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/budgets/budgets.service.ts` — injects AuditRecorder as the last constructor parameter and records inside create's, update's, remove's and resume's transactions after the activity row (resume only when opts.approvalId is absent); responses, the evaluator signal and the approval closes are unchanged.

**US-002**
- `apps/api/src/fleet/schedules/schedules.service.ts` — injects AuditRecorder as the last constructor parameter and records inside create's, update's, remove's, enable's and disable's transactions after the activity row, not on enable's or disable's unchanged return; responses are unchanged.
- `apps/api/src/fleet/schedules/schedules.service.spec.ts` — its direct new SchedulesService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-003**
- `apps/api/src/fleet/runners/enrollment.service.ts` — injects AuditRecorder as the last constructor parameter and records fleet.enrollment.create inside create's transaction after the activity row; enroll and the other methods are unchanged.
- `apps/api/src/fleet/runners/enrollment.service.spec.ts` — its direct new EnrollmentService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/runners/runners.service.ts` — injects AuditRecorder as the last constructor parameter and records inside update's and remove's transactions after the activity row; responses and the busy refusal are unchanged.
- `apps/api/src/fleet/runners/runners.service.spec.ts` — its direct new RunnersService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — injects AuditRecorder as the last constructor parameter and records inside create's and remove's transactions after the activity row; check and the forge calls are unchanged.
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — its direct new FleetReposService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.

**US-004**
- `apps/api/src/fleet/repo-config/config-jobs.service.ts` — injects AuditRecorder as the last constructor parameter and records inside the private create's transaction after the activity row, keyed by mode; placement, live events and responses are unchanged.
- `apps/api/src/fleet/repo-config/config-jobs.service.spec.ts` — its direct new ConfigJobsService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/knowledge/knowledge-index.service.ts` — injects AuditRecorder as the last constructor parameter and runs savePatterns' saveProjectPatterns call inside audit.audited with a fleet.knowledge.patterns.update entry; the returned patterns are unchanged.
- `apps/api/src/fleet/knowledge/knowledge-index.service.spec.ts` — its direct new KnowledgeIndexService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — injects AuditRecorder as the last constructor parameter and records fleet.knowledge.repo.reindex through audit.audited before reindex's enqueue; the refusals and the 202 response are unchanged.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.spec.ts` — its direct new ProjectKnowledgeController(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument, and it gains the US-004 AC-13 case (a rejecting audited queues nothing); the existing assertions are kept.

**US-005**
- `apps/api/src/fleet/ingest/fleet-ingest.controller.ts` — injects AuditRecorder as the last constructor parameter, and the private queue helper takes the entry's key, resourceType, resourceId and summary label and records inside its transaction when the run returned more than 0; responses and the kick are unchanged.
- `apps/api/src/fleet/analytics/analytics.service.ts` — injects AuditRecorder as the last constructor parameter and records fleet.analytics.delete inside deleteRows' transaction after the activity row when any count is above 0; the refusals and the response are unchanged.
- `apps/api/src/fleet/analytics/analytics.service.spec.ts` — its direct new AnalyticsService(...) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept, including the single txManager.run call, and it gains the US-005 AC-12 case (all-zero counts record nothing).

### Seams

- No story introduces a symbol another story calls. Every story consumes audit-core's `AuditRecorder.record` and `audited`; its integration ACs call the named REST route through the booted `AppModule` and assert the stored `AuditEntry` row (key, resource, project, actor, origin, summary), so they prove the route reaches the recorder through the real wiring rather than a stub.
- US-001's decide AC enters at `POST /api/fleet/approvals/:id/decide`, which reaches `ApprovalsService.decide` → `BudgetsService.resume(…, { approvalId })`, and asserts that no `fleet.budget.resume` entry was stored.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database with `bootHttpApp`, create their fixtures with `seedFleetHttpWorld` and `fixtureDb(app)`, call the route over HTTP with a token for the acting principal, and read `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. `root` is the Owner and holds every key; `dev` is a `developer` on project `web`; `viewer` is a `viewer` on `web`. A second developer on `web` is added as `fleet-schedules-api.integration.spec.ts` does (`POST /api/admin/users`, then `POST /api/projects/web/members` with `roleKey: 'developer'`). Repo registration and config jobs reach GitHub through `startFakeForge` with the routes and environment of `fleet-repos.integration.spec.ts` and `fleet-repo-config-api.integration.spec.ts`. A knowledge spec sets `app.get(FLEET_CFG).knowledgeIndexEnabled` as each AC needs after boot and restores it in `afterAll`, as `enforce-fleet-config-knowledge.integration.spec.ts` does. `BudgetPolicy` is unique on `(scopeKey, windowKind)`, so the US-001 spec clears the budget approvals and every `BudgetPolicy` row in `beforeEach`, as `fleet-budgets-api.integration.spec.ts` does, and each AC creates the policies it needs. A paused budget policy is a policy row inserted or updated directly with a `pausedAt` and `pausedWindowStart`; a pending budget approval and its decide follow `audit-fleet-approvals.integration.spec.ts`. The US-004 knowledge ACs spy `app.get(KnowledgeIndexQueue).enqueue` with an implementation that does nothing, as `enforce-fleet-config-knowledge.integration.spec.ts` does, so no real index pass starts. Config jobs on one repo exclude each other (one active `nax-config` job per repo), so a config-job AC that needs no active job first moves the repo's earlier config job to `CANCELLED` directly with `fixtureDb(app).fleetJob.update`. A runner or repo an AC deletes is one the AC inserted itself, never the world's repo. An ingest row to re-queue and a bundle artifact to backfill are created directly with `fixtureDb(app)` (`insertIngestRow` in `test/helpers/fleet-analytics-fixtures.ts`, which writes a `done` row at `parserVersion` 1; an AC that needs another version sets it afterwards with `fixtureDb(app).fleetBundleIngest.updateMany({ where: { jobId }, data: { parserVersion } })`). Each AC names the row's `status` and `parserVersion` (`INGEST_PARSER_VERSION` is 3), and an AC that counts queued rows first sets every other ingest row to `pending` at version 3 so they are not re-queued. Every ingest queue route kicks the real drain, so after each one, and before the next AC's setup, the spec awaits `app.get(BundleIngestService).idle()`, as `fleet-ingest-api.integration.spec.ts` does. Analytics cost events come from `insertAnalyticsJob` and `insertCostEvent` in the same helper file, on a fresh job with no ingest row (`deleteRows` marks every ingest row of a job whose cost event it deletes). A busy runner or repo is a job created directly with `fixtureDb(app).fleetJob.create`, `state` `RUNNING` and `runnerId` the runner (or `state` `QUEUED` and `repoId` the repo), as `enforce-fleet-jobs.integration.spec.ts` does. Logging in a second developer is the fifth login in the suite, so the spec calls `resetThrottle(app)` before it. ACs that name an earlier AC's fixture (US-002 AC8 to AC10, US-004 AC5) run after it in the same `describe`. Every fixture id is created by the spec itself, never a fixed string, so entries from other specs cannot collide. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource (and key, where named) returns an empty array.

### US-001: Budget create, update, delete and resume are audited

1. [integration] `POST /api/fleet/budgets` with a `global` policy, as `root`, returns 201 and leaves one entry for the new policy's id with `key` `fleet.budget.create`, `resourceType` `fleet-budget`, `projectId` `null`, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `created global policy`.
2. [integration] `POST /api/projects/web/fleet/budgets` with a `project` policy, as `root`, leaves one entry for the new policy's id with `key` `fleet.budget.create`, `projectId` web's id and `summary` `created project policy`.
3. [integration] Two `POST /api/projects/web/fleet/budgets` calls for the same `project` scope and window return 201 and then 409, and across both calls the `fleet.budget.create` entries with `projectId` web's id increase by exactly one.
4. [integration] `POST /api/projects/web/fleet/budgets` as `dev` (no budget key) returns 403 and leaves no `fleet.budget.create` entry with `actorId` dev's id.
5. [integration] `POST /api/projects/web/fleet/budgets`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and leaves no `BudgetPolicy` row with `projectId` web's id.
6. [integration] `PATCH /api/projects/web/fleet/budgets/:id` with `{ amountUsd: 30, hardStop: false }` leaves one entry for the policy with `key` `fleet.budget.update` and `summary` `fields: amountUsd, hardStop`.
7. [integration] `DELETE /api/projects/web/fleet/budgets/:id` on a policy that is not paused returns 204 and leaves one entry for the policy with `key` `fleet.budget.delete` and `summary` `deleted`.
8. [integration] `DELETE /api/fleet/budgets/:id` on a `global` policy inserted directly with a `pausedAt` leaves one entry for the policy with `key` `fleet.budget.delete`, `projectId` `null` and `summary` `deleted while paused`.
9. [integration] `POST /api/projects/web/fleet/budgets/:id/resume` with an `amountUsd` above the window's spend on a paused policy returns 200 and leaves one entry for the policy with `key` `fleet.budget.resume` and `summary` `resumed`.
10. [integration] `POST /api/projects/web/fleet/budgets/:id/resume` on a policy that is not paused returns 409 and leaves no `fleet.budget.resume` entry for the policy.
11. [integration] `POST /api/fleet/approvals/:id/decide` with `{ decision: 'raise_budget_and_resume', amountUsd }` on the pending approval of a paused policy returns 200 and leaves no `fleet.budget.resume` entry for that policy.
12. [unit] `BudgetsService.resume` with stub collaborators, a stub transaction manager whose `run` calls its callback, a stub recorder and `opts.approvalId` `a1` does not call the recorder's `record`; the same call without `opts` calls `record` once with `key` `fleet.budget.resume`.

### US-002: Schedule create, update, enable, disable and delete are audited

1. [integration] `POST /api/projects/web/fleet/schedules` with a valid template on web's repo, as `dev`, returns 201 and leaves one entry for the new schedule's id with `key` `fleet.schedule.create`, `resourceType` `fleet-schedule`, `projectId` web's id, `actorType` `USER`, `actorId` dev's id, `origin` `rest` and `summary` `created on repo <repoId>`.
2. [integration] The `fleet.schedule.create` entry left by `POST /api/projects/web/fleet/schedules` with `name` `secret-name` has a `summary` that does not include `secret-name`.
3. [integration] `POST /api/projects/web/fleet/schedules` as `viewer` returns 403 and leaves no `fleet.schedule.create` entry with `actorId` viewer's id.
4. [integration] `POST /api/projects/web/fleet/schedules`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and leaves no `JobSchedule` row with that `name`.
5. [integration] `PATCH /api/projects/web/fleet/schedules/:id` with `{ cron: '0 6 * * *', timezone: 'UTC' }` by the schedule's owner leaves one entry for the schedule with `key` `fleet.schedule.update` and `summary` `fields: cron, timezone`.
6. [integration] `PATCH /api/projects/web/fleet/schedules/:id` by a second developer who does not own the schedule returns 403 and leaves no `fleet.schedule.update` entry for the schedule.
7. [integration] `POST /api/projects/web/fleet/schedules/:id/disable` on an enabled schedule returns 200 and leaves one entry for the schedule with `key` `fleet.schedule.update` and `summary` `disabled`.
8. [integration] Repeating `POST …/disable` on that disabled schedule returns 200 and leaves still exactly one entry for the schedule with `summary` `disabled`.
9. [integration] `POST /api/projects/web/fleet/schedules/:id/enable` on that disabled schedule, by its owner, returns 200 and leaves one entry for the schedule with `key` `fleet.schedule.update` and `summary` `enabled`.
10. [integration] Repeating `POST …/enable` on that enabled schedule returns 200 and leaves still exactly one entry for the schedule with `summary` `enabled`.
11. [integration] `DELETE /api/projects/web/fleet/schedules/:id` by the schedule's owner returns 204 and leaves one entry for the schedule with `key` `fleet.schedule.delete` and `summary` `deleted`.

### US-003: Enrollment create, runner update and delete, repo create and delete are audited

1. [integration] `POST /api/fleet/enrollments` with `{ labels: ['secret-label'] }`, as `root`, returns 201 and leaves one entry for the new enrollment's id with `key` `fleet.enrollment.create`, `resourceType` `fleet-enrollment`, `projectId` `null`, `actorType` `USER`, `actorId` root's id and `summary` `created`.
2. [integration] `POST /api/fleet/enrollments` as `dev` (no global key) returns 403 and leaves no `fleet.enrollment.create` entry with `actorId` dev's id.
3. [integration] `POST /api/fleet/enrollments`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and the count of `RunnerEnrollment` rows is unchanged.
4. [integration] `PATCH /api/fleet/runners/:id` with `{ enabled: false }`, as `root`, returns 200 and leaves one entry for the runner with `key` `fleet.runner.update`, `resourceType` `fleet-runner`, `projectId` `null` and `summary` `fields: enabled`.
5. [integration] `DELETE /api/fleet/runners/:id` on a runner with no unfinished job returns 204 and leaves one entry for the runner with `key` `fleet.runner.delete` and `summary` `deleted`.
6. [integration] `DELETE /api/fleet/runners/:id` on a runner holding a `RUNNING` job returns 409 and leaves no `fleet.runner.delete` entry for the runner.
7. [integration] `POST /api/fleet/repos` for GitHub repo `acme/extra` on project `web` (not one `seedFleetHttpWorld` registered; the fake forge answers its installation and repo routes as `fleet-repos.integration.spec.ts` does for `acme/app`), as `root`, returns 201 and leaves one entry for the new repo's id with `key` `fleet.repo.create`, `resourceType` `fleet-repo`, `projectId` web's id and `summary` `registered github`.
8. [integration] A second `POST /api/fleet/repos` for that repo returns 409 and the `fleet.repo.create` entries with `projectId` web's id are still exactly one.
9. [integration] `DELETE /api/fleet/repos/:id` on a repo with no unfinished job returns 204 and leaves one entry for the repo with `key` `fleet.repo.delete` and `summary` `deleted`.
10. [integration] `DELETE /api/fleet/repos/:id` on a repo with a `QUEUED` job returns 409 and leaves no `fleet.repo.delete` entry for the repo.
11. [integration] `POST /api/fleet/repos/:id/check` returns 200 and leaves no entry for the repo.

### US-004: Config jobs, the knowledge patterns save and the reindex request are audited

1. [integration] `POST /api/projects/web/fleet/repos/:repoId/config-edits` with a valid edit set and PR title `secret-title`, as `root`, returns 201 and leaves one entry for the dispatched job's id with `key` `fleet.job.config.edit`, `resourceType` `fleet-job`, `projectId` web's id, `actorType` `USER` and `summary` `edit on repo <repoId>`.
2. [integration] The `fleet.job.config.edit` entry left by that `POST` has a `summary` that does not include `secret-title`.
3. [integration] `POST /api/projects/web/fleet/repos/:repoId/config-edits/regenerate`, as `root`, on a repo with no active config job leaves one entry for the dispatched job's id with `key` `fleet.job.config.edit` and `summary` `regenerate on repo <repoId>`.
4. [integration] `POST /api/projects/web/fleet/repos/:repoId/drift-checks`, as `dev`, on a repo with no active config job leaves one entry for the dispatched job's id with `key` `fleet.repo.drift.check`, `actorId` dev's id and `summary` `drift on repo <repoId>`.
5. [integration] `POST …/drift-checks` while AC4's drift job for the repo is still `QUEUED` returns 409, and the `fleet.repo.drift.check` entries with `projectId` web's id are the same before and after the call.
6. [integration] `POST …/drift-checks` as `viewer` returns 403 and leaves no `fleet.repo.drift.check` entry with `actorId` viewer's id.
7. [integration] `PUT /api/projects/web/knowledge/patterns` with `{ patterns: ['secret/**/*.md'] }`, as `root`, returns 200 and leaves one entry for web's project id with `key` `fleet.knowledge.patterns.update`, `resourceType` `project` and `summary` `custom patterns`.
8. [integration] `PUT /api/projects/web/knowledge/patterns` with `{ patterns: null }` leaves an entry for web's project id with `key` `fleet.knowledge.patterns.update` and `summary` `default patterns`.
9. [integration] `PUT /api/projects/web/knowledge/patterns` as `dev` (no patterns key) returns 403 and leaves no `fleet.knowledge.patterns.update` entry with `actorId` dev's id.
10. [integration] `PUT /api/projects/web/knowledge/patterns`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and the project's stored patterns are unchanged.
11. [integration] `POST /api/projects/web/knowledge/repos/:repoId/reindex` with knowledge indexing enabled, as `dev`, returns 202, calls the queue's `enqueue` with the repo's id and `admin`, and leaves one entry for the repo's id with `key` `fleet.knowledge.repo.reindex`, `resourceType` `fleet-repo`, `projectId` web's id and `summary` `reindex queued`.
12. [integration] `POST …/knowledge/repos/:repoId/reindex` with knowledge indexing disabled returns 409 and leaves no `fleet.knowledge.repo.reindex` entry for the repo.
13. [unit] `ProjectKnowledgeController.reindex` with indexing enabled, a stub index service resolving the repo, a stub queue and a stub recorder whose `audited` rejects, rejects and does not call the queue's `enqueue`.

### US-005: Ingest re-queues and the analytics delete are audited

1. [integration] `POST /api/fleet/ingest/backfill`, as `root`, with exactly one unexpired bundle artifact that has no ingest row, returns 201 with `{ queued: 1 }` and leaves one entry with `key` `fleet.ingest.backfill`, `resourceType` `fleet-ingest`, `resourceId` `all`, `projectId` `null`, `actorId` root's id and `summary` `backfill queued 1`.
2. [integration] Repeating `POST /api/fleet/ingest/backfill` when no bundle lacks an ingest row returns `{ queued: 0 }`, and the `fleet.ingest.backfill` entries are the same before and after the call.
3. [integration] `POST /api/fleet/ingest/jobs/:jobId/rerun` for a job with one `done` ingest row at version 3 returns 201 and leaves one entry for the job's id with `key` `fleet.ingest.rerun`, `resourceType` `fleet-job`, `projectId` the job's project and `summary` `rerun queued 1`.
4. [integration] `POST /api/fleet/ingest/rerun-outdated` with exactly one outdated row (`done`, `parserVersion` 2, its artifact unexpired) returns `{ queued: 1 }` and leaves one entry with `key` `fleet.ingest.rerun`, `resourceId` `all` and `summary` `rerun outdated queued 1`.
5. [integration] `POST /api/fleet/ingest/backfill` as `dev` returns 403 and leaves no `fleet.ingest.backfill` entry with `actorId` dev's id.
6. [integration] `POST /api/fleet/ingest/jobs/:jobId/rerun` for a job whose one ingest row is `done`, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and the row's `status` is still `done`.
7. [integration] `POST /api/fleet/ingest/rerun-outdated` when no row is outdated returns `{ queued: 0 }`, and the `fleet.ingest.rerun` entries with `resourceId` `all` are the same before and after the call.
8. [integration] `DELETE /api/fleet/analytics?before=<instant>&projectId=<web's id>` with `{ confirm: 'web' }`, as `root`, over one cost event of web before the instant (on a fresh job with no ingest row, and web having no other cost event, story or review before it), returns 200 and leaves one entry for web's id with `key` `fleet.analytics.delete`, `resourceType` `fleet-analytics`, `projectId` web's id and `summary` `deleted 1 cost events, 0 stories, 0 reviews, 0 ingest rows marked`.
9. [integration] `DELETE /api/fleet/analytics?before=<instant>` with `{ confirm: 'ALL' }` over one cost event before the instant leaves one entry with `key` `fleet.analytics.delete`, `resourceId` `all` and `projectId` `null`.
10. [integration] `DELETE /api/fleet/analytics?before=<instant>&projectId=<web's id>` with `{ confirm: 'wrong' }` returns 400 and leaves no `fleet.analytics.delete` entry for web's id.
11. [integration] `DELETE /api/fleet/analytics?before=<instant>&projectId=<web's id>` with `{ confirm: 'web' }` when web has no row before the instant returns 200 with every count 0 and leaves no `fleet.analytics.delete` entry for web's id.
12. [unit] `AnalyticsService.deleteRows` with a stub repository whose `deleteRows` returns all-zero counts, a stub transaction manager whose `run` calls its callback and a stub recorder does not call the recorder's `record`; with `costEvents` 1 it calls `record` once with `key` `fleet.analytics.delete`.
