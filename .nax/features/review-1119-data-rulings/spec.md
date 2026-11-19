# SPEC: Review 2026-11-14 data rulings (retention purges, review author exclusion, deleted-project budget pause, deferred issue import)

## Summary

This feature implements four owner rulings of 2026-11-19 on open items of the 2026-11-14 whole-repo review
(`docs/20261114-review-whole-repo.md`, "Rulings needed"). Each was re-checked against main `670c3070e` on 2026-11-19.

1. **Ruling 10 (retention).** Nightly purges delete inbound webhook deliveries after 30 days, settled approval requests
   after 180 days and audit entries after 365 days, each configurable.
2. **Ruling 18 (K2, self-approval).** The approver of a "not a defect" review decision is never the PR's author.
3. **Ruling 19 (budget pause on a soft-deleted project).** A pause on a soft-deleted project's policy no longer applies.
   The row is kept, so restoring the project within the same budget window restores the pause.
4. **Ruling 20 (C/BUG-2, deferred `vcs.sync.all`).** An approved full issue import runs after the approval commits,
   with per-issue isolation, and the executed result says how many issues were fetched and whether the fetch was capped.

The fleet rulings of the same review are in the sibling feature `review-1119-fleet-rulings`. Ruling 17 was a hand
comment fix (`600b1fae5`).

## Motivation

- `AuditEntry`, `ApprovalRequest` (with its cascaded `ApprovalDecision`, `FleetApprovalAsk` and
  `AssistantActionRequest` rows) and inbound `WebhookDelivery` rows are never deleted.
