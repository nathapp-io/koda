# SPEC: Whole-repo review P2 remainder (project soft-delete quiesce, placement scan, VCS import, entity graph, optimize lock, agent and comment soft delete)

## Summary

This feature fixes the remaining code findings of the 2026-11-01 whole-repo review
(`docs/20261101-review-whole-repo.md`, Priority Fix Order rows "C carried BUG-1..BUG-5" and "A/BUG-2, A/ENH-1"). The
detailed findings for the carried C items are in the 2026-10-18 review (`docs/20261018-review-whole-repo.md`, Review C
BUG-1 to BUG-5). The user chose one bundle on 2026-11-03 and gave two rulings:

- **Ruling 15 (project soft-delete): full quiesce.** Soft-deleting a project cancels its unstarted fleet jobs, leaves
  running jobs to finish, stops its VCS polling, keeps it out of placement, and keeps its budget pauses in force.
  Schedules and auto-review already skip soft-deleted projects (`PrismaScheduleRepository.findDue` and
  `PrismaFleetRepoRepository`'s auto-review query filter `project: { deletedAt: null }`), so they need no change.
- **A/ENH-1: workflow comments are immutable.** The comment route accepts only `GENERAL`; a `VERIFICATION`,
  `FIX_REPORT` or `REVIEW` comment cannot be edited; deleting any comment is a soft delete.

The fixes:

1. **C/BUG-1 jobs (api).** After a project soft-delete commits, `ProjectsService` emits `PROJECT_SOFT_DELETED` on the
   global `EventEmitter2` with `emitAsync`. A fleet listener cancels the project's QUEUED jobs and its ASSIGNED jobs
   whose ASSIGN was never acked, with reason `project_deleted`.
2. **C/BUG-1 VCS and budget (api).** A VCS listener deactivates the project's VCS connection and unschedules its
   polling. The polling reads skip connections of deleted projects. `scopeExists` keeps a deleted project's budget
   policies, so the budget sweeper no longer deletes them and lifts their pause.
3. **C/BUG-3 (api).** `Ticket` gets `@@unique([projectId, externalVcsId])` (with a migration that clears duplicate
   ids first). An import that loses the race outside any enclosing transaction answers `skipped`; inside an enclosing
   transaction the violation is rethrown, because Postgres has already aborted that transaction. A polling tick skips
   a connection whose previous poll is still running.
4. **C/BUG-2 (api).** `fillRunner` and `fillRunnerThreads` scan only jobs the runner can take (right kind, pinned to
   no runner or to this one, project not deleted), and page through QUEUED with a cursor instead of stopping at the
   50 oldest rows.
5. **C/BUG-4 (api).** The entity graph's `assigned` handler reads `assignedTo` and `assigneeType`, the keys
   `TicketsService.assign` sends, and a DB-backed contract test drives the producer into the consumer.
6. **C/BUG-5 (api).** Every FTS optimize from the strategies runs under `LanceTableManager.exclusive` for its table.
7. **A/BUG-2 (api, two stories).** Deleting an agent is a soft delete: `Agent.deletedAt` is set, the slug is freed,
   the key stops working, and its comments, created tickets and audit rows keep its id. Agent finders and the agent
   auth lookups leave soft-deleted agents out.
8. **A/ENH-1 (api, two stories).** `CreateCommentDto` accepts only `GENERAL` and `update` refuses a workflow comment
   with 409; `delete` sets `Comment.deletedAt` and the comment readers leave soft-deleted rows out.
9. **A/ENH-1 (web).** The comment form drops its type selector and the edit button shows only on `GENERAL` comments.
10. **A/ENH-1 (cli).** `koda comment add` drops `--type` and always posts `GENERAL`.

## Motivation

- **C/BUG-1.** Today soft-deleting a project only sets `deletedAt`. Its QUEUED jobs are still placed on the next
  runner sync and spend real LLM budget for a deleted project; users cannot cancel them because every project route
  404s. `PrismaBudgetRepository.scopeExists` treats the deleted project as gone, so `BudgetSweeper` deletes its
  policies within 60 s and a paused budget stops holding. VCS polling keeps importing issues into the deleted project.
- **C/BUG-2.** `fillRunner` and `fillRunnerThreads` both scan the same 50 oldest QUEUED rows across all projects. 50
  jobs that this runner can never take (pinned elsewhere, the other kind, a deleted project) hide every newer job, and
  nothing moves them out of the window.
- **C/BUG-3.** `VcsSyncService.syncIssue` checks for an existing ticket and then inserts, with no unique key behind
  it. A "Sync now" during a polling tick, two webhook deliveries, or an overlapping tick each import the same issue
  twice. The polling interval has no in-flight guard.
- **C/BUG-4.** `TicketsService.assign` records `{ assignedTo, assigneeType }`, but `EntityGraphService.onTicketEvent`
  reads `assignedToUserId` and `assignedToAgentId`, so no real assignment ever creates a `TICKET_TO_OWNER` link. The
  unit spec feeds the consumer the wrong shape, so it stays green.
- **C/BUG-5.** `LanceTableManager.exclusive` serialises writes per table, and `VectorStoreService.optimizeTable`
  honours it, but the counter, cron and first-access optimize paths call `table.optimize()` directly and can race a
  knowledge `replaceFile`.
- **A/BUG-2.** `DELETE /agents/:slug` is a hard delete. The optional relations default to `SET NULL`, so the agent's
  comments become authorless and its tickets lose `createdByAgentId` and `assignedToAgentId`.
- **A/ENH-1.** Any comment author can edit or hard-delete a `FIX_REPORT` or `REVIEW` after the transition that relied
  on it, and any Viewer can post a workflow-typed comment outside a transition; those comments are indexed into RAG as
  workflow records.

## Design

### Integration

Symbols the feature only reads (verified at `56f2f96d`):

- `AfterCommitService.defer(task): boolean` (`apps/api/src/permissions/after-commit.service.ts`) queues a task for the
  outermost scope and answers false when there is none; `PermissionsModule` is `@Global()` and exports it. The
  pattern `if (!this.afterCommit.defer(task)) await task();` is used by `AgentsService.invalidateAfterCommit`. The
  approval path flushes deferred tasks after `scope()` has left `txManager.run`, so a deferred task never runs inside
  the delete's transaction.
- `EventEmitterModule.forRoot()` is registered in `app.module.ts`; `EventEmitter2` is injectable everywhere.
  `@OnEvent(KNOWLEDGE_REPO_MERGED)` on `KnowledgeIndexQueue` (`apps/api/src/fleet/knowledge/knowledge-index.queue.ts`)
  is the precedent for an in-process event between modules that do not import each other.
- `runAsSystemWriter(writer, fn)` (`apps/api/src/action-context/action-context.ts`) runs `fn` as the system actor of the
  class's `@SystemWriter` key and opens an audit scope; `AuditRecorder.record` must run inside a transaction.
- `FleetJobsService.cancelForBudget` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts`) is the pattern US-001 mirrors:
  lock each job with `repo.lockById(id)` (waits for the row lock, then re-reads it), cancel a QUEUED job or an
  ASSIGNED job whose ASSIGN command is still pending
  (`repo.findPendingCommand({ jobId, type: FleetCommandType.ASSIGN, leaseEpoch })`) through
  `transitions.apply({ job, to: CANCELLED, by: 'server', actor: SYSTEM_ACTOR, reason, extra: { cancelReason: reason } })`.
- `FleetJobLivePublisher.publish(events)` publishes the live events a transition returned; call it after the commit.
- `VcsPollingService.unschedulePolling(connectionId)` removes the interval and the scheduled id.
- `isUniqueViolation(error, field)` (`apps/api/src/common/utils/prisma-errors.ts`) matches a P2002 whose target includes
  `field`; the new index `Ticket_projectId_externalVcsId_key` contains `externalVcsId` and not `number`, so
  `isTicketNumberConflict` does not match it and `runWithTicketNumberRetry` rethrows it.
- `VcsManualSyncService.prepareSyncAll` (`apps/api/src/vcs/vcs-manual-sync.service.ts`) runs `syncIssues(..., { isolate: false })`
  inside the approval execution's transaction; a P2002 there has aborted that transaction.
- `InMemoryEntityStore` (`apps/api/src/entity-graph/in-memory-entity-store.ts`) exposes `findLinksBySource`.
  `EntityGraphOutboxSubscriber` registers `ticket_event` on `FanOutPublisher` and maps the payload to
  `EntityGraphService.onTicketEvent`.
- `LanceTableManager.exclusive(tableName, fn)` is a non-reentrant promise-chain mutex: awaiting it from inside a
  section that already holds the same table deadlocks. `VectorStoreService.addDocument` calls
  `optimizeStrategy.onInsert` both outside and inside a held KB write session (`this.writeSession`).
- `ConflictAppException(args, prefix)` resolves the message `<prefix>.409`; the i18n precedent is
  `"jobState": { "409": "..." }` in `apps/api/src/i18n/en/fleet.json`.
- `system.*` catalog keys: adding one touches `apps/api/src/permissions/catalog.ts`,
  `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` (one row per writer class; the catalog spec
  re-derives the catalog from it), the role-matrix cell count and snapshot, and the writer map in
  `system-writer.decorator.spec.ts` (precedent: `system.pr-fix.follow-up` in #365). The system actor id is the key's
  second segment; `action-context.spec.ts` re-derives the ids, so it needs no edit.
- `AgentsService.create` already maps a P2002 on `slug` to 409.

Symbols the feature changes. The baseline exists only to locate the code; implement the target.

- `ProjectsService` constructor. Baseline: `(projectRepo, ragService, @Optional() hybridRetrieverService, access, audit)`.
  Target: `(projectRepo, ragService, @Optional() hybridRetrieverService, access, audit, afterCommit: AfterCommitService, events: EventEmitter2)`.
  `softDeleteById` and `softDelete` emit `PROJECT_SOFT_DELETED` with `{ projectId }` through `emitAsync` after the
  delete commits.
- `PrismaBudgetRepository.scopeExists`. Baseline: `case 'project'` counts `{ id, deletedAt: null }`. Target: counts
  `{ id }`.
- `PrismaVcsRepository.findVcsConnectionById` and `findPollingConnections`. Baseline: no project filter. Target:
  `project: { deletedAt: null }` in `where` (`findVcsConnectionById` becomes a `findFirst`).
- `PrismaVcsRepository.createTicketFromIssue`. Baseline: answers `CreateTicketFromIssueResult` or throws. Target:
  answers `CreateTicketFromIssueResult | null`; null when the insert hit `isUniqueViolation(error, 'externalVcsId')`
  and `this.txManager.isInTransaction()` was false when the call started; any other error, and that violation inside an
  enclosing transaction, is rethrown.
- `IFleetJobRepository.findQueuedIds(limit)`. Baseline: the 50 oldest QUEUED ids. Target: removed, replaced by
  `findQueuedPage(filter: QueuedScanFilter, limit: number, after: QueuedCursor | null): Promise<QueuedCursor[]>` where
  `QueuedScanFilter = { runnerId: string; threads: boolean }` and `QueuedCursor = { id: string; queuedAt: Date }`.
- `FtsOptimizeStrategy`. Baseline: `onInsert(projectId, table)`, `onFirstAccess(projectId, table)`. Target:
  `onInsert(projectId: string, optimize: OptimizeTask): Promise<void>` and
  `onFirstAccess(projectId: string, optimize: OptimizeTask): void`, with `type OptimizeTask = () => Promise<void>`
  exported from `fts-optimize-strategy.interface.ts`. `optimizeInBackground(optimize, projectId, logger)` takes the
  task. All three strategies (counter, cron, manual) change.
- `PrismaAgentRepository.deleteBySlug` and `deleteById`. Target: removed, replaced by `softDeleteById(id)`.
- `CreateCommentDto.type`. Baseline: `@IsIn(['VERIFICATION', 'FIX_REPORT', 'REVIEW', 'STATUS_CHANGE', 'GENERAL'])` and
  `@ApiProperty({ enum: CommentType })`. Target: `@IsIn(['GENERAL'])` and `@ApiProperty({ enum: ['GENERAL'] })`, still
  optional, default `GENERAL`.

### Approach

**US-001: quiesce after commit.** The event is emitted after the commit, so the listener's transaction never joins
the delete's transaction, and with `emitAsync` so the delete call resolves only after the listeners settled:

```ts
// apps/api/src/projects/project-events.ts
export const PROJECT_SOFT_DELETED = 'projects.project.soft-deleted';
export interface ProjectSoftDeletedEvent { projectId: string }

// ProjectsService.softDeleteById / softDelete, after this.audit.audited(...) returned
const task = async () => { await this.events.emitAsync(PROJECT_SOFT_DELETED, { projectId: deleted.id } satisfies ProjectSoftDeletedEvent); };
if (!this.afterCommit.defer(task)) await task();
```

The fleet listener (`ProjectDeletionJobsListener`, `@SystemWriter('system.project.quiesce')`) never rejects:

```ts
@OnEvent(PROJECT_SOFT_DELETED)
async onProjectSoftDeleted(event: ProjectSoftDeletedEvent): Promise<void> {
  try {
    const result = await runAsSystemWriter(this, () => this.txManager.run(async () => {
      const r = await this.jobs.cancelForProjectDelete(event.projectId);
      await this.audit.record({ key: 'system.project.quiesce', resourceType: 'project', resourceId: event.projectId,
        projectId: event.projectId, summary: `project deleted: ${r.cancelled.length} unstarted jobs cancelled` });
      return r;
    }));
    this.live.publish(result.live);
  } catch (error) {
    this.logger.error(`project ${event.projectId} quiesce failed: ${messageOf(error)}`);
  }
}
```

`FleetJobsService.cancelForProjectDelete(projectId, now = new Date()): Promise<{ cancelled: string[]; live: LiveFleetJobEvent[] }>`
reads `repo.findProjectUnstartedIds(projectId, PROJECT_QUIESCE_LIMIT)` (ids of the project's QUEUED and ASSIGNED jobs with no `cancelRequestedAt`, oldest first, at most `PROJECT_QUIESCE_LIMIT = 500`; when the limit is reached it logs a `warn` naming the project), locks
each with `lockById(id)` (which waits for a concurrent holder and re-reads the row), and cancels it when the locked
row is QUEUED, or ASSIGNED with a pending ASSIGN command, with reason `PROJECT_DELETED_REASON = 'project_deleted'`. A
row that is in any other state once locked (it started, finished or was cancelled meanwhile) is skipped. RUNNING,
UPLOADING and acked ASSIGNED jobs are left to finish.

**US-002.** `VcsProjectDeletionListener` (`@SystemWriter('system.project.quiesce')`) runs
`repo.deactivateConnectionsForProject(projectId): Promise<string[]>` (set `isActive: false` on the project's active
connections, answer their ids) inside `runAsSystemWriter` + `txManager.run`, records one `system.project.quiesce`
entry with `resourceType: 'vcs-connection'` per deactivated connection, then calls `unschedulePolling` for each id
after the commit. Errors are logged, never rethrown.

**US-003.** The migration clears `externalVcsId` on every duplicate except the lowest ticket `number` per
`(projectId, externalVcsId)`, then creates the unique index:

```sql
UPDATE "Ticket" t SET "externalVcsId" = NULL
WHERE t."externalVcsId" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "Ticket" o WHERE o."projectId" = t."projectId" AND o."externalVcsId" = t."externalVcsId" AND o."number" < t."number");
CREATE UNIQUE INDEX "Ticket_projectId_externalVcsId_key" ON "Ticket"("projectId", "externalVcsId");
```

`syncIssue` keeps its existing pre-check and maps a null `createTicketFromIssue` result to
`{ action: 'skipped', reason: 'Ticket with this external VCS ID already exists' }`. Outside a transaction,
`runWithTicketNumberRetry` has already rolled the attempt back when the violation reaches the repository's catch, so
answering null is safe; inside an enclosing transaction (the approval-executed manual sync) the violation propagates
and that transaction fails as a whole. `VcsPollingService` keeps `private readonly inFlight = new Set<string>()`;
`pollConnection` returns at once when the id is in the set, adds it before the poll and deletes it in `finally`.

**US-004: scan composition.** The order is: SQL filter, then the page loop, then the existing per-job checks.

1. `findQueuedPage` filters in SQL: `state: QUEUED`, `project: { deletedAt: null }`, `command` equal to `'THREAD'`
   when `threads` is true and not equal to `'THREAD'` otherwise, and `OR: [{ pinnedRunnerId: null }, { pinnedRunnerId: runnerId }]`.
   It orders by `[{ queuedAt: 'asc' }, { id: 'asc' }]`, takes `limit`, and with `after` adds
   `OR: [{ queuedAt: { gt: after.queuedAt } }, { queuedAt: after.queuedAt, id: { gt: after.id } }]` (both `OR`s go
   under one `AND`).
2. `fillRunner` and `fillRunnerThreads` read pages of `QUEUED_SCAN_LIMIT` (50) rows, starting with `after: null` and
   continuing from the last row of each page, until the free slots reach 0, a page holds fewer than
   `QUEUED_SCAN_LIMIT` rows, or `MAX_QUEUED_SCAN_PAGES` (10, exported from `placement-rules.ts`) pages were read. When
   the page cap ends the scan while slots are still free and the last page was full, the service logs a `warn` naming
   the runner (`.nax/rules/api-data.md` pagination rule).
3. Each scanned id goes through the unchanged loop body: `lockById` with `skipLocked`, the state and kind checks, the
   budget-pause cancel, the misfit check, `assign`.

**US-006.** `VectorStoreService` builds the task for its table and passes it instead of the raw table:

```ts
const optimize: OptimizeTask = () => this.lanceTable.exclusive(`project_${projectId}`, async () => { await table.optimize(); });
```

`CounterOptimizeStrategy.onInsert` at the threshold starts `optimizeInBackground(optimize, projectId, this.logger)`
and resolves without waiting for it, because `onInsert` can run inside a held write session of the same table, and
awaiting `exclusive` there deadlocks; the queued optimize runs once the session releases. `CronOptimizeStrategy` keeps a
`Map<string, OptimizeTask>` and awaits each task on its tick (never inside a held session).
`ManualOptimizeStrategy.onFirstAccess` passes the task to `optimizeInBackground`. The first-access hook passes the
same kind of task.

**US-007.** `PrismaAgentRepository.softDeleteById(id): Promise<AgentWithCapabilities | null>` runs, inside the
caller's transaction, `updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now, status: 'OFFLINE', slug: \`${slug}~deleted-${id}\`, apiKeyHash: 'deleted:' + randomBytes(32).toString('hex') } })`
(the slug read first with `findFirst({ where: { id, deletedAt: null } })`), answers null when no row was found or
updated, and otherwise re-reads the row with `findUnique({ where: { id }, include: { capabilities: true } })`
(`updateManyAndReturn` cannot `include`). Renaming the slug frees it, so a new agent may take the old slug.
`AgentsService.remove(slug)` and `removeById(id)` call it instead of the hard deletes, throw
`NotFoundAppException({}, 'agents')` on null, keep removing the bindings in the same transaction, keep the
`agent.delete` audit entry, and answer the agent as it was before the delete: `softDeleteById` returns the re-read row
with `slug` replaced by the slug it pre-read, so the response DTO and the audit summary `deleted <slug>` carry the
original slug. `deleteBySlug` and `deleteById` are removed.

