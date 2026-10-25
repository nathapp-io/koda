# SPEC: Permissions P2i — Audit Entries for the VCS and CI Integrations

## Summary

This feature makes the VCS and CI integrations in `apps/api` record an `AuditEntry` in the same transaction as each write. It uses the recorder and the rules from `permissions-p2-audit-core`: `AuditRecorder.record` inside an existing `txManager.run`, and `AuditRecorder.audited` when there is none. The writes:
- **VCS connections.** Create, update, delete and webhook-secret rotation (`VcsConnectionService`).
- **Issue imports.** A ticket created from a VCS issue by the manual sync routes, the poller or the webhook intake (`VcsSyncService.syncIssue`).
- **PR state.** A `TicketLink.prState` change made by the manual PR sync, the poller or the webhook intake.
- **The merge step.** `VcsPrSyncService.applyMergedPr`: the link moved to `merged` and the ticket's `IN_PROGRESS -> VERIFY_FIX` auto-transition, whether the webhook, the poller, the manual PR sync or the fleet PR refresher saw the merge.
- **Derived links and fleet ticket effects.** Branch and commit links that `VcsLinkExtractorService` creates, and the failure comment and PR link that `FleetJobTicketEffects` writes after a fleet job ends.
- **CI intake.** The ticket `CiWebhookService` creates for a failed pipeline. The two public intakes' replay-guard rows get the component's actor (`SYSTEM/ci`, `SYSTEM/vcs`) instead of `SYSTEM/anonymous`.

This is the ninth of twelve features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, audit-fleet-routes, audit-fleet-ops, audit-fleet-system, web, **audit-vcs-ci**, audit-knowledge, audit-delivery, audit-coverage.

## Motivation