- `apps/api/src/fleet/reviews/review-event.minter.ts` picks `verified ?? writers[0]` as the approver, and nothing
  excludes the PR's author.
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` `findPaused` returns paused policies of soft-deleted
  projects, so `BudgetGate` keeps enforcing a pause on a project that no longer runs work.
- `apps/api/src/vcs/vcs-manual-sync.service.ts` `VcsManualSync.prepareSyncAll` imports up to 1,000 issues inside the
  approval's transaction with `isolate: false`, so one failed issue write rolls back the whole import, and the
  provider's `capped` flag is dropped.

## Design

### Calls made in this spec

- **Retention defaults.** `WEBHOOK_DELIVERY_RETENTION_DAYS` 30, `APPROVAL_RETENTION_DAYS` 180,
  `AUDIT_RETENTION_DAYS` 365. They follow the `OUTBOX_RETENTION_DAYS` rule in `config/outbox.config.ts`: the default
  applies when `NODE_ENV` is not `test`; under test the purge is off; an explicit `0` turns it off. Each value is an
  integer 0..3650, validated in `config/env.validation.ts`.
- **Retention config.** `config/retention.config.ts` registers `RETENTION_CFG` returning
  `{ webhookDeliveryDays, approvalDays, auditDays }`, each `number | null`. It joins the `load:` array in
  `app.module.ts` and the test stub config in `common/test-helpers/global-stubs.module.ts`.
- **Purge shape.** Each purge copies `OutboxRetentionProcessor`: a `@SystemWriter('<key>')` class, an `@Cron` method
  `scheduledPurge` that runs the purge through `runAsSystemWriter`, a cutoff of now minus the configured days, one
  repository delete wrapped in `AuditRecorder.audited` (recording an entry only when the count is above 0), and
  log-and-swallow on failure. The next night is the retry. Each purge is a single statement, not batched.
- **Purges:**
  - `WebhookDeliveryRetentionProcessor`, key `system.webhook-delivery.retention`, cron `0 5 * * *`. It calls a new
    module-private `PrismaWebhookDeliveryRepository.deleteReceivedBefore(before): Promise<number>`, registered in
    `WebhookSecurityModule`.
  - `ApprovalRetentionProcessor`, key `system.approval.retention`, cron `15 5 * * *`. It calls
    `PrismaApprovalRequestRepository.deleteSettledBefore(before): Promise<number>` and is registered in
    `ApprovalEngineModule`.
  - `AuditRetentionProcessor`, key `system.audit.retention`, cron `30 5 * * *`. It calls
    `PrismaAuditEntryRepository.deleteCreatedBefore(before): Promise<number>` and is registered in `AuditLogModule`.
  - The three keys are added to `permissions/catalog.ts` beside `system.outbox.retention`, with scope `['system']`.
- **Approval purge scope.**
  - It deletes requests whose `status` is settled (`rejected`, `expired`, `cancelled`, `executed` or `failed`) and
    whose `updatedAt` is before the cutoff.
  - `pending` and `approved` rows are never purged.
  - The rows that reference a request (`ApprovalDecision`, `FleetApprovalAsk`, `AssistantActionRequest`) go with it
    through their existing `onDelete: Cascade`.
  - A migration adds `@@index([status, updatedAt])` to `ApprovalRequest`.
- **Webhook replay.** The `WebhookDelivery` row is the replay guard's dedup record. Purging it after 30 days means a
  delivery id older than the horizon is no longer refused. The owner accepted this with ruling 10. The guard's doc
  comment says a repeat is refused "forever"; US-002 changes it to "for the retention horizon".
- **Author exclusion.**
  - `VcsPrStatus` gains `author?: string`. `GitHubAppClient.getPullRequest` sets it from `user.login`, and
    `GitLabAccessChecker.getMergeRequest` from `author.username`, only when that value is a string. The key is
    absent otherwise.
  - The minter reads the PR once per row, after the writers are known: GitHub with the thread-read token it already
    minted; GitLab through `gitlab.credentials.call(..., 'read', ...)`, as its other reads do.
  - Writers whose login equals the author (case-insensitive, through `normalizeLogin`) are dropped before the
    verified/unverified choice. A row whose only writers are the author is skipped with `author-only`.
  - A PR read that throws skips the row with `permission-check-failed`. A PR read that answers `null` (404) filters
    nothing.
- **Budget pause.** `findPaused` drops policies whose `projectId` names a soft-deleted project. `BudgetPolicy.projectId`
  is a plain column with no relation, so the filter needs a second query for the deleted ids (or one raw query). Policies with a null
  `projectId` (global, runner) are always kept. No row is changed. The sweeper still clears pauses of past windows, so
  a restore brings back a pause only within its window.
- **Deferred import.**
  - The ruling said "show `capped` in the approval preview". But the full import fetches its issues only when the
    approved request executes (`prepare` runs after the decision), so no preview can know whether the fetch was capped.
    The executed result reports it instead.
  - The prepared closure keeps its target check, then queues the import with
    `AfterCommitService.defer(() => this.sync.syncIssues(project, filtered, connection, 'vcs.sync.all', { isolate: true }))`.
  - It returns `{ syncType: 'manual', issuesSynced: 0, issuesSkipped: 0, tickets: [], fetchedIssues, capped }`, where
    `fetchedIssues` counts the issues after the `allowedAuthors` filter, the ones the import will process.
  - The `defer`-false fallback is safe only outside a transaction. `prepareSyncAll` is reached only from the approval
    path, which always runs in an `afterCommit.scope`.
  - Approval execution runs inside `afterCommit.scope`, so the import runs only after the approval commits.
  - A failure in the deferred pass is caught and logged at error.
  - `defer` answering `false` (no enclosing scope) runs the import directly, the pattern `vcs-connection.service.ts`
    uses.
  - `VcsManualSync` gains an `AfterCommitService` constructor argument.
  - `SyncResultDto` gains optional `fetchedIssues` and `capped`.

### Integration

Symbols this feature only reads (verified at `670c3070e`):

- `apps/api/src/outbox/outbox-retention.processor.ts` and `apps/api/src/config/outbox.config.ts`: the patterns above.
- `apps/api/src/permissions/after-commit.service.ts` `AfterCommitService.scope(fn)` and `defer(task): boolean`.
- `apps/api/src/approvals/approval-execution.service.ts`: it wraps the approved command's transaction in
  `this.afterCommit.scope(...)`.
- `apps/api/src/vcs/vcs-sync.service.ts` `syncIssues(project, issues, repo, auditKey, { isolate })`.
- `apps/api/src/fleet/reviews/review-event.minter.ts` `normalizeLogin`, `skip(id, reason)`.

Symbols this feature changes. The baseline only locates the code; implement the target.

- `VcsPrStatus` (`apps/api/src/vcs/types.ts`): gains `author?: string`.
- `GitHubAppClient.getPullRequest`, `GitLabAccessChecker.getMergeRequest`: set `author` as above.
- `ReviewEventMinter.mintGitHub` and `mintGitLab`: author exclusion as above. The minter's GitHub dependency gains
  `getPullRequest`.
- `PrismaBudgetRepository.findPaused`: the soft-deleted-project filter.
- `VcsManualSync`
  - Baseline: `prepareSyncAll(slug)` returns a closure that awaits `syncIssues(..., { isolate: false })`.
  - Target: the closure defers the import as above and returns `fetchedIssues` and `capped`.
- `SyncResultDto` (`apps/api/src/vcs/dto/sync-result.dto.ts`): gains optional `fetchedIssues?: number` and `capped?: boolean`.
- `PrismaApprovalRequestRepository` gains `deleteSettledBefore`; `PrismaAuditEntryRepository` gains `deleteCreatedBefore`.

### Failure Handling

| Case | Behaviour |
|---|---|
| A purge's repository delete throws | logged at error, swallowed; nothing recorded |
| A purge's audit record throws | the delete rolls back with it (`audited`), logged at error, swallowed |
| Retention days `null` | the purge does nothing |
| PR author read throws | row skipped with `permission-check-failed` |
| PR read answers `null` (404) | writers are not filtered |
| The deferred import throws | logged at error; the approval stays `executed` with its recorded result |

## Out of Scope

- Ruling 2: documenting "the default branch must be protected" as a FIX deployment prerequisite is a docs change made by hand.
- Ruling 21: webhook signature v2 is a separate feature.
- Ruling 23: the production TLS terminator belongs to the production deployment work.
- Replay protection for inbound webhooks older than the `WebhookDelivery` retention horizon: accepted by ruling 10.
- Batching the purge deletes: each night's purge is one statement.
- Purging `FleetFlow.approvalRequestId` references: the column has no foreign key, and a flow pointing at a purged request keeps its id.
- Retention for any table other than `WebhookDelivery`, `ApprovalRequest` (with its cascades) and `AuditEntry`.
- Recording the deferred import's per-issue outcome back onto the approval request.
- Excluding the PR author from approvers anywhere other than `ReviewEventMinter`.
- Excluding an author the forge does not report: a PR read whose body carries no string author login (a deleted "ghost" user) leaves `author` absent and filters no writer.

## Stories

The feature is four independent ruled fixes in `apps/api`. Six stories keep each under the 15-assertion gate.

**US-001: Retention config.** Workdir: `apps/api`. No dependencies.

**US-002: Purge webhook deliveries and audit entries.** Workdir: `apps/api`. Depends on US-001.

**US-003: Purge settled approval requests.** Workdir: `apps/api`. Depends on US-001, US-002.
It follows US-002 because both edit the same closed-world permission specs.

**US-004: Exclude the PR author from review decision approvers.** Workdir: `apps/api`. No dependencies.

**US-005: Ignore budget pauses of soft-deleted projects.** Workdir: `apps/api`. No dependencies.

**US-006: Run the approved full issue import after commit.** Workdir: `apps/api`. No dependencies.

### Context Files

**US-001**
- `apps/api/src/config/outbox.config.ts`
- `apps/api/src/config/env.validation.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/common/test-helpers/global-stubs.module.ts`

**US-002**
- `apps/api/src/outbox/outbox-retention.processor.ts`
- `apps/api/src/webhook-security/webhook-replay.guard.ts`
- `apps/api/src/webhook-security/webhook-security.module.ts`
- `apps/api/src/audit/prisma-audit-entry.repository.ts`
- `apps/api/src/permissions/catalog.ts`

**US-003**
- `apps/api/src/outbox/outbox-retention.processor.ts`
- `apps/api/src/approvals/prisma-approval-request.repository.ts`
- `apps/api/src/approvals/approval-engine.module.ts`
- `apps/api/src/permissions/catalog.ts`
- `apps/api/prisma/schema.prisma`

**US-004**
- `apps/api/src/fleet/reviews/review-event.minter.ts`
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts`
- `apps/api/src/vcs/types.ts`