**US-008.** Every finder in `PrismaAgentRepository` (`findAll`, `findBySlug`, `findById`,
`findBySlugWithCapabilities`, `findBySlugScalar`, `findByIdScalar`, `findByProjectSlug`) and
`PrismaAuthRepository.findAgentByKeyHash` and `findAgentById` add `deletedAt: null` to `where` (keeping
`findUnique` where it is used today; Prisma accepts a non-unique filter next to the unique key).
`PrismaRoleBindingRepository.principalExists` counts an agent only with `deletedAt: null`, so a soft-deleted agent
cannot be granted a new binding. `AgentsService.generateApiKey(agentId)` (key rotation) and
`AgentsService.updateCapabilities` resolve the agent through `findByIdScalar` first and throw
`NotFoundAppException({}, 'agents')` when it answers null, so an approval executed after the delete cannot revive the key
or write capabilities.

**US-009.** `CommentsService.update` throws `new ConflictAppException({}, 'comments.workflowImmutable')` (409) when the
comment's `type` is not `GENERAL`, after the membership check and before the key check; so a project member without `comment.update` gets 409, not 403, for a workflow comment (accepted: the comment can be edited by nobody). The i18n entries are
`"workflowImmutable": { "409": "Workflow comments cannot be edited" }` in `en` and
`"workflowImmutable": { "409": "工作流评论不可编辑" }` in `zh`. `openapi.json` and `apps/cli/src/generated/` are
regenerated with `bun run generate`.