`permissions-p2-audit-fleet-system` (PR #332, deployed `35769e6d` on 2026-10-25) closed the fleet's writers, and `permissions-p2-web` (PR #333, `bb246724`) shipped the Audit log page. Every human route and every fleet writer now leaves an entry, but a ticket imported from a GitHub issue, a PR merge that moves a ticket to `VERIFY_FIX`, a VCS connection whose token was replaced and a ticket a CI pipeline opened leave none. Those are writes an outside system caused, and the Audit log is the only place that would show which integration made them and when.

The integrations were one P2 feature, `permissions-p2-audit-integrations`. Sized before drafting (redesign doc, "Size the feature first"), it is about 55 inventory write rows plus the coverage guard, far past one spec's 7 stories. It is split by domain, because the writers of one domain share services and repositories (the manual sync route, the poller and the webhook all reach `VcsSyncService.syncIssue`):
- **audit-vcs-ci** (this feature): VCS, CI, and the fleet ticket effects that write the same ticket links and comments.
- **audit-knowledge**: KB documents and RAG, memory, entity graph, code intel, knowledge poll.
- **audit-delivery**: outbound webhooks and delivery, skills, notifications and ticket watch, outbox, email, fleet health, assistant action finalize, the role seeder, and the assistant tools that reach no audited service.
- **audit-coverage**: the runtime coverage guard and the walker test over the inventory's write rows. It runs last, because it can only pass once every writer records.

**Rulings that bind this feature** (user, 2026-10-24):
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The coverage guard and the walker test belong to the last P2 feature** (now `permissions-p2-audit-coverage`). This feature does not add them.

The user skipped the design questions for this feature ("skip questions and proceed", 2026-10-25), and the split above is the designer's call. Every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **An entry names the entry point, not the shared helper.** `syncIssue` and the PR-state writes are shared by a route, the poller and the webhook intake. The caller passes the key: `vcs.sync.issue` (one-issue route), `vcs.sync.all` (full-sync route), `vcs.sync.pr` (PR-sync route), `system.vcs.poll-issues` (the poller, issues and PR states alike) or `system.vcs.webhook-intake` (the webhook). The inventory rows are per entry point, so the walker in audit-coverage can match them.
- **The merge step always records `system.vcs.pr-merge-transition`, as `SYSTEM/vcs`.** `VcsPrSyncService` is the `@SystemWriter('system.vcs.pr-merge-transition')` class and `applyMergedPr` is "the one merge step" for every path (`vcs-pr-sync.service.ts:143`). It runs its writes inside `runAsSystemWriter(this, …)`, so a merge seen by the manual PR sync or by the fleet PR refresher (`SYSTEM/ticket-link`) is still recorded as `SYSTEM/vcs`. `runAsSystem` inherits the enclosing `correlationId`, so the entry still joins the request or tick that saw the merge. This follows audit-fleet-system's call "an entry under a `system.*` key always carries that component's actor".
- **A merge records two entries.** One on the link (`pr <before> -> merged`), committed by the link write, and one on the ticket (`status: IN_PROGRESS -> VERIFY_FIX`), committed with the auto-transition. The FIX_REPORT comment and the `VCS_PR_MERGED` activity row are in the transition's transaction and covered by its entry, as audit-core's transition entries cover their comment.
- **A webhook PR-state write records only when the stored state changes.** `updateTicketLinkWithPrState` returns `'updated'` for a same-state write too (it bumps `prUpdatedAt`). The webhook records when the outcome is `'updated'` and the link's state before the write differs from the new one. The poller and the PR-sync route already write only when the state differs (`vcs-pr-sync.service.ts:93`).
- **Derived writes record under their domain key, as the current actor.** A branch or commit link created by `VcsLinkExtractorService`, and the failure comment and PR link `FleetJobTicketEffects` writes, have no system key of their own: the extractor runs inside whichever entry point synced the PR, and the effects run after a job ends, as the runner (`RUNNER/<id>`), the sweeper (`SYSTEM/job`) or the ingest drain (`SYSTEM/ingest`). They record `ticket.link.add` and `comment.create`, the keys audit-core records for the same rows through the REST routes, and the entry's actor is whatever context is current.
- **The extractor's entries can land after `syncPrStatus` resolves.** `syncPrStatus` starts `extractLinksFromPr` without awaiting it (`vcs-pr-sync.service.ts:111`) when the PR status has a `branchName` and the link has a ticket, so in the PR-sync route and the poller its `ticket.link.add` entries are written asynchronously, still under the caller's context. That is unchanged; tests of `syncPrStatus` stub a status without `branchName`.
- **Only a created link records.** `upsertTicketLink` and `upsertFleetPrLink` each have an update branch for a link that already exists (the extractor refreshes `linkType` and `externalRef`; the fleet effect sets `jobId`). Those are bookkeeping. Both methods now return the created link's id, or `null` when the link existed, so the caller can record the new row.
- **Ticket creation records inside the ticket-number retry.** `createTicketFromIssue` and `PrismaCiWebhookRepository.createTicket` run in `runWithTicketNumberRetry`, which starts a fresh transaction per attempt and refuses to retry inside an outer one (`ticket-number-retry.ts:38`). Wrapping them in `audited` would turn every number conflict into a 409. Both gain an optional last parameter `onCreated: (ticket) => Promise<void>`, run inside the attempt's transaction after the insert, and the services pass a callback that calls `record`. This is the `MembershipService.createBinding(…, onWritten)` pattern from audit-core.
- **The replay guard's rows are bookkeeping, written as the component.** `WebhookReplayGuard.assertFresh` and `forget` write `WebhookDelivery` rows before the intake service runs, so today they run as `SYSTEM/anonymous` (`permissions-p2-context` left the `ci` id to this feature). `CiWebhookController` wraps both calls in `runAsSystem('ci', …)` and `VcsWebhookController` in `runAsSystem('vcs', …)`. They record no entry.
- **A connection summary never carries a token, a secret or an author list.** Create records the provider, the repo and the sync mode. Update records the changed field names through `fieldsSummary`, never values: it is called on `updateData` with `encryptedToken` renamed `token`, so the names are `token`, `syncMode`, `allowedAuthors`, `pollingIntervalMs` and `webhookSecret` (present only when the update generated a secret). Rotation records a fixed text. An issue import names the issue number only, never its title or body. A PR-state entry names the states only, never the PR URL, title or merge author.
- **`AuditRecorder` is a required constructor dependency, placed before the optional ones.** `VcsConnectionService`, `CiWebhookService` and `FleetJobTicketEffects` take it last. `VcsSyncService`, `VcsPrSyncService` and `VcsLinkExtractorService` take it right after their repository, before their `@Optional()` parameters. `VcsWebhookService` takes it right after `vcsConfig`, before its two `@Optional()` parameters.
- **`projectId` is the row's project.** A connection's, an imported ticket's, a fleet job's, the CI project's. A PR-state entry uses the synced `project.id` (`syncPrStatus`) or `connection.projectId` (the webhook). The merge step has only the link, so it uses `link.ticket?.projectId ?? null` (`TicketLinkData.ticket` is optional; every production caller loads it).
- **The 404 close catches its own failure.** In `syncPrStatus` the 404 close runs inside the per-link `catch` (`vcs-pr-sync.service.ts:131`), so a rejection there would escape the loop and abort the rest of the sync, and through the poller the whole poll. It gets its own `try`/`catch` that logs and counts the link skipped, like the main write.
- **The issues webhook keeps swallowing its errors.** `handleIssueOpened` catches every error and answers 200 `success: false` (`vcs-webhook.service.ts:250`), so the controller does not forget the delivery id and GitHub's redelivery is refused as a replay. A rejected `record` therefore loses that import, as any database error does today. Changing the intake's error contract is out of scope; AC13 of US-002 pins the behaviour so the coverage or delivery feature can revisit it.

### Keys and summaries (`src/vcs/vcs-audit.ts`, US-002)

```typescript
/** The key an issue import records: the entry point that ran syncIssue. */
export type VcsIssueAuditKey = 'vcs.sync.issue' | 'vcs.sync.all' | 'system.vcs.poll-issues' | 'system.vcs.webhook-intake';

/** The key a PR-state write records: the entry point that saw the state. */
export type VcsPrStateAuditKey = 'vcs.sync.pr' | 'system.vcs.poll-issues' | 'system.vcs.webhook-intake';

/** `pr <before> -> <after>`; `before` is `none` for a link with no stored state. */
export function prStateSummary(before: string | null, after: string): string;
```

### The summary and resource contract

| Write | Key | `resourceType` | `resourceId` | `projectId` | `summary` |
|:--|:--|:--|:--|:--|:--|
| VCS connection created | `vcs.connection.create` | `vcs-connection` | connection id | the project | `<provider> <owner>/<name>, sync <mode>` (e.g. `github acme/app, sync webhook`) |
| VCS connection updated | `vcs.connection.update` | `vcs-connection` | connection id | the project | `fieldsSummary` of `updateData` with `encryptedToken` renamed `token` (e.g. `fields: syncMode, token`) |
| VCS connection deleted | `vcs.connection.delete` | `vcs-connection` | connection id | the project | `deleted <provider> <owner>/<name>` |
| webhook secret rotated | `vcs.webhook-secret.rotate` | `vcs-connection` | connection id | the project | `webhook secret rotated` |
| issue imported | the caller's `VcsIssueAuditKey` | `ticket` | the new ticket's id | the project | `imported issue #<n>` |
| PR state changed (not merged) | the caller's `VcsPrStateAuditKey` | `ticket-link` | link id | the project | `prStateSummary(<before>, <after>)` (e.g. `pr open -> closed`) |
| PR merged: the link | `system.vcs.pr-merge-transition` | `ticket-link` | link id | `link.ticket?.projectId ?? null` | `prStateSummary(<before>, 'merged')` |
| PR merged: the auto-transition | `system.vcs.pr-merge-transition` | `ticket` | ticket id | `link.ticket?.projectId ?? null` | `status: IN_PROGRESS -> VERIFY_FIX` |
| branch or commit link created by the extractor | `ticket.link.add` | `ticket-link` | the new link's id | the project | `on <KEY>-<number>` |
| fleet failure comment | `comment.create` | `comment` | comment id | the job's project | `on <ticket ref>` |
| fleet PR link created | `ticket.link.add` | `ticket-link` | the new link's id | the job's project | `on <ticket ref>` |
| CI ticket created | `system.ci.ticket-create` | `ticket` | ticket id | the project | `created <KEY>-<number>` |

`<n>` is the VCS issue number. `<before>` and `<after>` are stored `prState` values. `<KEY>-<number>` and `<ticket ref>` are the ticket's ref, as audit-core's comment and link entries write it. The table never prints a token, a webhook secret, an allowed-author list, an issue title or body, a PR URL or title, a merge author or SHA, a commit message, or a pipeline id, test name or file.

**Actors.** The connection routes and the three manual sync routes record as the request's actor, origin `rest`. The poller and the webhook intake record as `SYSTEM/vcs` (`runAsSystemWriter` in `VcsPollingService.tick` and `VcsWebhookService.handleWebhook`, unchanged), origin `system`. The merge step's two entries are always `SYSTEM/vcs`. The CI ticket is `SYSTEM/ci` (`runAsSystemWriter` in `CiWebhookService.processCiWebhook`, unchanged). The extractor's and the fleet effects' entries carry the current context's actor. No entry in this feature sets `onBehalfOf`.

### The writers

| Story | Service.method | Today | Change |
|:--|:--|:--|:--|
| US-001 | `VcsConnectionService.create` | one `createVcsConnection`, no transaction, `vcs-connection.service.ts:79` | the call inside `audit.audited`; `refreshConnectionSchedule` after it, unchanged |
| US-001 | `VcsConnectionService.update` | one `updateVcsConnection`, `:171`, skipped when nothing changed | the call inside `audit.audited`; no write and no entry when nothing changed, unchanged |
| US-001 | `VcsConnectionService.delete` | one `deleteVcsConnection`, `:189` | the call inside `audit.audited` |
| US-001 | `VcsConnectionService.rotateWebhookSecret` | one `updateVcsConnection`, `:206` | the call inside `audit.audited` |
| US-002 | `VcsSyncService.syncIssue` | `createTicketFromIssue`, `vcs-sync.service.ts:50` | gains a required last parameter `auditKey: VcsIssueAuditKey`; passes `onCreated` that records it on the ticket |
| US-002 | `IVcsRepository.createTicketFromIssue`, `PrismaVcsRepository.createTicketFromIssue` | `runWithTicketNumberRetry`, `prisma-vcs.repository.ts:179` | optional last parameter `onCreated`, awaited inside the attempt's transaction after `ticket.create` |
| US-002 | `VcsController.syncIssue`, `VcsSyncService.fullSync`, `VcsPollingService.poll`, `VcsWebhookService.handleIssueOpened` | call `syncIssue` with four arguments | pass `'vcs.sync.issue'`, `'vcs.sync.all'`, `'system.vcs.poll-issues'`, `'system.vcs.webhook-intake'` |
| US-003 | `VcsPrSyncService.syncPrStatus` | `updateTicketLinkWithPrState`, `vcs-pr-sync.service.ts:98`, and the 404 close at `:131`, no transaction | gains a required last parameter `auditKey: VcsPrStateAuditKey`; each non-merge write inside `audit.audited`, recorded when it returned `'updated'`; the 404 close in its own `try`/`catch` that logs and counts the link skipped |
| US-003 | `VcsController.syncPrStatus`, `VcsPollingService.poll` | call `syncPrStatus` with three arguments | pass `'vcs.sync.pr'`, `'system.vcs.poll-issues'` |
| US-003 | `VcsWebhookService.handlePullRequestOpened`, `…Closed`, `…ReadyForReview`, `…Reopened`, `…ConvertedToDraft` | `updateTicketLinkWithPrState`, no transaction, `vcs-webhook.service.ts:333`, `:418`, `:453`, `:485`, `:514` | each write inside `audit.audited`, recording `system.vcs.webhook-intake` when it returned `'updated'` and the state changed |
| US-004 | `VcsPrSyncService.applyMergedPr` | the link write, then `handleMergedPrAutoTransition`, `:150` | both inside `runAsSystemWriter(this, …)`; the link write inside `audit.audited` (recorded when `'updated'`); `applyMergedPrTransition` inside `audit.audited`, recorded on the ticket |
| US-005 | `VcsLinkExtractorService.upsertTicketLink` | `vcsRepo.upsertTicketLink`, no transaction, `vcs-link-extractor.service.ts:99` | the call inside `audit.audited`, recorded when it returned a string |
| US-005 | `PrismaVcsRepository.upsertTicketLink` | returns `void` | returns the created link's id, or `null` when a link for `(ticketId, url)` existed |
| US-005 | `FleetJobTicketEffects.commentOnce` | `txManager.run`, `fleet-job-ticket.effects.ts:109` | `record` after `createSystemComment` |
| US-005 | `FleetJobTicketEffects.linkPr` | `txManager.run`, `:91` | `record` when `upsertFleetPrLink` returned an id |
| US-005 | `PrismaFleetTicketsRepository.upsertFleetPrLink` | `createMany({ skipDuplicates })`, returns `boolean` | `createManyAndReturn({ skipDuplicates })`, returns the created link's id, or `null` after the existing link's `jobId` update |
| US-006 | `CiWebhookService.createTicket` | `repo.createTicket`, `ci-webhook.service.ts:83` | passes `onCreated` that records `system.ci.ticket-create` |
| US-006 | `PrismaCiWebhookRepository.createTicket` | `runWithTicketNumberRetry`, `prisma-ci-webhook.repository.ts:40` | optional last parameter `onCreated`, awaited inside the attempt's transaction after `ticket.create` |
| US-006 | `CiWebhookController.handleCiWebhook`, `VcsWebhookController.handleWebhook` | `replayGuard.assertFresh` and `forget` as `SYSTEM/anonymous` | each call inside `runAsSystem('ci', async () => { await … })` and `runAsSystem('vcs', async () => { await … })` |

### Bookkeeping writes (record nothing)

This list is input for the coverage guard's allowlist in `permissions-p2-audit-coverage`; this feature does not build the guard.

| Write | Where |
|:--|:--|
| a poll's `VcsSyncLog` row and `lastSyncedAt` cursor | `VcsPollingService.poll` |
| webhook replay rows (`WebhookDelivery`) | `WebhookReplayGuard.assertFresh`, `forget` |
| a push's `code_commit` outbox rows | `VcsWebhookService.handlePush` |
| a same-state PR write from the webhook (`prUpdatedAt` only) | `VcsWebhookService` PR handlers |
| the extractor's refresh of an existing link (`linkType`, `externalRef`) | `PrismaVcsRepository.upsertTicketLink` |
| the fleet effect's `jobId` update on an existing link | `PrismaFleetTicketsRepository.upsertFleetPrLink` |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `record` rejects inside a connection write | the write rolls back; the route returns an error status; for create, polling is not scheduled | US-001 |
| an update with no changed field | no write; no entry; 200 with the stored connection | US-001 |
| a create for a project that already has a connection | 409; no entry | US-001 |
| a delete or rotate with no connection | 404; no entry | US-001 |
| `record` rejects inside an issue import | the ticket insert rolls back (the error is not a number conflict, so it is not retried); the one-issue route returns an error status; `fullSync` counts the issue skipped and lists its error; the poller's `poll` stops at that issue and logs it (its single `try`), so later issues wait for the next tick, the cursor is not moved and the tick's PR sync is skipped, as for any database error today; the webhook answers 200 `success: false` and keeps the delivery id, so a redelivery is refused (see the designer's call) | US-002 |
| an issue already imported (any `externalVcsId` match, soft-deleted included) | `skipped`; no write; no entry | US-002 |
| `record` rejects inside a PR-state write | the write rolls back; `syncPrStatus` counts the link skipped (the 404 close included) and goes on to the next link; the webhook handler throws, the controller forgets the delivery id and the route returns an error status, so GitHub's retry is accepted | US-003 |
| a PR whose state did not change, a link already `merged` or `closed`, a link that vanished | no entry | US-003 |
| a webhook for a PR no link matches | `ignored`; no entry | US-003 |
| two paths apply one merge at once | the conditional write lets one through; one link entry and one transition entry | US-004 |
| a merged PR whose ticket is not `IN_PROGRESS` | the link entry only; no transition and no ticket entry | US-004 |
| `record` rejects on the merge's link write | the link stays unmerged and `applyMergedPr` rejects into its caller's existing error path | US-004 |
| `record` rejects on the auto-transition | the transition rolls back and is logged inside (as any transition failure today); the link stays `merged` with its committed entry | US-004 |
| `record` rejects on an extracted link | that link rolls back; the extractor's caller logs and continues, as for any extractor error today | US-005 |
| `record` rejects on a fleet comment or PR link | that ticket's write rolls back and is logged; the next ticket and the next job still run (D451) | US-005 |
| `record` rejects inside the CI ticket insert | no ticket; the controller forgets the delivery id; the route returns an error status | US-006 |
| a CI event other than `pipeline_failed`, or a replayed delivery | no ticket; no entry | US-006 |

### Integration

Verified at main `bb246724`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input)` and `AuditRecorder.audited(fn, entriesOf)` (`entriesOf` may return `[]`), `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. `record` throws for a key outside the catalog and outside a transaction, and reads the actor, `onBehalfOf`, origin and correlation id from `currentContext()`.
- `fieldsSummary(patch)` — `src/audit/audit-summary.ts`; sorted field names of the defined values, `undefined` for none.
- `runAsSystem(component, fn, opts?)`, `runAsSystemWriter(writer, fn)`, `currentContext()` — `src/action-context/action-context.ts`. `ci` and `vcs` are in `SYSTEM_ACTOR_IDS` (second segments of `system.ci.ticket-create` and `system.vcs.*`). The callback awaits its Prisma call inside (Prisma promises are lazy, `permissions-p2-context-guard` § "Prisma promises are lazy").
- `@SystemWriter` declarations, unchanged: `VcsPollingService` (`system.vcs.poll-issues`), `VcsWebhookService` (`system.vcs.webhook-intake`), `VcsPrSyncService` (`system.vcs.pr-merge-transition`), `CiWebhookService` (`system.ci.ticket-create`), `FleetPrStateRefresher` (`system.ticket-link.pr-refresh`).
- `runWithTicketNumberRetry(txManager, work)` — `src/common/utils/ticket-number-retry.ts`; unchanged.
- `mockAuditRecorder` — `src/common/test-helpers/global-stubs.module.ts`; `audited` calls its `fn`, `record` resolves. `GlobalStubsModule` provides it as `AuditRecorder`, so `vcs.module.spec.ts`, `fleet-tickets.module.spec.ts` and `fleet.module.spec.ts` keep compiling. `AuditLogModule` is `@Global()`, so `VcsModule`, `CiWebhookModule` and `FleetTicketsModule` resolve `AuditRecorder` without importing it.
- Every key in the contract table is in `PERMISSION_CATALOG` (`src/permissions/catalog.ts`).
- `FleetPrStateRefresher.apply` calls `applyMergedPr` for a merged PR (`fleet-pr-state.refresher.ts`); unchanged, it gets the merge entries through US-004.
- `withTestActor(actor, fn)`, `fixtureDb(app)`, `expectGuardActive(app)` — `test/helpers/action-context.ts`; `bootHttpApp`, `data`, `loginToken`, `resetThrottle`, `TEST_PASSWORD` — `test/helpers/http-app.ts`; `seedFleetHttpWorld`, `insertRunner` — `test/helpers/fleet-fixtures.ts`.
- Test precedent: `test/integration/vcs/vcs-webhook-secret.integration.spec.ts` (connection routes over HTTP with `VCS_ENCRYPTION_KEY` set before boot), `test/integration/vcs/vcs-permissions.integration.spec.ts` (AC-14: a signed `POST /api/projects/:slug/vcs-webhook`), `test/integration/vcs/vcs-manual-sync.spec.ts` (`createVcsProvider` from `src/vcs/factory` mocked), `test/integration/vcs/vcs-merge-step.integration.spec.ts` (`app.get(VcsPrSyncService).applyMergedPr` on a fixture link), `test/integration/fleet/fleet-tickets-terminal.integration.spec.ts` and `fleet-pr-links.integration.spec.ts` (`FleetJobTicketEffects` on a linked job), `test/integration/fleet/fleet-pr-refresher.integration.spec.ts`, `test/e2e/api-endpoint/endpoint.e2e.spec.ts` ("CI Webhooks": a signed `POST /api/projects/:slug/ci-webhook`), and the unit spec `src/vcs/vcs-polling.tick.spec.ts` (fake timers drive `schedulePolling`).

Changed (baseline → target):
- `VcsSyncService.syncIssue(project, issue, syncMode, repo)` → `syncIssue(project, issue, syncMode, repo, auditKey: VcsIssueAuditKey)`.
- `VcsPrSyncService.syncPrStatus(project, connection, encryptionKey)` → `syncPrStatus(project, connection, encryptionKey, auditKey: VcsPrStateAuditKey)`.
- `IVcsRepository.createTicketFromIssue(project, issue, externalVcsId)` and `PrismaCiWebhookRepository.createTicket(projectId, data)` → each gains an optional last `onCreated: (ticket: { id: string; number: number }) => Promise<void>`.
- `PrismaVcsRepository.upsertTicketLink(…)`: `Promise<void>` → `Promise<string | null>`. `PrismaFleetTicketsRepository.upsertFleetPrLink(input)`: `Promise<boolean>` → `Promise<string | null>`.
- The constructors of `VcsConnectionService`, `VcsSyncService`, `VcsPrSyncService`, `VcsWebhookService`, `VcsLinkExtractorService`, `CiWebhookService` and `FleetJobTicketEffects` — Baseline: no `AuditRecorder`. Target: a required `AuditRecorder`, at the positions given in the designer's calls.

## Out of Scope

- The other integrations (KB and RAG, memory, entity graph, code intel, knowledge poll; outbound webhooks and delivery, skills, notifications and ticket watch, outbox, email, fleet health, the assistant action finalize, the role seeder, the remaining assistant tools) are out of scope (features `permissions-p2-audit-knowledge` and `permissions-p2-audit-delivery`).
- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-coverage`). The Bookkeeping table is its input.
- `POST /projects/:slug/vcs/test` (`vcs.connection.test`) writes no row and records nothing.
- `FleetJobTicketEffects.onRunDispatched` is out of scope: it starts tickets through `TicketTransitionsService.startForDispatch`, which audit-core already records.
- Recording the merge step's FIX_REPORT comment or `VCS_PR_MERGED` activity row as entries of their own is out of scope; the transition's entry covers its transaction.
- Recording the update branches of `upsertTicketLink` and `upsertFleetPrLink`, a same-state webhook PR write, the poller's `VcsSyncLog` rows and cursor, the replay rows and a push's `code_commit` outbox rows is out of scope (the Bookkeeping table).
- An `onBehalfOf` on the merge step's entries when a user's PR sync or the fleet refresher saw the merge is out of scope; the shared `correlationId` joins them.
- Adding catalog keys (one per webhook event or per merge entry) is out of scope; each write records under its existing key and the summary names the event.
- Changing the ticket-number allocation, `runWithTicketNumberRetry`, the replay guard's rules, the dedup of pushes or any route's status codes, response bodies or `@Requires` keys is out of scope; `openapi.json` does not change.
- Recording refused or failed attempts (401, 403, 404, 409, validation errors, ignored webhook events) is out of scope; only committed writes are recorded.
- A before/after diff of values in `AuditEntry` is out of scope.

## Stories

1. **US-001: VCS connection writes are audited** — `Workdir: apps/api` — No dependencies. `VcsConnectionService` create, update, delete and webhook-secret rotation.
2. **US-002: VCS issue imports are audited** — `Workdir: apps/api` — No dependencies. `src/vcs/vcs-audit.ts`; `syncIssue` takes the entry point's key and records the new ticket through `createTicketFromIssue`'s `onCreated`.
3. **US-003: VCS PR-state writes are audited** — `Workdir: apps/api` — Depends on US-002. `syncPrStatus` takes the entry point's key; the webhook's five non-merge PR handlers record `system.vcs.webhook-intake`.
4. **US-004: The PR merge step is audited** — `Workdir: apps/api` — Depends on US-003. `applyMergedPr` runs as `SYSTEM/vcs` and records the link and the auto-transition.
5. **US-005: Extracted links and fleet ticket effects are audited** — `Workdir: apps/api` — Depends on US-002. `VcsLinkExtractorService` and `FleetJobTicketEffects` record created links and failure comments under their domain keys.
6. **US-006: CI ticket creation is audited and the replay rows get the component's actor** — `Workdir: apps/api` — No dependencies. `CiWebhookService`, `PrismaCiWebhookRepository`, and the two intake controllers' replay-guard calls.

Six stories, one capability: every story wires the same recorder into a different VCS or CI writer, and none is useful as a separate PR. US-003 follows US-002 because both change `vcs.controller.ts`, `vcs-polling.service.ts`, `vcs-webhook.service.ts` and their specs, and uses US-002's `vcs-audit.ts`. US-004 follows US-003 because both change `vcs-pr-sync.service.ts`. US-005 follows US-002 because both change `prisma-vcs.repository.ts`.

### Context Files

**US-001**
- `apps/api/src/vcs/vcs-connection.service.ts`
- `apps/api/src/vcs/vcs.controller.ts`
- `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts`

**US-002**
- `apps/api/src/vcs/vcs-sync.service.ts`
- `apps/api/src/vcs/prisma-vcs.repository.ts`
- `apps/api/src/vcs/domain/vcs.repository.ts`
- `apps/api/src/vcs/vcs-polling.service.ts`
- `apps/api/src/vcs/vcs-webhook.service.ts`
- `apps/api/test/integration/vcs/vcs-manual-sync.spec.ts`
- `apps/api/test/integration/vcs/vcs-permissions.integration.spec.ts`

**US-003**
- `apps/api/src/vcs/vcs-pr-sync.service.ts`
- `apps/api/src/vcs/vcs-webhook.service.ts`
- `apps/api/src/vcs/vcs-polling.service.ts`
- `apps/api/src/vcs/vcs-polling.tick.spec.ts`

**US-004**
- `apps/api/src/vcs/vcs-pr-sync.service.ts`
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts`
- `apps/api/test/integration/vcs/vcs-merge-step.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-pr-refresher.integration.spec.ts`

**US-005**
- `apps/api/src/vcs/vcs-link-extractor.service.ts`
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts`
- `apps/api/test/integration/fleet/fleet-tickets-terminal.integration.spec.ts`
- `apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts`

**US-006**
- `apps/api/src/ci-webhook/ci-webhook.service.ts`
- `apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts`
- `apps/api/src/ci-webhook/ci-webhook.controller.ts`
- `apps/api/src/vcs/vcs-webhook.controller.ts`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-vcs-connections.integration.spec.ts`

**US-002**
- `apps/api/src/vcs/vcs-audit.ts`
- `apps/api/src/vcs/vcs-audit.spec.ts`
- `apps/api/test/integration/audit/audit-vcs-issues.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-vcs-pr-state.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-vcs-merge.integration.spec.ts`

**US-005**
- `apps/api/test/integration/audit/audit-vcs-derived-links.integration.spec.ts`

**US-006**
- `apps/api/test/integration/audit/audit-ci-webhook.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/vcs/vcs-connection.service.ts` — injects AuditRecorder as the last constructor parameter and runs create's, update's, delete's and rotateWebhookSecret's repository write inside audit.audited with the contract's entry; validation, the 409 and 404 paths, the no-change return and the polling refresh are unchanged.
- `apps/api/src/vcs/vcs-connection.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (from global-stubs.module.ts) so the real VcsConnectionService resolves; the existing assertions are kept.
- `apps/api/src/vcs/vcs-connection.webhook-secret.spec.ts` — its direct new VcsConnectionService(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/vcs/vcs-connection.gitlab.spec.ts` — its direct new VcsConnectionService(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-connection.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.

**US-002**
- `apps/api/src/vcs/vcs-sync.service.ts` — injects AuditRecorder right after vcsRepo (before the optional vcsConfig); syncIssue gains the required auditKey parameter and passes createTicketFromIssue an onCreated callback that records it on the new ticket; fullSync passes 'vcs.sync.all'; dedup and author filtering are unchanged.
- `apps/api/src/vcs/domain/vcs.repository.ts` — createTicketFromIssue gains the optional last onCreated parameter.
- `apps/api/src/vcs/prisma-vcs.repository.ts` — createTicketFromIssue awaits onCreated with the inserted ticket inside the retry attempt's transaction, after ticket.create; number allocation and the retry are unchanged.
- `apps/api/src/vcs/vcs.controller.ts` — the one-issue sync route passes 'vcs.sync.issue' to syncIssue; responses are unchanged.
- `apps/api/src/vcs/vcs-polling.service.ts` — poll passes 'system.vcs.poll-issues' to syncIssue; scheduling, the cursor and the sync log are unchanged.
- `apps/api/src/vcs/vcs-webhook.service.ts` — handleIssueOpened passes 'system.vcs.webhook-intake' to syncIssue; its result mapping is unchanged.
- `apps/api/src/vcs/vcs-sync.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, its direct new VcsSyncService(...) passes mockAuditRecorder as the second argument, syncIssue calls pass a key, assertions on createTicketFromIssue's arguments accept the added onCreated callback, and it gains the US-002 AC-12 case; the rest are kept.
- `apps/api/test/integration/vcs/vcs-sync.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, syncIssue calls pass a key, and assertions on createTicketFromIssue's arguments accept the added onCreated callback; the rest are kept.
- `apps/api/test/integration/vcs/vcs-manual-sync.spec.ts` — assertions on syncIssue's arguments expect the added 'vcs.sync.issue' or 'vcs.sync.all' key; the rest are kept.
- `apps/api/test/integration/vcs/vcs-polling.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } so the real VcsSyncService and VcsPrSyncService resolve; the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-polling-comprehensive.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-polling-pr-sync.integration.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.
- `apps/api/src/vcs/vcs-polling.tick.spec.ts` — gains the US-002 AC-11 case (the poller passes 'system.vcs.poll-issues' to syncIssue); the existing assertions are kept.

**US-003**
- `apps/api/src/vcs/vcs-pr-sync.service.ts` — injects AuditRecorder right after vcsRepo (before the optional parameters); syncPrStatus gains the required auditKey parameter and runs each non-merge prState write, including the 404 close, inside audit.audited, recording the key when the write returned 'updated', and wraps the 404 close in its own try/catch that logs and counts the link skipped; the merge branch and the link extraction are unchanged in this story.
- `apps/api/src/vcs/vcs-webhook.service.ts` — injects AuditRecorder right after vcsConfig (before the two optional parameters) and runs the five non-merge PR handlers' prState write inside audit.audited, recording system.vcs.webhook-intake when it returned 'updated' and the stored state changed; outcomes and ignore reasons are unchanged.
- `apps/api/src/vcs/vcs.controller.ts` — the PR sync route passes 'vcs.sync.pr' to syncPrStatus; responses are unchanged.
- `apps/api/src/vcs/vcs-polling.service.ts` — poll passes 'system.vcs.poll-issues' to syncPrStatus.
- `apps/api/src/vcs/vcs-pr-sync.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, syncPrStatus calls pass a key, and it gains the US-003 AC-12 case; the existing assertions are kept.
- `apps/api/src/vcs/vcs-webhook.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } so the real VcsWebhookService resolves; the existing assertions are kept.
- `apps/api/src/vcs/vcs-webhook.merged-terminal.spec.ts` — its direct new VcsWebhookService(...) passes mockAuditRecorder as the fifth argument (after the config); the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-pr-sync.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } and syncPrStatus calls pass a key; the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-pr-sync-auto-transition.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } and syncPrStatus calls pass a key; the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-merged-pr.integration.spec.ts` — its direct new VcsPrSyncService(repo) passes mockAuditRecorder as the second argument; the existing assertions are kept.
- `apps/api/src/vcs/vcs-polling.tick.spec.ts` — gains the US-003 AC-11 case (the poller passes 'system.vcs.poll-issues' to syncPrStatus); the existing assertions are kept.

**US-004**
- `apps/api/src/vcs/vcs-pr-sync.service.ts` — applyMergedPr runs inside runAsSystemWriter(this, …), its link write inside audit.audited (recorded when 'updated'), and handleMergedPrAutoTransition runs applyMergedPrTransition inside audit.audited, recorded on the ticket; the conditional write, the IN_PROGRESS check and the logged-not-thrown transition failure are unchanged.
- `apps/api/src/vcs/vcs-pr-sync.service.spec.ts` — gains the US-004 AC-10 case; the existing assertions are kept.

**US-005**
- `apps/api/src/vcs/vcs-link-extractor.service.ts` — injects AuditRecorder right after vcsRepo (before the optional vcsConfig) and runs each upsertTicketLink inside audit.audited, recording ticket.link.add when it returned a string (a stub resolving undefined records nothing); the provider calls and the ref matching are unchanged.
- `apps/api/src/vcs/prisma-vcs.repository.ts` — upsertTicketLink returns the created link's id, or null when a link for (ticketId, url) existed and was updated; the writes are unchanged.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — injects AuditRecorder as the last constructor parameter, records comment.create in commentOnce after createSystemComment, and records ticket.link.add in linkPr when upsertFleetPrLink returned an id; the claim, the events and the per-ticket catch are unchanged.
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` — upsertFleetPrLink uses createManyAndReturn({ skipDuplicates }) and returns the created row's id, or null after updating the existing link's jobId.
- `apps/api/src/vcs/vcs-link-extractor.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, and it gains the US-005 AC-13 case; the existing assertions are kept.
- `apps/api/src/vcs/vcs-link-extractor.pr-number.spec.ts` — its direct new VcsLinkExtractorService(...) passes mockAuditRecorder as the second argument; the existing assertions are kept.
- `apps/api/test/integration/vcs/vcs-link-extractor.service.spec.ts` — its direct new VcsLinkExtractorService(repo) calls pass mockAuditRecorder as the second argument; the existing assertions are kept.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.spec.ts` — its direct new FleetJobTicketEffects(...) calls pass mockAuditRecorder as the new last argument, its upsertFleetPrLink stubs resolve a link id instead of true and null instead of false, and it gains the US-005 AC-14 case; the existing assertions are kept.
- `apps/api/src/fleet/ingest/bundle-ingest.workflow.spec.ts` — its direct new FleetJobTicketEffects(...) passes mockAuditRecorder as the new last argument and its upsertFleetPrLink stub resolves a link id; the existing assertions are kept.

**US-006**
- `apps/api/src/ci-webhook/ci-webhook.service.ts` — injects AuditRecorder as the last constructor parameter; the private createTicket takes the project's key as well, for the summary, and passes repo.createTicket an onCreated callback that records system.ci.ticket-create on the ticket; event filtering and the response are unchanged.
- `apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts` — createTicket gains the optional last onCreated parameter, awaited inside the retry attempt's transaction after ticket.create.
- `apps/api/src/ci-webhook/ci-webhook.controller.ts` — replayGuard.assertFresh and forget run inside runAsSystem('ci', …), awaiting inside the callback; the signature check, validation order and responses are unchanged.
- `apps/api/src/vcs/vcs-webhook.controller.ts` — replayGuard.assertFresh and forget run inside runAsSystem('vcs', …), awaiting inside the callback; the signature check, the ignore rule and responses are unchanged.
- `apps/api/src/ci-webhook/ci-webhook.service.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, assertions on createTicket's arguments accept the added onCreated callback, and it gains the US-006 AC-7 case; the rest are kept.
- `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts` — gains the US-006 AC-8 case; the existing assertions are kept.
- `apps/api/src/vcs/vcs-webhook.controller.spec.ts` — gains the US-006 AC-9 case; the existing assertions are kept.

### Seams

- US-002 creates `src/vcs/vcs-audit.ts`; US-003 imports `VcsPrStateAuditKey` and `prStateSummary` from it and depends on US-002. No other story calls a symbol a later story creates.
- Every story's integration ACs enter through the real wiring of the booted `AppModule`: a route over HTTP (the connection routes, the manual sync routes, the signed webhook and CI intakes), or the service fetched with `app.get` and called the way its entry point calls it (`VcsSyncService.syncIssue` and `VcsPrSyncService.syncPrStatus` inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })` for the poller's key, `applyMergedPr`, `FleetPrStateRefresher.refresh`, `FleetJobTicketEffects.onTerminal` and `upsertPrLinks` inside `withTestActor({ type: 'RUNNER', id })`, `VcsLinkExtractorService.extractLinksFromPr`). Each asserts the stored `AuditEntry` row, so it proves the writer reaches the recorder rather than a stub. The poller's own key forwarding is pinned by the unit ACs over `schedulePolling` with fake timers (US-002 AC11, US-003 AC11).
- The "seen from another context" ACs (US-004 AC2 and AC4, US-005 AC7) run the write under a different actor and assert the entry's actor, pinning where `runAsSystemWriter` wraps and where the current actor is kept.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database with `bootHttpApp({ registrationEnabled: false })` after setting `process.env.VCS_ENCRYPTION_KEY` to `'ab'.repeat(32)` (restored in `afterAll`), as `vcs-webhook-secret.integration.spec.ts` does. `root` registers first and is the Owner; `viewer` is created through `POST /api/admin/users` and added to the spec's project with role `viewer`. Each spec creates its own project (the US-001 spec: slug `vcs-audit`, key `VAU`) and reads `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. A connection fixture is created with `POST /api/projects/:slug/vcs` as `root`, body `{ provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_audit_token', syncMode: 'webhook' }`, keeping the returned `webhookSecret`. A signed webhook is `POST /api/projects/:slug/vcs-webhook` with the JSON body, `x-hub-signature-256` `sha256=<HMAC-SHA256 of the body with the secret>`, `x-github-event`, and a fresh `x-github-delivery`, as `vcs-permissions.integration.spec.ts` AC-14 signs one. A PR link fixture is a `TicketLink` created with `fixtureDb(app)` on a ticket of the project: `url` `https://github.com/acme/app/pull/<n>`, `provider` `github`, `linkType` `pr`, `prNumber` `<n>`, `externalRef` `acme/app#<n>`, and the AC's `prState`. Where an AC needs the VCS provider, `src/vcs/factory` is mocked partially, keeping its other exports (`parseRepoPath` is used by the connection routes): `vi.mock('../../../src/vcs/factory', async (orig) => ({ ...(await orig()), createVcsProvider: vi.fn() }))`, with `createVcsProvider` returning a stub whose `fetchIssue`, `fetchIssues`, `getPullRequestStatus` and `listPrCommits` the AC sets. `key` in a direct `syncPrStatus` or `extractLinksFromPr` call is `process.env.VCS_ENCRYPTION_KEY` (`'ab'.repeat(32)`). Every `getPullRequestStatus` stub in US-003 returns no `branchName`, so the fire-and-forget extractor does not run inside those ACs. `resetThrottle(app)` is called in `beforeEach`. A `connection` passed to a service directly is `app.get(VcsConnectionService).getFullByProject(projectId)` of the HTTP-created connection fixture, and `project` is `{ id, key, slug }` of the spec's project. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource (and key, where named) returns an empty array; "unchanged" compares a `count` taken before and after the call. "Spied to reject" means `vi.spyOn(app.get(AuditRecorder), 'record')` with an implementation that rejects with `new Error('audit down')` the first call whose `input.key` is the key the AC's writer records (or whose `input.resourceType` is the one the AC names, where it says so) and delegates every other call to the original; the spy is restored after the AC.

### US-001: VCS connection writes are audited

1. [integration] `POST /api/projects/vcs-audit/vcs` as `root` with the connection fixture's body returns 201 and leaves one entry for the returned `id` with `key` `vcs.connection.create`, `resourceType` `vcs-connection`, `projectId` the project's id, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `github acme/app, sync webhook`.
2. [integration] No `AuditEntry` row's `summary` contains `ghp_audit_token` or the `webhookSecret` the create returned.
3. [integration] A second `POST /api/projects/vcs-audit/vcs` returns 409 and the count of `vcs.connection.create` entries is unchanged.
4. [integration] `PATCH /api/projects/vcs-audit/vcs` as `root` with `{ token: 'ghp_rotated', syncMode: 'polling' }` returns 200 and leaves one entry for the connection with `key` `vcs.connection.update` and `summary` `fields: syncMode, token`.
5. [integration] `PATCH /api/projects/vcs-audit/vcs` with `{ syncMode: 'webhook' }` on the connection after its `webhookSecret` was set to `null` directly returns 200 and leaves one entry for the connection with `key` `vcs.connection.update` and `summary` `fields: syncMode, webhookSecret`.
6. [integration] `PATCH /api/projects/vcs-audit/vcs` with `{}` returns 200 and the count of `vcs.connection.update` entries for the connection is unchanged.
7. [integration] `POST /api/projects/vcs-audit/vcs/webhook-secret/rotate` as `root` returns 200 and leaves one entry for the connection with `key` `vcs.webhook-secret.rotate` and `summary` `webhook secret rotated`, and no entry's `summary` contains the returned `webhookSecret`.
8. [integration] `PATCH /api/projects/vcs-audit/vcs` as `viewer` returns 403 and the count of `vcs.connection.update` entries for the connection is unchanged.
9. [integration] `DELETE /api/projects/vcs-audit/vcs` as `root` returns 204 and leaves one entry for the deleted connection's id with `key` `vcs.connection.delete` and `summary` `deleted github acme/app`.
10. [integration] A second `DELETE /api/projects/vcs-audit/vcs` returns 404 and the count of `vcs.connection.delete` entries is unchanged.
11. [integration] `POST /api/projects/vcs-audit/vcs` with the fixture's body, while `record` is spied to reject, returns an error status and leaves no `VcsConnection` row for the project.
12. [integration] `POST /api/projects/vcs-audit/vcs/webhook-secret/rotate`, while `record` is spied to reject, returns an error status and the connection's stored `webhookSecret` is unchanged.

### US-002: VCS issue imports are audited

1. [integration] `POST /api/projects/:slug/vcs/sync/7` as `root`, with the provider stub's `fetchIssue` returning issue 7 (`title` `Private title`, `body` `Private body`), returns 200 with `issuesSynced` 1 and one `tickets` entry, and leaves one entry for the new ticket's id with `key` `vcs.sync.issue`, `resourceType` `ticket`, `projectId` the project's id, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `imported issue #7`.
2. [integration] AC1's entry's `summary` contains neither `Private title` nor `Private body`.
3. [integration] Repeating AC1's request returns 409 and the count of `vcs.sync.issue` entries is unchanged.
4. [integration] `POST /api/projects/:slug/vcs/sync` as `root`, with `fetchIssues` returning issues 8 and 9, leaves one `vcs.sync.all` entry for each of the two new tickets, with `summary` `imported issue #8` and `imported issue #9`.
5. [integration] A signed `issues` webhook with `{ action: 'opened', issue: <issue 10 with user.login 'octo', html_url, labels [], created_at an ISO date> }` returns 200 and leaves one entry for the new ticket with `key` `system.vcs.webhook-intake`, `actorType` `SYSTEM`, `actorId` `vcs`, `origin` `system` and `summary` `imported issue #10`.
6. [integration] `app.get(VcsSyncService).syncIssue(project, <issue 11>, 'polling', connection, 'system.vcs.poll-issues')` inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })` returns `created` and leaves one entry for the new ticket with `key` `system.vcs.poll-issues`, `actorType` `SYSTEM` and `actorId` `vcs`.
7. [integration] `POST /api/projects/:slug/vcs/sync/12`, while `record` is spied to reject, returns an error status and no ticket of the project has `externalVcsId` ending in `#12`.
8. [integration] `POST /api/projects/:slug/vcs/sync` with `fetchIssues` returning issue 13, while `record` is spied to reject, returns 200 with `issuesSynced` 0, `issuesSkipped` 1 and an empty `tickets` list, and no ticket of the project has `externalVcsId` ending in `#13`.
9. [integration] Ten concurrent `syncIssue` calls for issues 20 to 29 inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })` with key `system.vcs.poll-issues` all return `created`, the ten new tickets have distinct numbers, and there are ten `system.vcs.poll-issues` entries, one per new ticket (`ticket-number-allocation.integration.spec.ts` uses the same N).
10. [unit] `prStateSummary(null, 'open')` returns `pr none -> open` and `prStateSummary('open', 'closed')` returns `pr open -> closed`.
11. [unit] `VcsPollingService` with stub collaborators as in `vcs-polling.tick.spec.ts`, after `schedulePolling(connection)` and one interval of fake time with `fetchIssues` returning one issue, calls `sync.syncIssue` with `'system.vcs.poll-issues'` as its fifth argument.
12. [unit] `VcsSyncService.syncIssue` with a stub repository whose `createTicketFromIssue` calls its `onCreated` with `{ id: 't-1', number: 3 }`, and a stub recorder, calls the recorder's `record` once with `key` the passed auditKey, `resourceType` `ticket`, `resourceId` `t-1` and `summary` `imported issue #<issue number>`.
13. [integration] AC5's webhook for issue 14, while `record` is spied to reject, returns 200 with `success` `false`, leaves no ticket with `externalVcsId` ending in `#14`, and resending it with the same `x-github-delivery` is refused as a replay.