**US-005**
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts`
- `apps/api/src/fleet/budgets/budget-gate.ts`

**US-006**
- `apps/api/src/vcs/vcs-manual-sync.service.ts`
- `apps/api/src/permissions/after-commit.service.ts`
- `apps/api/src/vcs/vcs-connection.service.ts`
- `apps/api/src/vcs/dto/sync-result.dto.ts`

### Creates

**US-001**
- `apps/api/src/config/retention.config.ts`

**US-002**
- `apps/api/src/webhook-security/prisma-webhook-delivery.repository.ts`
- `apps/api/src/webhook-security/webhook-delivery-retention.processor.ts`
- `apps/api/src/audit/audit-retention.processor.ts`

**US-003**
- `apps/api/src/approvals/approval-retention.processor.ts`
- `apps/api/prisma/migrations/20261119120000_approval_request_status_updated_index/migration.sql`

### Modifies

**US-002**
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — its table pins every `@SystemWriter` processor with its key and `toHaveLength(44)`; add `WebhookDeliveryRetentionProcessor` (`system.webhook-delivery.retention`) and `AuditRetentionProcessor` (`system.audit.retention`) and set the length to 46.
- `apps/api/src/permissions/catalog.spec.ts` — its hand-maintained `NEW_KEY_SCOPES` map feeds an exact key-set equality and a total-length check; add `system.webhook-delivery.retention` and `system.audit.retention` to `NEW_KEY_SCOPES` with the scope class `'any'`, as the `system.flow.*` keys there.
- `apps/api/src/audit/audit-log.module.spec.ts` — it compiles `AuditLogModule` against a local `GlobalMocksModule` that provides no `ConfigService`; that stub module gains a `ConfigModule.forRoot({ load: [retentionConfig] })` import, the same repair the outbox module spec uses, so the module still compiles with `AuditRetentionProcessor` registered.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — the snapshot lists every system key per role; it is regenerated to include `system.webhook-delivery.retention` and `system.audit.retention`.

**US-003**
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — add `ApprovalRetentionProcessor` (`system.approval.retention`) to its processor table and set its length to 47.
- `apps/api/src/permissions/catalog.spec.ts` — add `system.approval.retention` to `NEW_KEY_SCOPES` with the scope class `'any'`.
- `apps/api/src/approvals/approval-engine.module.spec.ts` — it compiles `ApprovalEngineModule` against a local `ExternalStubsModule` that exports no `ConfigService`; that stub module gains a `ConfigModule.forRoot({ load: [retentionConfig] })` import, so the module still compiles with `ApprovalRetentionProcessor` registered.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated to include `system.approval.retention`.

**US-004**
- `apps/api/src/fleet/reviews/review-event.minter.spec.ts` — its GitHub stub has no `getPullRequest` and its GitLab checker stub no `getMergeRequest`; both gain a default answering `null`, so the existing cases keep their writers unfiltered. Its GitLab "one call per read" case asserts 3 `credentials.call` invocations and 3 distinct accesses; the merge-request read is a fourth `call`, so those counts become 4.

**US-006**
- `apps/api/src/vcs/vcs-manual-sync.service.spec.ts` — the `vcs.sync.all` case asserts the deferred closure calls `syncIssues` with `{ isolate: false }`; it is replaced by the closure deferring the import with `{ isolate: true }` and returning `fetchedIssues` and `capped`, and the construction gains an `AfterCommitService`.
- `openapi.json` — `SyncResultDto` gains the documented optional `fetchedIssues` and `capped` properties; regenerate with `bun run generate` from the repo root.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` for the same two `SyncResultDto` properties; never hand-edited.