**US-010.** `CommentsService.delete` calls `PrismaCommentRepository.softDelete(id)` (sets `deletedAt`).
`findByTicketId`, `findRecentByTicketId` and `countByTicketId` add `deletedAt: null`; `findOwningProjectAndTicket`
answers null for a soft-deleted comment; `PrismaTicketsRepository.findTicketWithComments` includes only
`comments: { where: { deletedAt: null } }`. `toPersistenceCreate` in `PrismaCommentRepository` is typed over
`Comment`, so it sets `deletedAt: null` on create; `CommentDomain` gains no field and `toPersistenceUpdate` is unchanged.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| US-001: the fleet listener's transaction throws | logged at error level, the soft-delete response is unaffected, nothing is published |
| US-001: a job of the project changes state while `cancelForProjectDelete` waits for its row lock | the re-read row is checked; a job no longer QUEUED or unacked ASSIGNED is skipped |
| US-002: the VCS listener throws | logged at error level; the next polling tick still unschedules because `findVcsConnectionById` no longer returns a deleted project's connection |
| US-003: the insert loses the race on `(projectId, externalVcsId)` outside a transaction | `syncIssue` answers `skipped` |
| US-003: the same race inside an enclosing transaction | the P2002 is rethrown; the enclosing transaction fails |
| US-003: a tick fires while the previous poll of the same connection runs | the tick returns without polling |
| US-004: more than `MAX_QUEUED_SCAN_PAGES` full pages of candidates | the fill stops after 10 pages and logs a `warn`; later jobs wait for the next sync |
| US-006: an optimize rejects | logged at warn level, as today |
| US-007: deleting an agent that is already soft-deleted, or deleted concurrently | 404 (`NotFoundAppException`, `agents`) |
| US-009: editing a `VERIFICATION`, `FIX_REPORT` or `REVIEW` comment | 409 `comments.workflowImmutable` |
| US-010: editing or deleting a soft-deleted comment | 404 `comments` |