### US-003: VCS PR-state writes are audited

1. [integration] `POST /api/projects/:slug/vcs/sync-pr` as `root`, over a PR link fixture with `prState` `open` whose stubbed `getPullRequestStatus` reports it closed and not merged, leaves one entry for the link's id with `key` `vcs.sync.pr`, `resourceType` `ticket-link`, `projectId` the project's id, `actorType` `USER`, `actorId` root's id and `summary` `pr open -> closed`.
2. [integration] `POST …/vcs/sync-pr` over a PR link fixture with `prState` `open` whose stub reports it still open leaves no entry for the link.
3. [integration] `POST …/vcs/sync-pr` over a PR link fixture with `prState` `draft` whose stub rejects with a `NotFoundAppException` leaves one entry for the link with `key` `vcs.sync.pr` and `summary` `pr draft -> closed`.
4. [integration] `app.get(VcsPrSyncService).syncPrStatus(project, connection, key, 'system.vcs.poll-issues')` inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })`, over a PR link fixture with `prState` `draft` reported open (`findActiveTicketLinksWithPrs` excludes a `null` state), leaves one entry for the link with `key` `system.vcs.poll-issues`, `actorId` `vcs` and `summary` `pr draft -> open`.
5. [integration] A signed `pull_request` webhook `{ action: 'closed', pull_request: { number: <n>, merged: false, … } }` for a PR link fixture with `prState` `null` returns 200 and leaves one entry for the link with `key` `system.vcs.webhook-intake`, `actorType` `SYSTEM`, `actorId` `vcs` and `summary` `pr none -> closed`.
6. [integration] A signed `pull_request` webhook with `action` `converted_to_draft` for a PR link fixture with `prState` `open` leaves one entry for the link with `summary` `pr open -> draft`.
7. [integration] A signed `pull_request` webhook with `action` `reopened` for a PR link fixture with `prState` `open` returns 200 and leaves no entry for the link.
8. [integration] A signed `pull_request` webhook with `action` `closed`, `merged` `false`, for a PR link fixture with `prState` `merged` leaves no entry for the link and its `prState` stays `merged`.
9. [integration] A signed `pull_request` webhook for a PR number no link has returns 200 with `ignored` `true` and the count of `system.vcs.webhook-intake` entries is unchanged.
10. [integration] AC5's webhook, while `record` is spied to reject, returns an error status and the link's `prState` is still `null`; resending it with the same `x-github-delivery` returns 200 and leaves the `pr none -> closed` entry.
11. [unit] `VcsPollingService` with stub collaborators as in `vcs-polling.tick.spec.ts`, after `schedulePolling(connection)` and one interval of fake time, calls `prSync.syncPrStatus` with `'system.vcs.poll-issues'` as its fourth argument.
12. [unit] `VcsPrSyncService.syncPrStatus` with a stub repository whose `updateTicketLinkWithPrState` returns `'already-merged'` and a stub recorder whose `audited` runs its `fn` and records the entries `entriesOf` returns, calls the recorder's `record` zero times.
13. [integration] AC3's request, while `record` is spied to reject, returns 200 with `updated` 0, and the link's `prState` is still `draft`.

### US-004: The PR merge step is audited

1. [integration] `app.get(VcsPrSyncService).applyMergedPr(link, <merged status>)` inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })`, for a PR link fixture with `prState` `open` on an `IN_PROGRESS` ticket (as `vcs-merge-step.integration.spec.ts` builds one), returns `updated` and leaves one entry for the link with `key` `system.vcs.pr-merge-transition`, `resourceType` `ticket-link`, `actorType` `SYSTEM`, `actorId` `vcs`, `origin` `system` and `summary` `pr open -> merged`, and one entry for the ticket with `key` `system.vcs.pr-merge-transition`, `resourceType` `ticket` and `summary` `status: IN_PROGRESS -> VERIFY_FIX`.
2. [integration] AC1's call inside `withTestActor({ type: 'USER', id: <root's id> })` leaves both entries with `actorType` `SYSTEM` and `actorId` `vcs`.
3. [integration] Two concurrent `applyMergedPr` calls for one link leave one link entry and one ticket entry with `key` `system.vcs.pr-merge-transition`.
4. [integration] `app.get(FleetPrStateRefresher).refresh()` over a fleet PR link with `prState` `open` on an `IN_PROGRESS` ticket whose stubbed GitHub client reports the PR merged (as `fleet-pr-refresher.integration.spec.ts` stubs it) leaves one link entry and one ticket entry with `key` `system.vcs.pr-merge-transition` and `actorId` `vcs`, and no `system.ticket-link.pr-refresh` entry for the link.
5. [integration] A signed `pull_request` webhook `{ action: 'closed', pull_request: { number: <n>, merged: true, merged_by: { login: 'octo' }, merge_commit_sha: 'abc', … } }` for a PR link fixture with `prState` `open` on an `IN_PROGRESS` ticket leaves the link entry and the ticket entry, and neither `summary` contains `octo` or `abc`.
6. [integration] `applyMergedPr` for a PR link fixture with `prState` `open` on a `CREATED` ticket returns `updated`, leaves the link entry, and leaves no `system.vcs.pr-merge-transition` entry for the ticket.
7. [integration] `applyMergedPr` for a link already `merged` returns `already-merged` and leaves no entry for the link or the ticket.
8. [integration] AC1's call, while `record` is spied to reject on its first `system.vcs.pr-merge-transition` call, rejects, the link's `prState` is still `open` and the ticket is still `IN_PROGRESS`.
9. [integration] AC1's call, with `record` spied to reject only for a call whose `input.resourceType` is `ticket`, returns `updated`, the link is `merged` with its entry, the ticket is still `IN_PROGRESS`, and the ticket has no `FIX_REPORT` comment.
10. [unit] `VcsPrSyncService.applyMergedPr` with a stub repository and a stub recorder whose `audited` captures `currentContext()` when called, called inside `runWithActor({ type: 'USER', id: 'u-1' }, …)`, captures an actor `{ type: 'SYSTEM', id: 'vcs' }` for both `audited` calls.

### US-005: Extracted links and fleet ticket effects are audited

1. [integration] `app.get(VcsLinkExtractorService).extractLinksFromPr(project, ticket, connection, key, 'feat/x', <n>)` inside `withTestActor({ type: 'USER', id: <root's id> })`, with the provider stub's `getPullRequestStatus` returning PR `<n>` and `listPrCommits` returning one commit whose message names the ticket's ref, leaves two `ticket.link.add` entries with `projectId` the project's id, `actorType` `USER`, `actorId` root's id and `summary` `on <ticket ref>`, one for the branch link's id and one for the commit link's id.
2. [integration] Repeating AC1's call leaves the count of `ticket.link.add` entries for the ticket's links unchanged.
3. [integration] AC1's call inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })` for another ticket leaves its entries with `actorType` `SYSTEM` and `actorId` `vcs`.
4. [integration] AC1's call for another ticket, while `record` is spied to reject, rejects, and no `TicketLink` exists for that ticket's branch URL.
5. [integration] `app.get(FleetJobTicketEffects).onTerminal([jobId])` inside `withTestActor({ type: 'RUNNER', id: <runner id> })`, for a `FAILED` job linked to one ticket (as `fleet-tickets-terminal.integration.spec.ts`'s `linkedJob` builds it), leaves one entry for the new failure comment with `key` `comment.create`, `resourceType` `comment`, `projectId` the job's project, `actorType` `RUNNER`, `actorId` the runner's id and `summary` `on <ticket ref>`.
6. [integration] A second `onTerminal([jobId])` for AC5's job leaves the count of `comment.create` entries on that ticket's comments unchanged.
7. [integration] `onTerminal([jobId])` inside `withTestActor({ type: 'SYSTEM', id: 'job' })`, for another `FAILED` linked job, leaves its comment entry with `actorType` `SYSTEM` and `actorId` `job`.
8. [integration] `onTerminal([jobId])` for a `COMPLETED` linked job with no `resultPrUrl` leaves no entry for the job's ticket's comments or links.
9. [integration] `app.get(FleetJobTicketEffects).upsertPrLinks(jobId)` inside `withTestActor({ type: 'RUNNER', id: <runner id> })`, for a `COMPLETED` job linked to one ticket with `resultPrUrl` a PR on the job's repo (as `fleet-pr-links.integration.spec.ts` sets it), leaves one entry for the new link's id with `key` `ticket.link.add`, `resourceType` `ticket-link` and `summary` `on <ticket ref>`.
10. [integration] A second `upsertPrLinks(jobId)` for AC9's job leaves the count of `ticket.link.add` entries for the link unchanged.
11. [integration] `upsertPrLinks(jobId)` for a job whose ticket already has a `vcs` link with the same URL leaves that link's `jobId` set to the job and no `ticket.link.add` entry for the link.
12. [integration] `onTerminal([jobA, jobB])` for two `FAILED` jobs, each linked to its own ticket, while `record` is spied to reject (its first `comment.create` call, which is jobA's), resolves, leaves no comment on jobA's ticket, and leaves one comment on jobB's ticket with its `comment.create` entry.
13. [unit] `VcsLinkExtractorService.extractLinksFromPr` with a stub repository whose `upsertTicketLink` resolves `null` for the branch URL, and a stub recorder whose `audited` runs its `fn` and records the entries `entriesOf` returns, calls the recorder's `record` zero times for that URL.
14. [unit] `FleetJobTicketEffects.upsertPrLinks` with stubs whose `upsertFleetPrLink` resolves `null`, and a stub recorder, does not call the recorder's `record`.

### US-006: CI ticket creation is audited and the replay rows get the component's actor

1. [integration] A signed `POST /api/projects/:slug/ci-webhook` (as `endpoint.e2e.spec.ts` signs one, with the project's `ciWebhookToken` set through `fixtureDb(app)`) with `event` `pipeline_failed` and one failure returns 200 with a `ticketRef`, and leaves one entry for the new ticket with `key` `system.ci.ticket-create`, `resourceType` `ticket`, `projectId` the project's id, `actorType` `SYSTEM`, `actorId` `ci`, `origin` `system` and `summary` `created <ticketRef>`.
2. [integration] AC1's entry's `summary` contains neither the failure's test name, its file, the pipeline id nor the commit SHA.
3. [integration] Resending AC1's request with the same `x-ci-delivery` is refused as a replay and the count of `system.ci.ticket-create` entries is unchanged.
4. [integration] A signed CI webhook with `event` `pipeline_succeeded` returns 200 and the count of `system.ci.ticket-create` entries is unchanged.
5. [integration] A signed CI webhook with `event` `pipeline_failed`, while `record` is spied to reject, returns an error status, the project's ticket count is unchanged, and resending it with the same `x-ci-delivery` returns 200 with a `ticketRef`.
6. [integration] Ten concurrent signed CI webhooks with distinct `x-ci-delivery` ids each return 200, the project's new tickets have ten distinct numbers, and there are ten `system.ci.ticket-create` entries.
7. [unit] `CiWebhookService.processCiWebhook` with a stub repository whose `createTicket` calls its `onCreated` with `{ id: 't-1', number: 4 }`, a project with `key` `CIK`, and a stub recorder whose `record` captures `currentContext()`, records once with `key` `system.ci.ticket-create`, `resourceId` `t-1` and `summary` `created CIK-4`, and the captured actor is `{ type: 'SYSTEM', id: 'ci' }`.
8. [unit] `CiWebhookController.handleCiWebhook` with a stub replay guard whose `assertFresh` captures `currentContext()`, called inside `runWithActionContext({ actor: { type: 'SYSTEM', id: 'anonymous' }, origin: 'rest' }, …)` with a validly signed body, captures an actor `{ type: 'SYSTEM', id: 'ci' }`; a failing intake's `forget` captures the same actor.
9. [unit] `VcsWebhookController.handleWebhook` with a stub replay guard whose `assertFresh` captures `currentContext()`, called inside `runWithActionContext({ actor: { type: 'SYSTEM', id: 'anonymous' }, origin: 'rest' }, …)` for a webhook-mode connection and a valid signature, captures an actor `{ type: 'SYSTEM', id: 'vcs' }`.