### Seams

- `RETENTION_CFG` (US-001) is consumed by US-002 and US-003 through `ConfigService.get`. US-001 AC-9 pins the production wiring: the booted app resolves it.

## Acceptance Criteria

### US-001

- AC-1 [unit] `retentionConfig()` with none of the three variables set and `NODE_ENV` `production` resolves `webhookDeliveryDays` 30.
- AC-2 [unit] In the AC-1 setup, it resolves `approvalDays` 180.
- AC-3 [unit] In the AC-1 setup, it resolves `auditDays` 365.
- AC-4 [unit] `retentionConfig()` with `NODE_ENV` `test` and none of the variables set resolves `auditDays` `null`.
- AC-5 [unit] `retentionConfig()` with `AUDIT_RETENTION_DAYS=0` and `NODE_ENV` `production` resolves `auditDays` `null`.
- AC-6 [unit] `retentionConfig()` with `APPROVAL_RETENTION_DAYS=7` resolves `approvalDays` 7.
- AC-7 [unit] The environment validation schema rejects `APPROVAL_RETENTION_DAYS=4000`.
- AC-8 [unit] A testing module importing `GlobalStubsModule` answers `ConfigService.get(RETENTION_CFG)` with an object whose `auditDays` is `null` (under `NODE_ENV` `test`).
- AC-9 [integration] The application booted by the `bootHttpApp` test helper answers `ConfigService.get(RETENTION_CFG)` with a defined object.