## Out of Scope

- The deploy and release items of the review (E SEC-3..SEC-8, BUG-4: `change-me` secrets, a non-root API image, unpublished API and Ollama ports, token TTLs, `release.yml` permissions, pins and tag checkout) are done by hand in a separate PR; no story touches `docker-compose*.yml`, `deployments/`, `apps/api/Dockerfile` or `.github/workflows/`.
- There is no project restore path; restoring a soft-deleted project and re-queuing the jobs cancelled by US-001 are not added.
- `.nax/rules/api-data.md` says "Soft-delete Projects/Tickets only"; after US-007 and US-010 agents and comments are soft-deleted too. The rule file is read-only to the run; the user updates it after merge.
- US-001 only: RUNNING, UPLOADING and acked ASSIGNED jobs of a deleted project are not cancelled; they finish and report as usual (ruling 15).
- US-001 only: schedules and auto-review need no change: `findDue` and the auto-review query already filter `project: { deletedAt: null }`; schedules are not disabled in the database.
- US-001 only: no hard-delete of a project is added, so budget policies of a soft-deleted project are kept indefinitely.
- US-002 only: the VCS webhook intake of a deleted project is not changed; `findVcsConnectionByProjectSlug` already filters `deletedAt`.
- US-003 only: the approval-executed manual sync (`prepareSyncAll`, `isolate: false`) fails as a whole when it loses the import race; it is not made to skip, because its transaction is already aborted.
- US-003 only: the webhook `issues.opened` path and the manual sync routes get no in-flight guard of their own; the unique index makes their race either `skipped` (no enclosing transaction) or a failed request.
- US-004 only: a QUEUED job whose misfit is permanent is not expired or cancelled; it stays QUEUED and is shown by the dashboard.
- US-004 only: label and profile matching stay in the per-job check; only kind, pin and project deletion move into SQL.
- US-004 only: the dashboard dry-run keeps reading `findQueuedWindow(QUEUED_SCAN_LIMIT)`; its window is not paged.
- US-004 only: no new `FleetJob` index is added; `findQueuedPage` uses the existing `@@index([state])` (QUEUED rows are few), and a `(state, queuedAt)` index is a follow-up if that changes.
- US-004 only: `placeJob` (dispatch and requeue) is unchanged; a deleted project's routes already 404 before dispatch.
- US-005 only: assignment removal (`assignedTo: null`) does not delete an existing `TICKET_TO_OWNER` link.
- US-006 only: `VectorStoreService.optimizeTable` already runs under `exclusive` and is unchanged.
- US-007 only: other modules that join `Agent` for display (audit, tickets, assignees, notifications, reviews, schedules) keep reading the row, so a deleted agent's name still shows on its past work.
- US-008 only: `PrismaTicketsRepository`'s agent lookup for assignment, `PrismaScheduleRepository.findOwnerAccess`, `PrismaAssistantToolCallRepository` and `PrismaFleetPrReviewRepository` agent reads are not filtered by `deletedAt`; a deleted agent has no bindings (so every permission check refuses it) and is `OFFLINE` (so assignment refuses it).
- US-010 only: a soft-deleted comment's RAG document and notification rows are not removed; `ticket-notification-reads.repository.ts` keeps its lookup.
- US-009 only: workflow comments written by ticket transitions (`PrismaTicketsRepository`, `PrismaFleetTicketsRepository`) and by `PrismaVcsRepository` are unchanged; `CommentsService.create` itself does not re-check the type, the DTO does.
- US-010 only: deleting a workflow comment stays allowed under `comment.delete` / `comment.delete.own`; it is now a soft delete.
- US-011 only: existing workflow comments keep their type pill; only the form and the edit button change.

## Stories

This bundle has 12 stories, one package each: 10 api, 1 web, 1 cli. It is a bundle of independent P2 fixes, not one
capability; the user chose one bundle on 2026-11-03, as for #384, #385 and #386. The agent and comment fixes are split
into two stories each to stay near the resolved story-size gate (`maxAcCount` 15, `maxBulletPoints` 15, `action: warn`).

### US-001: Soft-deleting a project cancels its unstarted fleet jobs

No dependencies. Workdir: apps/api. C/BUG-1 (jobs): `PROJECT_SOFT_DELETED` and its `emitAsync` after commit,
`FleetJobsService.cancelForProjectDelete`, `findProjectUnstartedIds`, `ProjectDeletionJobsListener`, and the new
`system.project.quiesce` catalog key.

### US-002: Soft-deleting a project stops its VCS polling and keeps its budget pauses

Depends on US-001. Workdir: apps/api. C/BUG-1 (VCS and budget): `VcsProjectDeletionListener`,
`deactivateConnectionsForProject`, the `deletedAt` filter in the polling reads, and `scopeExists` for deleted projects.

### US-003: A VCS issue imports into at most one ticket per project

No dependencies. Workdir: apps/api. C/BUG-3: the unique index and its migration, the null result outside a
transaction mapped to `skipped`, and the polling in-flight guard.

### US-004: Runner fills scan only jobs the runner can take and page past the first 50

No dependencies. Workdir: apps/api. C/BUG-2 (and the placement half of C/BUG-1): `findQueuedPage`,
`MAX_QUEUED_SCAN_PAGES`, the page loop and its cap warning in `fillRunner` and `fillRunnerThreads`.

### US-005: Ticket assignments create owner links in the entity graph

No dependencies. Workdir: apps/api. C/BUG-4: the `assigned` handler reads `assignedTo` and `assigneeType`, plus the
producer-to-consumer contract test.

### US-006: FTS optimize runs under the table's write lock

No dependencies. Workdir: apps/api. C/BUG-5: `OptimizeTask`, the three strategy signatures, `optimizeInBackground`,
and the `exclusive`-wrapped task built by `VectorStoreService`.

### US-007: Deleting an agent is a soft delete that frees its slug

No dependencies. Workdir: apps/api. A/BUG-2 (write side): `Agent.deletedAt` and its migration, `softDeleteById` with
the slug rename and dead key, and `AgentsService.remove` / `removeById`.

### US-008: Agent lookups and agent authentication ignore soft-deleted agents

Depends on US-007. Workdir: apps/api. A/BUG-2 (read side): the `deletedAt: null` filters in `PrismaAgentRepository`
finders, `PrismaAuthRepository.findAgentByKeyHash` / `findAgentById` and `PrismaRoleBindingRepository.principalExists`,
and the 404 for key rotation and capability updates on a deleted agent.

### US-009: Only GENERAL comments can be created through the comment route and workflow comments cannot be edited

No dependencies. Workdir: apps/api. A/ENH-1 (create and edit): `CreateCommentDto` GENERAL-only, the 409
`comments.workflowImmutable`, and the regenerated `openapi.json` and CLI client.

### US-010: Deleting a comment is a soft delete

Depends on US-009. Workdir: apps/api. A/ENH-1 (delete): `Comment.deletedAt` and its migration,
`PrismaCommentRepository.softDelete`, and the reader filters.

### US-011: The web comment form posts only GENERAL and edits only GENERAL comments

Depends on US-009. Workdir: apps/web. A/ENH-1 (web): `CommentThread.vue` drops the type field and gates the edit button.

### US-012: The CLI comment command posts only GENERAL comments

Depends on US-009. Workdir: apps/cli. A/ENH-1 (cli): `koda comment add` drops `--type`.

### Context Files

**US-001**

- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/permissions/after-commit.service.ts`
- `apps/api/src/fleet/knowledge/knowledge-index.queue.ts`

**US-002**

- `apps/api/src/vcs/vcs-polling.service.ts`
- `apps/api/src/vcs/prisma-vcs.repository.ts`
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts`
- `apps/api/src/fleet/budgets/budget-sweeper.ts`
- `apps/api/src/fleet/jobs/project-deletion-jobs.listener.ts` — created by US-001, the listener shape to mirror

**US-003**

- `apps/api/src/vcs/vcs-sync.service.ts`
- `apps/api/src/vcs/prisma-vcs.repository.ts`
- `apps/api/src/vcs/vcs-polling.service.ts`
- `apps/api/src/vcs/vcs-manual-sync.service.ts`
- `apps/api/src/common/utils/ticket-number-retry.ts`

**US-004**

- `apps/api/src/fleet/jobs/placement.service.ts`
- `apps/api/src/fleet/jobs/placement-rules.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`

**US-005**

- `apps/api/src/entity-graph/entity-graph.service.ts`
- `apps/api/src/entity-graph/entity-graph-outbox.subscriber.ts`
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/entity-graph/in-memory-entity-store.ts`
- `apps/api/test/integration/entity-graph/outbox-fanout-entity-graph.integration.spec.ts`

**US-006**

- `apps/api/src/rag/strategies/fts-optimize-strategy.interface.ts`
- `apps/api/src/rag/strategies/counter-optimize.strategy.ts`
- `apps/api/src/rag/strategies/cron-optimize.strategy.ts`
- `apps/api/src/rag/vector-store.service.ts`
- `apps/api/src/rag/lance-table-manager.ts`

**US-007**

- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/agents/prisma-agent.repository.ts`
- `apps/api/src/agents/agents.controller.ts`
- `apps/api/prisma/schema.prisma`

**US-008**

- `apps/api/src/agents/prisma-agent.repository.ts`
- `apps/api/src/auth/prisma-auth.repository.ts`
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/permissions/prisma-role-binding.repository.ts`

**US-009**

- `apps/api/src/comments/comments.service.ts`
- `apps/api/src/comments/dto/create-comment.dto.ts`
- `apps/api/src/i18n/en/fleet.json`
- `apps/api/src/i18n/en/comments.json`

**US-010**

- `apps/api/src/comments/comments.service.ts`
- `apps/api/src/comments/prisma-comment.repository.ts`
- `apps/api/src/tickets/prisma-tickets.repository.ts`
- `apps/api/prisma/schema.prisma`

**US-011**

- `apps/web/components/CommentThread.vue`
- `apps/web/tests/components/CommentThread.spec.ts`
- `apps/web/tests/components/CommentThread-edit.spec.ts`

**US-012**

- `apps/cli/src/commands/comment.ts`
- `apps/cli/src/commands/comment.spec.ts`

### Creates

**US-001**

- `apps/api/src/projects/project-events.ts`
- `apps/api/src/fleet/jobs/project-deletion-jobs.listener.ts`
- `apps/api/src/fleet/jobs/project-deletion-jobs.listener.spec.ts`
- `apps/api/test/integration/fleet/project-deletion-quiesce.integration.spec.ts`

**US-002**

- `apps/api/src/vcs/vcs-project-deletion.listener.ts`
- `apps/api/src/vcs/vcs-project-deletion.listener.spec.ts`
- `apps/api/test/integration/vcs/vcs-project-deletion.integration.spec.ts`

**US-003**

- `apps/api/prisma/migrations/20261120090000_ticket_external_vcs_unique/migration.sql`
- `apps/api/test/integration/vcs/vcs-import-unique.integration.spec.ts`

**US-004**

- `apps/api/src/fleet/jobs/placement.service.queued-scan.spec.ts`
- `apps/api/test/integration/fleet/placement-queued-scan.integration.spec.ts`

**US-005**

- `apps/api/test/integration/entity-graph/assign-owner-link.integration.spec.ts`

**US-007**

- `apps/api/prisma/migrations/20261120100000_agent_soft_delete/migration.sql`
- `apps/api/test/integration/agents/agent-soft-delete.integration.spec.ts`

**US-008**

- `apps/api/test/integration/agents/agent-soft-delete-reads.integration.spec.ts`

**US-009**

- `apps/api/src/comments/dto/create-comment.dto.spec.ts`
- `apps/api/test/integration/comments/comment-workflow-immutable.integration.spec.ts`

**US-010**

- `apps/api/prisma/migrations/20261120110000_comment_soft_delete/migration.sql`
- `apps/api/test/integration/comments/comment-soft-delete.integration.spec.ts`

### Modifies

**US-001**

- `apps/api/src/projects/projects.service.spec.ts` — the suite constructs `new ProjectsService(...)` with five arguments; the constructor gains `afterCommit` and `events`, so the construction passes an `AfterCommitService` whose `defer` answers false and an `EventEmitter2` double whose `emitAsync` resolves; every existing assertion keeps its meaning.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — the suite constructs `new ProjectsService(...)` with five arguments; it passes the same two extra doubles; assertions unchanged.
- `apps/api/src/projects/projects-brief.routes.spec.ts` — the testing module lists `ProjectsService` as a provider; it adds `AfterCommitService` and an `EventEmitter2` provider so DI resolves; assertions unchanged.
- `apps/api/test/unit/projects/projects-conflict-responses.spec.ts` — the testing module lists `ProjectsService` as a provider; it adds `AfterCommitService` and an `EventEmitter2` provider so DI resolves; assertions unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` — registers `ProjectDeletionJobsListener` as a provider.
- `apps/api/src/permissions/catalog.ts` — adds `'system.project.quiesce': ['system']`.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — adds one `system` row for the `ProjectDeletionJobsListener` writer class with `proposed_key` `system.project.quiesce` and `catalog_scope` `system`, so the catalog spec re-derives the new key.
- `apps/api/src/permissions/role-matrix.spec.ts` — the per-role cell count `toHaveLength(224)` becomes `toHaveLength(225)` for the new catalog key.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated with `bunx vitest run -u` for the new key's `non-role-key` cells; no other cell changes.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer map gains `[ProjectDeletionJobsListener, 'system.project.quiesce']`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `IFleetJobRepository` gains `findProjectUnstartedIds(projectId: string, limit: number): Promise<string[]>`.

**US-002**

- `apps/api/src/vcs/vcs.module.ts` — registers `VcsProjectDeletionListener` as a provider.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writer map gains `[VcsProjectDeletionListener, 'system.project.quiesce']`.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — adds one `system` row for the `VcsProjectDeletionListener` writer class with `proposed_key` `system.project.quiesce`.
- `apps/api/test/integration/fleet/fleet-budget-repository.integration.spec.ts` — the test "knows which scope rows exist, treating a soft-deleted project as gone (D166)" soft-deletes a project and expects `false`; it now expects `true` and its title says a soft-deleted project's scope still exists, because a soft-deleted project's budget scope stays in force until a hard delete (ruling 15).

**US-003**

- `apps/api/prisma/schema.prisma` — `Ticket` gains `@@unique([projectId, externalVcsId])`; the existing `@@index([externalVcsId])` stays.

**US-004**

- `apps/api/src/fleet/jobs/placement.service.trust-domain.spec.ts` — the repository double provides `findQueuedIds`; it provides `findQueuedPage` answering the same jobs as `{ id, queuedAt }` rows (an empty page after them); assertions unchanged.
- `apps/api/src/fleet/jobs/placement.service.project-code.spec.ts` — the repository double provides `findQueuedIds`; it provides `findQueuedPage` answering the same job as a `{ id, queuedAt }` row; assertions unchanged.
- `apps/api/src/fleet/jobs/placement.service.project-thread.spec.ts` — the repository double provides `findQueuedIds` and one test asserts it was called; it provides `findQueuedPage` and asserts `findQueuedPage` was called with `{ runnerId, threads: true }`.
- `apps/api/src/fleet/jobs/placement.service.koda-tools.spec.ts` — the repository double provides `findQueuedIds`; it provides `findQueuedPage` answering the same job as a `{ id, queuedAt }` row; assertions unchanged.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `IFleetJobRepository.findQueuedIds` is replaced by `findQueuedPage`, and `QueuedScanFilter` and `QueuedCursor` are exported.