### US-002

- AC-1 [integration] `PrismaWebhookDeliveryRepository.deleteReceivedBefore(cutoff)` deletes a `WebhookDelivery` row received before `cutoff`.
- AC-2 [integration] In the AC-1 case, a row received after `cutoff` is kept.
- AC-3 [integration] `PrismaAuditEntryRepository.deleteCreatedBefore(cutoff)` deletes an `AuditEntry` created before `cutoff` and returns 1.
- AC-4 [integration] In the AC-3 case, an `AuditEntry` created after `cutoff` is kept.
- AC-5 [unit] `WebhookDeliveryRetentionProcessor.scheduledPurge` with `webhookDeliveryDays` 30 calls `deleteReceivedBefore` with a cutoff 30 days before now.
- AC-6 [unit] `WebhookDeliveryRetentionProcessor.scheduledPurge` whose delete answers 2 records one audit entry with key `system.webhook-delivery.retention`.
- AC-7 [unit] `AuditRetentionProcessor.scheduledPurge` with `auditDays` `null` calls no repository delete.
- AC-8 [unit] `AuditRetentionProcessor.scheduledPurge` whose repository delete throws resolves without throwing and logs an error.
- AC-9 [unit] `AuditRetentionProcessor.scheduledPurge` whose audit record throws resolves without throwing and logs an error.
- AC-10 [unit] `WebhookSecurityModule` compiled with stubbed persistence resolves `WebhookDeliveryRetentionProcessor`.
- AC-11 [unit] `AuditLogModule` compiled with stubbed persistence resolves `AuditRetentionProcessor`.

### US-003