**US-005**

- `apps/api/src/entity-graph/entity-graph.service.spec.ts` — the "AC3: onTicketEvent(assignment) creates owner node and links to ticket" tests feed `{ assignedToUserId }` / `{ assignedToAgentId }`, a shape no producer emits; they feed `{ assignedTo, assigneeType: 'user' | 'agent' }` and keep their expected owner node and link.

**US-006**

- `apps/api/src/rag/strategies/counter-optimize.strategy.spec.ts` — the tests pass a fake table and assert `table.optimize` was called; they pass an `OptimizeTask` mock and assert the task was called; the threshold test no longer expects `onInsert` to wait for the optimize.
- `apps/api/src/rag/strategies/cron-optimize.strategy.spec.ts` — the tests pass fake tables to `onInsert`; they pass `OptimizeTask` mocks and assert each dirty task runs once per tick.
- `apps/api/src/rag/strategies/manual-optimize.strategy.spec.ts` — `onFirstAccess` receives an `OptimizeTask` mock instead of a table; assertions keep their meaning.
- `apps/api/src/rag/strategies/optimize-strategies.spec.ts` — strategies receive `OptimizeTask` mocks instead of tables; assertions keep their meaning.
- `apps/api/src/rag/vector-store.service.spec.ts` — a test asserting `optimizeStrategy.onInsert` was called with the table now expects a function as the second argument.

**US-007**

- `apps/api/prisma/schema.prisma` — `Agent` gains `deletedAt DateTime?` and `@@index([deletedAt])`.
- `apps/api/src/agents/agents.service.spec.ts` — tests of `remove` and `removeById` expect `deleteBySlug` / `deleteById`; they expect `softDeleteById` with the agent id, and a missing agent still answers 404.
- `apps/api/src/agents/prisma-agent.repository.spec.ts` — tests of `deleteBySlug` and `deleteById` are replaced by tests of `softDeleteById`.
- `apps/api/src/agents/agents-audit.spec.ts` — the repository double provides `deleteBySlug` and a delete test drives it; it provides `softDeleteById` instead; the expected `agent.delete` entry is unchanged.
- `apps/api/test/integration/permissions/gated-admin-delete-routes.integration.spec.ts` — the agent delete tests (AC-3/AC-4 and AC-5) expect `db.agent.findUnique({ where: { id: target.id } })` to be null after the executed delete; they now expect the row with `deletedAt` set; the `slug: target.slug` result and response assertions are unchanged, because the delete answers the original slug.
- `apps/api/test/integration/audit/audit-core-agents.integration.spec.ts` — "AC-13/14: delete removes agent and bindings with one audit entry" expects `db.agent.findUnique({ where: { id } })` to be null; it now expects the row with `deletedAt` set; the bindings and audit-entry assertions are unchanged.

**US-008**

- `apps/api/src/agents/agents.service.spec.ts` — the `generateApiKey('agent-123')` rotation tests (and any `updateCapabilities` test) use a repository double whose `findByIdScalar` is a bare `vi.fn()` answering undefined; those tests make `findByIdScalar` answer the agent so rotation and capability updates still succeed; their assertions are unchanged.
- `apps/api/src/agents/agents-audit.spec.ts` — the repository double has no `findByIdScalar`; it gains one answering the test agent, so the `updateCapabilities` and key-rotation audit tests still record their entries.
- `apps/api/src/agents/prisma-agent.repository.spec.ts` — finder tests that pin a `where` argument with `toHaveBeenCalledWith` now expect `deletedAt: null` in it.
- `apps/api/src/auth/prisma-auth.repository.spec.ts` — "findAgentById selects the actor fields by id" expects `findUnique` with `where: { id: 'a1' }`; it now expects `where: { id: 'a1', deletedAt: null }`; the `findAgentByKeyHash` test that pins its `where` expects `deletedAt: null` too.

**US-009**

- `openapi.json` — regenerated with `bun run generate`: the comment-create `type` enum becomes `GENERAL` only.
- `apps/cli/src/generated/types.gen.ts` — regenerated with `bun run generate`: the comment-create `type` union becomes `'GENERAL'`.
- `apps/api/src/i18n/en/comments.json` — adds `"workflowImmutable": { "409": "Workflow comments cannot be edited" }`.
- `apps/api/src/i18n/zh/comments.json` — adds `"workflowImmutable": { "409": "工作流评论不可编辑" }`.

**US-010**

- `apps/api/prisma/schema.prisma` — `Comment` gains `deletedAt DateTime?`; `@@index([ticketId])` stays.
- `apps/api/src/comments/comments.service.spec.ts` — tests of `delete` expect `commentRepo.delete`; they expect `commentRepo.softDelete` with the comment id; the audit expectation is unchanged.
- `apps/api/src/comments/prisma-comment.repository.spec.ts` — the `findByTicketId` and `findRecentByTicketId` tests expect `findMany` with `where: { ticketId: 't1' }`, and the `countByTicketId` test expects `count` with `{ where: { ticketId: 't1' } }`; all three now expect `deletedAt: null` next to `ticketId`.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — after the root comment delete request it expects `prisma.comment.findUnique` to resolve to null; it now expects the row with `deletedAt` set.

**US-011**

- `apps/web/tests/components/CommentThread.spec.ts` — tests that select a comment type or expect the type field in the form now expect no type field and a `GENERAL` post.
- `apps/web/tests/components/CommentThread-edit.spec.ts` — fixtures that edit a workflow-typed comment now use a `GENERAL` comment; a workflow-typed comment shows no edit button.

**US-012**

- `apps/cli/src/commands/comment.spec.ts` — the `--type` tests ("posts comment with explicit uppercase type FIX_REPORT", "exits with code 3 when --type is lowercase general", the valid-types loop) are removed; the add command posts `type: 'GENERAL'`.

### Seams

- US-001 → US-002: `PROJECT_SOFT_DELETED` and `ProjectSoftDeletedEvent` (created in US-001) are consumed by
  `VcsProjectDeletionListener`; US-002's seam AC triggers the real `ProjectsService.softDeleteById` and asserts the
  VCS listener's effect.
- US-001: `ProjectsService.softDeleteById` emits the event (same story); the integration AC triggers
  `ProjectsService.softDeleteById` with a real `EventEmitter2` and asserts the listener's effect once it resolves.
- US-004: `fillRunner` calls `findQueuedPage` (same story); the ACs trigger `fillRunner` and `fillRunnerThreads`.
- US-006: `VectorStoreService.addDocument` passes an `OptimizeTask` to `onInsert` (same story); the AC triggers
  `addDocument` and asserts `exclusive` wrapped the optimize.
- US-007 → US-008: `Agent.deletedAt` (created in US-007) is the column US-008 filters on.
- US-009 → US-011, US-012: the 400 for a workflow `type` on create is the contract the web form and the CLI follow.

## Acceptance Criteria

### US-001: Soft-deleting a project cancels its unstarted fleet jobs

- `[unit]` `PROJECT_SOFT_DELETED` is importable from `projects/project-events` and equals `'projects.project.soft-deleted'`.
- `[unit]` `ProjectsService.softDeleteById('p1')` with an `AfterCommitService` whose `defer` answers false calls `EventEmitter2.emitAsync` once with `PROJECT_SOFT_DELETED` and `{ projectId: 'p1' }`.
- `[unit]` with an `AfterCommitService` whose `defer` answers true, `softDeleteById('p1')` does not call `emitAsync` until the deferred task runs.
- `[unit]` `ProjectsService.softDeleteById('missing')` whose repository answers null throws `NotFoundAppException` and never calls `emitAsync`.
- `[unit]` `ProjectsService.softDelete('alpha')` calls `emitAsync` once with `PROJECT_SOFT_DELETED` and the deleted project's id.
- `[unit]` `FleetJobsService.cancelForProjectDelete('p1')` over a QUEUED job applies a transition to `CANCELLED` whose `extra.cancelReason` is `'project_deleted'`.
- `[unit]` `cancelForProjectDelete` over an ASSIGNED job whose ASSIGN command is still pending cancels it with the same reason.
- `[unit]` `cancelForProjectDelete` applies no transition to a RUNNING job, an UPLOADING job, or an ASSIGNED job with no pending ASSIGN command.
- `[unit]` `cancelForProjectDelete` skips a job whose row, once locked, is no longer QUEUED or ASSIGNED.
- `[unit]` when `findProjectUnstartedIds` answers `PROJECT_QUIESCE_LIMIT` ids, `cancelForProjectDelete` logs one `warn` naming the project.
- `[unit]` `ProjectDeletionJobsListener.onProjectSoftDeleted({ projectId: 'p1' })` records one audit entry with key `system.project.quiesce` and `resourceId` `'p1'`.
- `[unit]` after the transaction resolves, the listener calls `FleetJobLivePublisher.publish` with the `live` events `cancelForProjectDelete` answered.
- `[unit]` when `cancelForProjectDelete` rejects, `onProjectSoftDeleted` resolves, logs at error level, and never calls `publish`.
- `[integration]` with a project holding one QUEUED job and one RUNNING job, after `ProjectsService.softDeleteById` resolves (real `EventEmitter2`, real listener) the QUEUED job is `CANCELLED` with `cancelReason` `project_deleted` and the RUNNING job is still `RUNNING`.
- `[integration]` in that run, a QUEUED job of another project stays `QUEUED`.

### US-002: Soft-deleting a project stops its VCS polling and keeps its budget pauses

- `[unit]` `VcsProjectDeletionListener.onProjectSoftDeleted({ projectId: 'p1' })` calls `VcsPollingService.unschedulePolling` once for each id `deactivateConnectionsForProject('p1')` answered.
- `[unit]` the listener records one audit entry with key `system.project.quiesce` and `resourceType` `'vcs-connection'` per deactivated connection.
- `[unit]` the listener records no audit entry when `deactivateConnectionsForProject` answers an empty list.
- `[unit]` when `deactivateConnectionsForProject` rejects, the listener resolves, logs at error level, and never calls `unschedulePolling`.
- `[integration]` `deactivateConnectionsForProject('p1')` sets `isActive` false on the active connection of project p1 and answers its id.
- `[integration]` in that call, another project's connection stays active.
- `[integration]` `findPollingConnections()` leaves out an active polling connection whose project is soft-deleted.
- `[integration]` `findVcsConnectionById(id)` answers null for a connection whose project is soft-deleted.
- `[integration]` `PrismaBudgetRepository.scopeExists({ scopeType: 'project', scopeId })` answers true for a soft-deleted project.
- `[integration]` `BudgetSweeper.tick()` over a paused project policy of a soft-deleted project keeps the policy row with its `pausedAt`.
- `[integration]` after `ProjectsService.softDeleteById` resolves for a project with an active polling connection (real `EventEmitter2`, real listeners), that connection is `isActive` false.

### US-003: A VCS issue imports into at most one ticket per project

- `[integration]` inserting a second ticket with the same `projectId` and `externalVcsId` fails with Prisma error code `P2002`.
- `[integration]` two tickets with the same `externalVcsId` in different projects are both stored.
- `[integration]` two tickets with a null `externalVcsId` in one project are both stored.
- `[integration]` `createTicketFromIssue` called outside any transaction for an `externalVcsId` that another ticket of the project already holds answers null and creates no ticket.
- `[integration]` the same call made inside an open `txManager.run` rejects with the P2002 instead of answering null.
- `[unit]` `VcsSyncService.syncIssue` whose `createTicketFromIssue` answers null answers `{ action: 'skipped', reason: 'Ticket with this external VCS ID already exists' }`.
- `[integration]` two concurrent `syncIssue` calls for the same issue in one project, outside any transaction, produce exactly one ticket, and one of the two results is `skipped`.
- `[unit]` a polling tick for connection c1 fired while c1's previous poll has not settled calls `findVcsConnectionById` once in total, not twice.
- `[unit]` after c1's poll rejects, the next tick for c1 polls again.
- `[unit]` a tick for connection c2 runs while a poll of c1 is still in flight.

### US-004: Runner fills scan only jobs the runner can take and page past the first 50

- `[unit]` `MAX_QUEUED_SCAN_PAGES` is importable from `fleet/jobs/placement-rules` and equals `10`.
- `[integration]` `findQueuedPage({ runnerId: 'r1', threads: false }, 50, null)` leaves out a QUEUED job pinned to runner r2.
- `[integration]` the same call answers a QUEUED job pinned to r1 and an unpinned QUEUED job.
- `[integration]` `findQueuedPage({ runnerId: 'r1', threads: false }, 50, null)` leaves out a QUEUED `THREAD` job.
- `[integration]` `findQueuedPage({ runnerId: 'r1', threads: true }, 50, null)` answers only `THREAD` jobs.
- `[integration]` `findQueuedPage` leaves out a QUEUED job whose project is soft-deleted.
- `[integration]` `findQueuedPage(filter, 2, after)` with `after` set to the second row of a first page answers the next two rows by `queuedAt` then `id`, including a row with the same `queuedAt` and a greater `id`.
- `[unit]` `fillRunner('r1', 1)` whose first page holds 50 misfitting jobs and whose second page holds one fitting job assigns that job, calling `findQueuedPage` the second time with the first page's last row as `after`.
- `[unit]` `fillRunner('r1', 1)` stops reading pages once the slot is filled.
- `[unit]` `fillRunner('r1', 1)` stops after a page shorter than `QUEUED_SCAN_LIMIT`.
- `[unit]` `fillRunner('r1', 1)` whose every page holds 50 misfitting jobs calls `findQueuedPage` exactly `MAX_QUEUED_SCAN_PAGES` times, assigns nothing, and logs one `warn` naming runner r1.
- `[unit]` `fillRunner` calls `findQueuedPage` with `{ runnerId: 'r1', threads: false }`, and `fillRunnerThreads` with `{ runnerId: 'r1', threads: true }`.
- `[unit]` a paged QUEUED job in a paused budget scope is still cancelled by `fillRunner` with the budget reason.

### US-005: Ticket assignments create owner links in the entity graph

- `[unit]` `EntityGraphService.onTicketEvent` with action `assigned` and data `{ assignedTo: 'u1', assigneeType: 'user' }` upserts owner node `owner:u1` with metadata `{ userId: 'u1' }` and a `TICKET_TO_OWNER` link from the ticket.
- `[unit]` `onTicketEvent` with action `assigned` and data `{ assignedTo: 'a1', assigneeType: 'agent' }` upserts owner node `owner:a1` with metadata `{ agentId: 'a1' }` and a `TICKET_TO_OWNER` link.
- `[unit]` `onTicketEvent` with action `assigned` and data `{ assignedTo: null, assigneeType: null }` upserts the ticket node and creates no owner link.
- `[unit]` `onTicketEvent` with action `assigned` and data `{ assignedTo: 'x1' }` with no `assigneeType` creates no owner link.
- `[integration]` `TicketsService.assign` assigning a user to a ticket writes a `ticket_event` outbox payload that, handed to the `ticket_event` handler `EntityGraphOutboxSubscriber` registers on `FanOutPublisher` (backed by `InMemoryEntityStore`), creates a `TICKET_TO_OWNER` link from that ticket to `owner:<userId>`.
- `[integration]` the same contract for an agent assignee creates a `TICKET_TO_OWNER` link to `owner:<agentId>`.