- AC-1 [integration] `PrismaApprovalRequestRepository.deleteSettledBefore(cutoff)` deletes an `executed` request last updated before `cutoff`.
- AC-2 [integration] In the AC-1 case, the deleted request's `ApprovalDecision` rows are gone.
- AC-3 [integration] `deleteSettledBefore(cutoff)` deletes a `rejected` request last updated before `cutoff`.
- AC-4 [integration] `deleteSettledBefore(cutoff)` keeps a `pending` request last updated before `cutoff`.
- AC-5 [integration] `deleteSettledBefore(cutoff)` keeps an `approved` request last updated before `cutoff`.
- AC-6 [integration] `deleteSettledBefore(cutoff)` keeps an `executed` request last updated after `cutoff`.
- AC-7 [unit] `ApprovalRetentionProcessor.scheduledPurge` with `approvalDays` 180 calls `deleteSettledBefore` with a cutoff 180 days before now.
- AC-8 [unit] `ApprovalRetentionProcessor.scheduledPurge` whose delete answers 3 records one audit entry with key `system.approval.retention`.
- AC-9 [unit] `ApprovalRetentionProcessor.scheduledPurge` whose delete throws resolves without throwing and logs an error.
- AC-10 [unit] `ApprovalEngineModule` compiled with stubbed persistence resolves `ApprovalRetentionProcessor`.

### US-004

- AC-1 [unit] `GitHubAppClient.getPullRequest` for a pull request whose `user.login` is `alice` returns `author: 'alice'`.
- AC-2 [unit] `GitLabAccessChecker.getMergeRequest` for a merge request whose `author.username` is `bob` returns `author: 'bob'`.
- AC-3 [unit] A GitHub review event whose writers are `alice` and `carol`, on a PR authored by `alice`, is minted with approver `carol`.
- AC-4 [unit] A GitHub review event whose only writer is `Alice`, on a PR authored by `alice`, is skipped with reason `author-only`.
- AC-5 [unit] In the AC-4 case, `ReviewDecisionWriter.mint` is never called.
- AC-6 [unit] A GitHub review event whose thread author `alice` is the PR author, with a second writer `carol`, is minted with approver `carol` as unverified.
- AC-7 [unit] A GitLab review event whose writers are `bob` and `dave`, on a merge request authored by `bob`, is minted with approver `dave`.
- AC-8 [unit] A GitLab review event whose only writer is the merge request's author is skipped with reason `author-only`.
- AC-9 [unit] A GitHub review event whose PR read throws a provider error is skipped with reason `permission-check-failed`.
- AC-10 [unit] A GitLab review event whose merge request read throws a provider error is skipped with reason `permission-check-failed`.
- AC-11 [unit] A GitLab review event whose merge request read answers `null` is minted with approver `writers[0]`.
- AC-12 [unit] A GitHub review event whose PR read answers `null` (404) is minted with approver `writers[0]`.

### US-005

- AC-1 [integration] `PrismaBudgetRepository.findPaused` does not return a paused project-scope policy whose project is soft-deleted.
- AC-2 [integration] `findPaused` does not return a paused repo-scope policy whose `projectId` names a soft-deleted project.
- AC-3 [integration] `findPaused` returns a paused runner-scope policy whose `projectId` is null.
- AC-4 [integration] `findPaused` returns a paused policy of a project that is not deleted.
- AC-5 [integration] After a soft-deleted project's `deletedAt` is cleared, `findPaused` returns its paused policy again.

### US-006

- AC-1 [unit] The closure `VcsManualSync.prepareSyncAll` returns, for a fetch of 3 issues answering `capped: true`, resolves with `fetchedIssues: 3`.
- AC-2 [unit] In the AC-1 case, the closure resolves with `capped: true` and `issuesSynced: 0`.
- AC-3 [unit] In the AC-1 case, run inside an `AfterCommitService.scope`, `syncIssues` is not called before the closure resolves.
- AC-4 [unit] In the AC-3 case, once the scope ends, `syncIssues` has been called once with the author-filtered issues, audit key `vcs.sync.all` and `{ isolate: true }`.
- AC-5 [unit] In the AC-3 case, a `syncIssues` that rejects does not make the scope reject, and an error is logged.
- AC-6 [unit] The closure run with no enclosing `AfterCommitService.scope` calls `syncIssues` once with `{ isolate: true }` before it resolves.
- AC-7 [unit] `VcsManualSync.syncAll` (no approval) still returns the `fullSync` counts in `issuesSynced` and `issuesSkipped` (regression guard).