### US-006: FTS optimize runs under the table's write lock

- `[unit]` `CounterOptimizeStrategy.onInsert('p1', optimize)` below the threshold never calls `optimize`.
- `[unit]` `onInsert` at the threshold calls `optimize` once and resolves before the promise `optimize` returned settles.
- `[unit]` when the `optimize` started at the threshold rejects, the strategy logs a warning naming the project and no unhandled rejection occurs.
- `[unit]` `CronOptimizeStrategy.onInsert('p1', optimize)` does not call `optimize`, and the next `optimizeDirtyTables()` calls it once.
- `[unit]` a second `optimizeDirtyTables()` with no insert in between does not call that task again.
- `[unit]` `ManualOptimizeStrategy.onFirstAccess('p1', optimize)` calls `optimize` once without awaiting it.
- `[unit]` `VectorStoreService.addDocument` for project p1 calls `onInsert` with `'p1'` and a task that, when run, calls `LanceTableManager.exclusive` with `'project_p1'` and only inside it `table.optimize`.
- `[unit]` the first-access hook built by `VectorStoreService.getOrCreateTable('p1')` passes `onFirstAccess` a task that runs `table.optimize` inside `exclusive('project_p1', ...)`.
- `[integration]` with a held KB write session on project p1's table, an `addDocument` inside it that reaches the counter threshold completes, and the optimize runs after the session ends.

### US-007: Deleting an agent is a soft delete that frees its slug

- `[integration]` `PrismaAgentRepository.softDeleteById(id)` sets the row's `deletedAt`.
- `[integration]` after `softDeleteById(id)` the row's `status` is `OFFLINE`.
- `[integration]` after `softDeleteById(id)` the row's `apiKeyHash` starts with `deleted:`.
- `[integration]` after `softDeleteById(id)` the row's `slug` is the old slug followed by `~deleted-` and the agent id.
- `[integration]` `softDeleteById(id)` answers the agent with its capabilities and its original slug.
- `[integration]` `softDeleteById` on an already soft-deleted agent answers null.
- `[integration]` after `AgentsService.removeById(id)`, the agent's comment keeps `authorAgentId` and its created ticket keeps `createdByAgentId`.
- `[integration]` after `AgentsService.removeById(id)`, its assigned ticket keeps `assignedToAgentId`.
- `[integration]` after `AgentsService.remove(slug)`, the agent's role bindings are gone and one `agent.delete` audit entry names the agent's id.
- `[unit]` `AgentsService.removeById(id)` whose `softDeleteById` answers null throws `NotFoundAppException`.
- `[unit]` `AgentsService.remove(slug)` whose `softDeleteById` answers null (a concurrent delete) throws `NotFoundAppException`.
- `[integration]` `DELETE /api/agents/:slug` by the Owner with no wait policy seeded answers 200, and a second `DELETE` of the same slug answers 404.
- `[integration]` that `DELETE` response's `slug` is the original slug, and the `agent.delete` audit summary is `deleted <original slug>`.
- `[integration]` after that delete, `POST /api/agents` with the old slug answers 201 with a new agent id.

### US-008: Agent lookups and agent authentication ignore soft-deleted agents

- `[integration]` `PrismaAgentRepository.findBySlug` does not answer a soft-deleted agent.
- `[integration]` `PrismaAgentRepository.findById` does not answer a soft-deleted agent.
- `[integration]` `PrismaAgentRepository.findAll` does not list a soft-deleted agent.
- `[integration]` `PrismaAgentRepository.findByProjectSlug` does not list a soft-deleted agent.
- `[integration]` `PrismaAuthRepository.findAgentByKeyHash` with a soft-deleted agent's stored `apiKeyHash` answers null.
- `[integration]` `PrismaAuthRepository.findAgentById` with a soft-deleted agent's id answers null.
- `[integration]` an API request authenticated with a soft-deleted agent's former API key answers 401.
- `[integration]` `PrismaRoleBindingRepository.principalExists({ type: 'AGENT', id })` answers false for a soft-deleted agent.
- `[unit]` `AgentsService.generateApiKey(agentId)` whose `findByIdScalar` answers null throws `NotFoundAppException` and never calls `updateApiKeyHash`.
- `[unit]` `AgentsService.updateCapabilities` for an agent whose `findByIdScalar` answers null throws `NotFoundAppException` and writes no capability rows.

### US-009: Only GENERAL comments can be created through the comment route and workflow comments cannot be edited

- `[unit]` validating `CreateCommentDto` with `type` `GENERAL` passes.
- `[unit]` validating `CreateCommentDto` with no `type` passes.
- `[unit]` validating `CreateCommentDto` with `type` `FIX_REPORT` fails on `type`.
- `[unit]` validating `CreateCommentDto` with `type` `STATUS_CHANGE` fails on `type`.
- `[integration]` `POST /api/projects/:slug/tickets/:ref/comments` with `type: 'REVIEW'` answers 400 and stores no comment.
- `[unit]` `CommentsService.update` on a comment of type `FIX_REPORT` throws `ConflictAppException` with key `comments.workflowImmutable` and never calls `commentRepo.update`.
- `[unit]` `CommentsService.update` on a comment of type `VERIFICATION` throws the same `ConflictAppException`.
- `[unit]` `CommentsService.update` on a `GENERAL` comment its caller may edit calls `commentRepo.update` with the new body.
- `[integration]` `PATCH /api/comments/:id` of a `FIX_REPORT` comment answers 409 with the message `Workflow comments cannot be edited` and leaves its body unchanged.
- `[integration]` the OpenAPI document served by the API lists only `GENERAL` in the comment-create `type` enum.

### US-010: Deleting a comment is a soft delete

- `[unit]` `CommentsService.delete` calls `commentRepo.softDelete` with the comment id and records the `comment.delete` audit entry.
- `[integration]` after `DELETE /api/comments/:id`, the comment row still exists with `deletedAt` set.
- `[integration]` after that delete, `GET` of the ticket's comments does not list the comment.
- `[integration]` after that delete, `countByTicketId` for the ticket is one lower.
- `[integration]` `PATCH /api/comments/:id` of a soft-deleted comment answers 404.
- `[integration]` `DELETE /api/comments/:id` of a soft-deleted comment answers 404.
- `[integration]` `PrismaTicketsRepository.findTicketWithComments` leaves out a soft-deleted comment.

### US-011: The web comment form posts only GENERAL and edits only GENERAL comments

- `[unit]` `CommentThread` mounted for a ticket renders no comment-type select in the add-comment form.
- `[unit]` submitting the add-comment form posts `{ body, type: 'GENERAL' }` to the comments endpoint.
- `[unit]` a listed comment of type `GENERAL` shows the edit button.
- `[unit]` a listed comment of type `FIX_REPORT` shows no edit button and still shows its type pill.

### US-012: The CLI comment command posts only GENERAL comments

- `[cli]` `koda comment add KODA-42 --body "text"` calls `commentsControllerCreateFromHttp` with body `{ body: 'text', type: 'GENERAL' }`.
- `[cli]` `koda comment add KODA-42 --body "text" --type FIX_REPORT` exits with code 1 (commander's unknown-option error) and makes no API call.
- `[cli]` `koda comment add --help` does not list a `--type` option.
