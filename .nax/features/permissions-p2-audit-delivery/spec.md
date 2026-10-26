# SPEC: Permissions P2k — Audit Entries for the Delivery Writers

## Summary

This feature makes the delivery-side writers in `apps/api` record an `AuditEntry`. It uses the recorder and the rules from `permissions-p2-audit-core`: `AuditRecorder.record` inside the write's transaction, and `AuditRecorder.audited` when there is none. The writes:
- **Outbound webhook configuration.** `POST /projects/:slug/webhooks`, `PATCH /projects/:slug/webhooks/:id`, `DELETE /projects/:slug/webhooks/:id` and the global `DELETE /webhooks/:id` (`WebhookService`).
- **Skills.** `POST /admin/skills/sources`, `POST /admin/skills/sources/:id/update`, `DELETE /admin/skills/sources/:id`, `PUT /projects/:slug/skills/:skillId` and `DELETE /projects/:slug/skills/:skillId` (`SkillsService`).
- **Notification preferences, ticket watch and outbox retry.** `PUT /me/notification-preferences` (`NotificationPreferencesService`), `PUT` and `DELETE /projects/:slug/tickets/:ref/watch` (`TicketWatchService`), `POST /admin/outbox/:eventId/retry` (`OutboxAdminService`).
- **System writers that change state.** The outbox retention purge (`OutboxRetentionProcessor`, `system.outbox.retention`), the notification retention purge (`NotificationRetentionProcessor`, `system.notification.retention`), and the fleet health detector's opened and closed episodes (`FleetHealthDetector`, `system.health.detect`).
- **The system role seeder.** A role `SystemRoleSeeder` creates or restores at bootstrap records `role.manage` as `SYSTEM/seed`.

The delivery plumbing records nothing: outbound webhook sends, outbox dispatch bookkeeping, email sends, notification fan-out, read marks and the assistant action's outcome note. The Bookkeeping table names them. The nine assistant tools in the inventory already reach an audited service and need no change.

This is the eleventh of twelve features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, audit-fleet-routes, audit-fleet-ops, audit-fleet-system, web, audit-vcs-ci, audit-knowledge, **audit-delivery**, audit-coverage.

## Motivation

`permissions-p2-audit-knowledge` (PR #335, deployed `ec6ee6d9` on 2026-10-26) closed the knowledge writers. A webhook a project admin pointed at a new URL, a skill source a global admin deleted, a skill enabled on a project, a dead outbox event an admin replayed, a nightly purge that deleted read notifications, and a seeder that rolled back an admin's edit of a system role still leave no entry.

`permissions-p2-audit-integrations` was split by domain before drafting (audit-vcs-ci spec, Motivation). This feature is the delivery domain: outbound webhooks and delivery, skills, notifications and ticket watch, outbox, email, fleet health, the assistant action finalize, the role seeder and the assistant tools that reach no audited service. The grounding found that every one of the nine assistant tool rows of the inventory already reaches an audited service at `ec6ee6d9`, so that part has no work (see "The assistant tools").

**Rulings that bind this feature** (user, 2026-10-24):
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The coverage guard and the walker test belong to the last P2 feature** (`permissions-p2-audit-coverage`). This feature does not add them.

The user skipped the design questions for the integrations split ("skip questions and proceed", 2026-10-25) and asked to proceed with this feature in order on 2026-10-26. Every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Delivery plumbing is bookkeeping.** A webhook send, an email send, an outbox handler's `lastError`, a notification row and its email schedule, and a watcher row the ticket subscriber ensures are each derived from a write that already carries an entry (the ticket event, the approval, the job outcome), or record their own delivery state in their own row (`OutboxEvent.status`, `EmailSchedule.status`). Recording them would add one entry per recipient or per attempt and tell an auditor nothing the source entry does not. They record nothing.
- **Read marks are bookkeeping.** `POST /me/notifications/:id/read` and `POST /me/notifications/read-all` change only the caller's own inbox state. They record nothing. Preferences and ticket watch are recorded: each is a setting that changes what the system later delivers to the caller.
- **The assistant action's finalize is bookkeeping.** `AssistantActionDecisions.finalize` writes the action's terminal status (`EXECUTED`/`FAILED`) and its outcome note after the tool ran. The decide already recorded `fleet.approval.decide.assistant`, and the tool's own write recorded its domain entry as `SYSTEM/assistant` on behalf of the requester. It records nothing.
- **Each service records at its own write, through `audited`.** None of the changed services writes `AuditEntry` today. `WebhookService`, `SkillsService`, `NotificationPreferencesService`, `TicketWatchService` and `OutboxAdminService` take `AuditRecorder` as their last constructor parameter. Each write becomes `this.audit.audited(() => <the existing write>, (result) => entries)`. Where the service already runs `this.txManager.run(() => write)`, that call becomes `this.audit.audited(() => write, entriesOf)`, which opens the same transaction. Where the result says nothing was written (a `null` or `false` repository answer, a count of 0), `entriesOf` returns `[]` and the service raises its existing error after `audited` resolves.
- **A webhook entry never prints the URL or the secret.** A URL may carry a token in its path or query, and the secret is the HMAC key. Create records `created`, update records `fieldsSummary(dto)` (field names only), delete records `deleted`.
- **The global webhook delete records the webhook's project.** `DELETE /webhooks/:id` has no slug. `WebhookService.remove` already reads the webhook before deleting, so its entry carries `projectId` from that row.
- **A skill source entry names its status and skill count.** Create and update record `<verb>, status <status>, skills <n>` (verb `created` or `updated`; `n` is the number of skills on the returned source). Git coordinates are not secret, but they are already the source row; the summary does not repeat them. Both the resolved and the `RESOLVE_FAILED` outcome of create, and both outcomes of update, are writes and record.
- **Enable and disable record every successful call.** `enableProjectSkill` upserts the row (it rewrites `enabledById`), and `disableProjectSkill` answers `true` for a skill that exists whether or not a row was removed. Changing the repository's answer to tell the two apart is out of scope; a repeated disable records a second `skill.project.disable`.
- **A webhook update with no field records `summary` `null`.** `fieldsSummary` answers `undefined` for an empty patch, so the entry is written with no summary, as `label.update` does.
- **A preferences update records one entry naming the changed switches.** The summary is `fields: <names>`, the distinct names sorted in code-unit order (so the uppercase categories come before `emailEnabled`: `fields: ASSIGNED.inApp, MENTIONED.email, emailEnabled`), where a name is `emailEnabled` or `<CATEGORY>.<channel>` (`MENTIONED.email`, `ASSIGNED.inApp`). Values are never printed. A body that supplies no switch records nothing. `NotificationPreferencesService.update` runs its whole body inside `audited`: the master switch goes through `IPreferenceService.updatePreference` (`@nathapp/nestjs-notify`), whose store joins the ambient transaction only if it writes through the proxied `PrismaService`. So the category rows and the entry are atomic, and the master switch is atomic with them only when the package store joins.
- **Watch and unwatch record on the ticket.** `ticket.watch.set` with summary `watching`, and `ticket.watch.unset` with summary `muted` (an unwatch sets `muted`; the row stays).
- **An outbox retry records on the event.** Summary `retried <type>, was <status>`, `projectId` from the event (`event.projectId ?? null`: `OutboxEventDomain.projectId` is typed `string` but is `null` at runtime for a global type). A reset that changed no row (`resetForRetry` answered 0, a concurrent change) records nothing and answers the existing 409.
- **A retention purge records one entry per step per run that deleted rows.** This is the `EnrollmentRetentionProcessor` precedent from audit-fleet-system: `audited(() => delete, (count) => count === 0 ? [] : [{ …, resourceId: 'all', projectId: null }])`. The outbox purge records `purged <n> terminal events` on `outbox-event`. The notification purge records `purged <n> read notifications` on `notification` and `purged <n> closed health alerts` on `fleet-health-alert`, both under `system.notification.retention`. Each step already logs and swallows its own failure, so a rejected `record` rolls that step's delete back, is logged, and the next step runs.
- **The health detector records each opened episode in its existing transaction, and closes per run.** An opened episode records `system.health.detect` on `fleet-health-alert` with the alert id and summary `opened <kind>`, inside the `txManager.run` that already writes the episode and its outbox event. A close of one or more episodes records one entry with `resourceId` `all` and summary `closed <n>`, through `audited` around `repo.close`; a close that closed nothing records nothing.
- **The seeder records `role.manage` as `SYSTEM/seed`.** `seed` is a keyless system actor id (`action-context.ts:70`), so there is no `system.*` key to record under. `role.manage` is the key `RoleAdminService` records for an admin's role writes, and the actor (`SYSTEM/seed`, origin `system`) tells them apart. A created role records `seeded`; a restored role records `restored from seed, ` followed by `fieldsSummary(patch)` (`fields: name, permissions, scope` for the locked `owner`, `fields: name, scope` for an unlocked role). A role that needs no patch records nothing. Each write runs through `audited`. Adding a `system.role.seed` catalog key is out of scope.

### The assistant tools

The inventory's nine assistant tool rows reach these audited services at `ec6ee6d9`; none needs a change, and the coverage feature's walker can map each row to the service's key:

| Tool | Service call | Key recorded |
|:--|:--|:--|
| `koda_add_comment` | `CommentsService.create` | `comment.create` |
| `koda_create_tickets` | `TicketsService.create` | `ticket.create` |
| `koda_update_ticket` | `TicketsService.update` | `ticket.update` |
| `koda_link_tickets` | `TicketLinksService.create` | `ticket.link.add` |
| `koda_add_memory` | `PrismaMemoryItemRepository.upsert` with `memoryAuditHook` | `memory.create` |
| `koda_record_decision` | `ExtractionService.recordDecision` with `memoryAuditHook` | `memory.decision.record` |
| `koda_dispatch_job` | `FleetJobsService.dispatch` | `fleet.job.dispatch` |
| `koda_requeue_job` | `FleetJobsService.requeue` | `fleet.job.requeue` |
| `koda_cancel_job` | `FleetJobsService.cancel` | `fleet.job.cancel` |

`POST /mcp` (`mcp.access`) and `POST /fleet/runner/jobs/:jobId/tools/:name` (`runner.tool.call`) are transports: the tool they run records.

### Keys and summaries

| Writer | Key | `resourceType` | `resourceId` | `projectId` | Summary | Story |
|:--|:--|:--|:--|:--|:--|:--|
| `WebhookService.create` | `webhook.create` | `webhook` | webhook id | the project | `created` | US-001 |
| `WebhookService.update` | `webhook.update` | `webhook` | webhook id | the project | `fieldsSummary(dto)` | US-001 |
| `WebhookService.removeForProject`, `remove` | `webhook.delete` | `webhook` | webhook id | the webhook's project | `deleted` | US-001 |
| `SkillsService.createSource` | `skill.source.create` | `skill-source` | source id | `null` | `created, status <status>, skills <n>` | US-002 |
| `SkillsService.updateSource` (both outcomes) | `skill.source.update` | `skill-source` | source id | `null` | `updated, status <status>, skills <n>` | US-002 |
| `SkillsService.deleteSource` | `skill.source.delete` | `skill-source` | source id | `null` | `deleted` | US-002 |
| `SkillsService.enableProjectSkill` | `skill.project.enable` | `skill` | skill id | the project | `enabled` | US-002 |
| `SkillsService.disableProjectSkill` | `skill.project.disable` | `skill` | skill id | the project | `disabled` | US-002 |
| `NotificationPreferencesService.update` | `notification.preference.update` | `user` | the caller's user id | `null` | `fields: <names>` | US-003 |
| `TicketWatchService.watch` | `ticket.watch.set` | `ticket` | ticket id | the project | `watching` | US-003 |
| `TicketWatchService.unwatch` | `ticket.watch.unset` | `ticket` | ticket id | the project | `muted` | US-003 |
| `OutboxAdminService.retry` | `outbox.retry` | `outbox-event` | event id | the event's project | `retried <type>, was <status>` | US-003 |
| `OutboxRetentionProcessor` | `system.outbox.retention` | `outbox-event` | `all` | `null` | `purged <n> terminal events` | US-004 |
| `NotificationRetentionProcessor` (read notifications) | `system.notification.retention` | `notification` | `all` | `null` | `purged <n> read notifications` | US-004 |
| `NotificationRetentionProcessor` (closed health alerts) | `system.notification.retention` | `fleet-health-alert` | `all` | `null` | `purged <n> closed health alerts` | US-004 |
| `FleetHealthDetector` (open) | `system.health.detect` | `fleet-health-alert` | alert id | `null` | `opened <kind>` | US-004 |
| `FleetHealthDetector` (close) | `system.health.detect` | `fleet-health-alert` | `all` | `null` | `closed <n>` | US-004 |
| `SystemRoleSeeder` (create) | `role.manage` | `role` | role id | `null` | `seeded` | US-005 |
| `SystemRoleSeeder` (restore) | `role.manage` | `role` | role id | `null` | `restored from seed, fields: <names>` | US-005 |

Every key is in `PERMISSION_CATALOG`. The actor, origin and approval block come from the current context: the route's principal with origin `rest`, or the system component `runAsSystemWriter` sets (`outbox`, `notification`, `health`) and `runAsSystem('seed', …)` for the seeder, with origin `system`.

### Bookkeeping writes (record nothing)

This list is input for the coverage guard's allowlist in `permissions-p2-audit-coverage`; this feature does not build the guard.

| Write | Where |
|:--|:--|
| an outbound webhook send (`system.webhook.deliver`); it writes no row | `WebhookDeliveryHandler.handle` |
| a fan-out handler failure's `lastError` (`system.outbox.dispatch`) | `FanOutPublisher.publish` |
| the outbox relay's claim, publish and dead-letter status | `@nathapp/nestjs-outbox` relay, `PrismaOutboxStore` |
| an email claimed, sent, skipped, failed, backed off, or an abandoned invite send closed (`system.email.dispatch`) | `EmailDispatcher.tick`, `sendOne`, `EmailScheduleService` |
| notification rows and their email schedule rows (`system.notification.ticket`, `system.notification.fleet`) | `NotificationWriter.deliver`, called by `TicketNotificationSubscriber` and the four fleet notification subscribers |
| the watcher rows a ticket event ensures (`REPORTER`, `ASSIGNEE`, `COMMENTER`, `MENTIONED`) | `TicketNotificationSubscriber` through `TicketWatchersRepository.ensure` |
| a notification marked read, or all marked read (`notification.mark-read`) | `MeNotificationsService.markRead`, `markAllRead` |
| an assistant action's terminal status and outcome note | `AssistantActionDecisions.finalize` |
| the MCP and runner tool transports (`mcp.access`, `runner.tool.call`) | `McpController.post`, `RunnerToolController.call` (the tool records) |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `record` rejects inside a webhook create, update or delete | the transaction rolls back: no new webhook, the old fields stay, the webhook still exists; the route answers an error status | US-001 |
| a webhook create with a URL the guard refuses | 400; no write; no entry | US-001 |
| a webhook update or delete of an id that is missing or in another project | 404; no write; no entry | US-001 |
| `record` rejects inside a skill source create, update or delete, or an enable | the transaction rolls back: no source, the old resolution stays, the source still exists, no project skill row; the route answers an error status | US-002 |
| a skill source create refused as a duplicate or a name conflict | 409; no write; no entry | US-002 |
| a skill source update or delete of a missing id, or an enable or disable of a missing skill | 404; no entry | US-002 |
| `record` rejects inside a preferences update with items | the category rows roll back; the route answers an error status | US-003 |
| a preferences update with no switch supplied | 200; no write; no entry | US-003 |
| `record` rejects inside a watch or unwatch | the watcher row is unchanged; the route answers an error status | US-003 |
| a watch or unwatch of a missing ticket ref | 404; no entry | US-003 |
| `record` rejects inside an outbox retry | the event keeps its status; the route answers an error status | US-003 |
| an outbox retry of a missing event, or of one that is not `dead` or `pending` | 404 or 409; no write; no entry | US-003 |
| an outbox retry whose reset changed no row (a concurrent change) | 409; no entry | US-003 |
| `record` rejects inside a retention step | that step's delete rolls back; logged; the next step runs; the cron resolves | US-004 |
| a retention step that deletes nothing | no entry | US-004 |
| the outbox purge or the read-notification step with its retention days unset | the step returns before any delete, as today; no entry (the closed-health-alert step has a fixed 30-day window and still runs) | US-004 |
| `record` rejects inside an episode open | the episode and its outbox event roll back; `detect` rejects; the next tick opens it again | US-004 |
| a detect whose plan opens and closes nothing | no entry | US-004 |
| `record` rejects inside a seeder write | that role's write rolls back; `onApplicationBootstrap` rejects, as for any seed write failure today | US-005 |
| a seeded role that needs no patch | no write; no entry | US-005 |

### Integration

Verified at main `ec6ee6d9`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input)` and `AuditRecorder.audited(fn, entriesOf)` (`entriesOf` may return `[]`), `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. `record` throws for a key outside the catalog and outside a transaction (`txManager.isInTransaction()`), and reads the actor, origin, approval and correlation id from `currentContext()`. `audited` runs `fn` inside `txManager.run`, which an inner `txManager.run` joins.
- `fieldsSummary(patch)` — `src/audit/audit-summary.ts`: sorted names of the defined fields, `fields: a, b`, or `undefined` for none.
- `runAsSystemWriter(writer, fn)`, `runAsSystem(component, fn)` — `src/action-context/action-context.ts`. `OutboxRetentionProcessor.scheduledPurge`, `NotificationRetentionProcessor.scheduledPurge` and `FleetHealthDetector.detect` already run as their component; `SystemRoleSeeder.onApplicationBootstrap` already runs as `seed`. Unchanged.
- The precedent for a retention entry: `EnrollmentRetentionProcessor` (`src/fleet/runners/enrollment-retention.processor.ts:38`), `audited(() => delete, (count) => count === 0 ? [] : [entry])` with `resourceId` `all`.
- `PrismaWebhookRepository.createWebhook`, `findById`, `update`, `deleteWebhook` — `src/webhook/prisma-webhook.repository.ts`; unchanged. They write through `this.prisma.client`, which joins an ambient `txManager.run`.
- `SkillCatalogRepository.createSource`, `markResolveFailed`, `replaceSourceSkills` (each answers the source or `null`), `deleteSource` (`boolean`), `enableProjectSkill` (the skill or `null`), `disableProjectSkill` (`boolean`) — `src/skills/prisma-skill-catalog.repository.ts`; unchanged.
- `TicketWatchersRepository.watch`, `unwatch`, `state`, `findTicketIdByRef` — `src/notifications/ticket-watchers.repository.ts`; unchanged.
- `PrismaOutboxRepository.findById`, `resetForRetry(id, now): Promise<number>`, `deleteTerminalBefore` — `src/outbox/prisma-outbox.repository.ts`; unchanged.
- `NotificationsRepository.purgeRead(before): Promise<number>` and `FleetHealthAlertsRepository.open`, `close(ids, now): Promise<number>`, `purgeClosed(before): Promise<number>` — unchanged.
- `RoleRepository.createRole(input): Promise<RoleDomain>`, `update(id, patch)` — `src/permissions/permissions.types.ts`; unchanged.
- `mockAuditRecorder` — `src/common/test-helpers/global-stubs.module.ts`; `audited` calls its `fn`, `record` resolves. `GlobalStubsModule` provides it as `AuditRecorder`, so `webhook.module.spec.ts`, `skills.module.spec.ts` and `notifications.module.spec.ts` keep compiling; `permissions.module.spec.ts` and `permissions-owner-bootstrap.spec.ts` provide it in their own global stub modules. `AuditLogModule` is `@Global()`.
- `withTestActor(actor, fn)`, `fixtureDb(app)` — `test/helpers/action-context.ts`; `bootHttpApp`, `data`, `loginToken`, `resetThrottle`, `TEST_PASSWORD` — `test/helpers/http-app.ts`.
- Test precedent: `test/integration/webhook/webhook-routes.integration.spec.ts` (webhook routes over HTTP with IP-literal URLs, so the guard needs no DNS), `test/integration/skills/skills-routes.integration.spec.ts` and `skill-source-update-delete.integration.spec.ts` (the booted app's `SKILL_RESOLVER` `resolve` spied, so GitHub is never called), `test/integration/skills/project-skills-routes.integration.spec.ts`, `test/integration/notifications/notifications-api.integration.spec.ts`, `test/integration/outbox/outbox-retention.integration.spec.ts` (terminal rows seeded with an explicit `updatedAt`), `test/integration/notifications/fleet-health-notifications.integration.spec.ts` (`app.get(FleetHealthDetector).detect(now)` past the boot grace), `test/integration/audit/audit-fleet-system-retention.integration.spec.ts`, and `test/integration/permissions/system-roles.integration.spec.ts`.

Changed (baseline → target):
- `WebhookService` constructor — Baseline: `(webhookRepo, urlGuard)`. Target: `(webhookRepo, urlGuard, audit: AuditRecorder)`. `create`, `update`, `remove` and `removeForProject` record the contract's entries; their checks, errors and return values are unchanged.
- `SkillsService` constructor — Baseline: `(catalog, resolver, txManager)`. Target: `(catalog, resolver, audit: AuditRecorder)`; `txManager` is dropped, because every `this.txManager.run(…)` it served becomes `this.audit.audited(…)` (which opens the same transaction) and a private member left unread fails the type check. The three `this.txManager.run(…)` writes of `createSource` and `updateSource`, and the one of `deleteSource`, become `this.audit.audited(…)`; `enableProjectSkill` and `disableProjectSkill` wrap their repository call in `audited`.
- `NotificationPreferencesService` constructor — Baseline: `(prisma, txManager, packagePrefs, email)`. Target: `(prisma, txManager, packagePrefs, email, audit: AuditRecorder)`. `update`'s body runs inside `audited`.
- `TicketWatchService` constructor — Baseline: `(repo)`. Target: `(repo, audit: AuditRecorder)`.
- `OutboxAdminService` constructor — Baseline: `(outboxRepo)`. Target: `(outboxRepo, audit: AuditRecorder)`.
- `OutboxRetentionProcessor` constructor — Baseline: `(repository, config)`. Target: `(repository, config, audit: AuditRecorder)`.
- `NotificationRetentionProcessor` constructor — Baseline: `(repo, config, healthAlerts)`. Target: `(repo, config, healthAlerts, audit: AuditRecorder)`.
- `FleetHealthDetector` constructor — Baseline: `(repo, outbox, txManager, cfg)`. Target: `(repo, outbox, txManager, cfg, audit: AuditRecorder)`.
- `SystemRoleSeeder` constructor — Baseline: `(seeds, roles)`. Target: `(seeds, roles, audit: AuditRecorder)`.

## Out of Scope

- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-coverage`). The Bookkeeping table and the assistant tools table are its input.
- Recording the delivery plumbing (webhook sends, outbox dispatch status and `lastError`, email sends and schedule state, notification rows, the watcher rows a ticket event ensures, read marks, the assistant action's finalize) is out of scope; the Bookkeeping table names each.
- Changing the nine assistant tools, `McpController` or `RunnerToolController` is out of scope; each tool already reaches an audited service.
- Adding a catalog key (`system.role.seed`, one per webhook field, one per preference) is out of scope; each write records under an existing key.
- Recording refused or failed attempts (401, 403, 404, 409, validation errors) is out of scope.
- Recording a read (webhook list, skill list, preferences read, watch state, outbox list) is out of scope; only committed writes are recorded.
- Printing a webhook URL, a webhook secret, a preference value or a before/after diff in an entry is out of scope.
- Changing `disableProjectSkill`'s answer so a disable of a skill that was not enabled records nothing is out of scope; every successful disable records.
- Making the email master switch atomic with its entry is out of scope; it is atomic only when `@nathapp/nestjs-notify`'s preference store joins the ambient transaction.
- Changing a route's status codes, response bodies or `@Requires` keys, the outbound URL guard, the outbox retry rules, the retention windows or the seeder's restore rules is out of scope; `openapi.json` does not change.
- Changing the VCS issues webhook's error contract (it answers 200 `success: false` and keeps the delivery id, pinned by audit-vcs-ci US-002 AC13) is out of scope.
- US-002 only: a test of `updateSource`'s unique-violation race (a name taken between the owner check and the write) is out of scope; that path raises before `audited` records and is unchanged.
- US-003 only: a test of a rejected `record` after a master-switch-only preferences update is out of scope; its atomicity depends on the package store (see above).
- US-001 only: a test of a rejected `record` on the global `DELETE /webhooks/:id` is out of scope; it is the same `audited` delete AC10 pins for the project route.
- US-003 only: tests of an unwatch of a missing ref and of a rejected `record` inside an unwatch are out of scope; each is the same path AC7 and AC8 pin for a watch.
- US-003 only: preference items that supply neither `inApp` nor `email`, and a body naming one category twice, are out of scope; the summary names each supplied switch once.
- US-002 only: tests of an update of a missing source id, a disable of a missing skill and a create refused by a name conflict are out of scope; each raises before `audited` records, as the delete (AC9), enable (AC12) and duplicate (AC3) cases pinned for their siblings.
- US-004 only: a test of a purge whose retention days are unset is out of scope; that early return is unchanged and the spec sets both days before boot.
- US-004 only: a separate test of a rejected `record` in the closed-health-alert purge step is out of scope; it is the same per-step `audited` AC4 pins for the read-notification step.
- US-004 only: a test of a rejected `record` in an episode close is out of scope; it is the same `audited` step AC9 pins for an open's transaction.

## Stories

1. **US-001: Webhook configuration writes are audited** — `Workdir: apps/api` — No dependencies. `WebhookService` records `webhook.create`, `webhook.update` and `webhook.delete`.
2. **US-002: Skill writes are audited** — `Workdir: apps/api` — No dependencies. `SkillsService` records `skill.source.create`, `skill.source.update`, `skill.source.delete`, `skill.project.enable` and `skill.project.disable`.
3. **US-003: Preferences, ticket watch and outbox retry are audited** — `Workdir: apps/api` — No dependencies. `NotificationPreferencesService`, `TicketWatchService` and `OutboxAdminService`; read marks stay unrecorded.
4. **US-004: Retention purges and fleet health episodes are audited** — `Workdir: apps/api` — No dependencies. `OutboxRetentionProcessor`, `NotificationRetentionProcessor` and `FleetHealthDetector`.
5. **US-005: The system role seeder is audited** — `Workdir: apps/api` — No dependencies. `SystemRoleSeeder` records `role.manage` as `SYSTEM/seed` for each role it creates or restores.

Five stories, one capability: each wires the same recorder into a different delivery-side writer, and none is useful as a separate PR. No story uses a symbol another creates. US-005 is apart from US-004 for module locality: it lives in the permissions module and runs at bootstrap, while US-004's writers are the outbox and notification processors.

### Context Files

**US-001**
- `apps/api/src/webhook/webhook.service.ts`
- `apps/api/src/webhook/webhook.controller.ts`
- `apps/api/src/labels/labels.service.ts`
- `apps/api/test/integration/webhook/webhook-routes.integration.spec.ts`

**US-002**
- `apps/api/src/skills/skills.service.ts`
- `apps/api/src/skills/prisma-skill-catalog.repository.ts`
- `apps/api/test/integration/skills/skills-routes.integration.spec.ts`
- `apps/api/test/integration/skills/project-skills-routes.integration.spec.ts`

**US-003**
- `apps/api/src/notifications/notification-preferences.service.ts`
- `apps/api/src/notifications/ticket-watch.service.ts`
- `apps/api/src/outbox/outbox-admin.service.ts`
- `apps/api/test/integration/notifications/notifications-api.integration.spec.ts`

**US-004**
- `apps/api/src/outbox/outbox-retention.processor.ts`
- `apps/api/src/notifications/notification-retention.processor.ts`
- `apps/api/src/notifications/fleet/fleet-health.detector.ts`
- `apps/api/src/fleet/runners/enrollment-retention.processor.ts`
- `apps/api/test/integration/notifications/fleet-health-notifications.integration.spec.ts`

**US-005**
- `apps/api/src/permissions/system-role.seeder.ts`
- `apps/api/src/permissions/system-roles.ts`
- `apps/api/test/integration/permissions/system-roles.integration.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-webhooks.integration.spec.ts`

**US-002**
- `apps/api/test/integration/audit/audit-skills.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-preferences-watch-outbox.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-delivery-system.integration.spec.ts`

**US-005**
- `apps/api/test/integration/audit/audit-role-seeder.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/webhook/webhook.service.ts` — injects AuditRecorder as the last constructor parameter; create, update, remove and removeForProject run their repository write through this.audit.audited and record the contract's webhook.create, webhook.update or webhook.delete entry; the URL guard, the 404 checks, the generated secret and the return values are unchanged.
- `apps/api/src/webhook/webhook.service.spec.ts` — both direct new WebhookService(...) calls (the shared one and realGuardService) pass mockAuditRecorder (from global-stubs.module.ts) as the new last argument; the existing assertions are kept.
- `apps/api/src/webhook/webhook-routes.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } so the real WebhookService resolves; the existing assertions are kept.

**US-002**
- `apps/api/src/skills/skills.service.ts` — the constructor becomes (catalog, resolver, audit: AuditRecorder), dropping the txManager parameter; the txManager.run writes of createSource, updateSource (markResolveFailed and replaceSourceSkills) and deleteSource become this.audit.audited with the contract's entries ([] for a null or false answer), and enableProjectSkill and disableProjectSkill run their repository call through this.audit.audited; the conflict checks, the resolver handling, the errors and the return values are unchanged.
- `apps/api/src/skills/skills.service.spec.ts` — its direct new SkillsService(catalog, resolver, txManager) becomes new SkillsService(catalog, resolver, mockAuditRecorder) (from global-stubs.module.ts) and its now-unused txManager stub and ITransactionManager import are removed, and it gains the US-002 AC13 case; the existing assertions are kept.

**US-003**
- `apps/api/src/notifications/notification-preferences.service.ts` — injects AuditRecorder as the last constructor parameter; update runs its body inside this.audit.audited and records one notification.preference.update entry naming the supplied switches, none when nothing was supplied; the writes and their order are unchanged.
- `apps/api/src/notifications/notification-preferences.service.spec.ts` — its direct new NotificationPreferencesService(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/notifications/ticket-watch.service.ts` — injects AuditRecorder as the last constructor parameter; watch and unwatch run their repository write through this.audit.audited and record ticket.watch.set or ticket.watch.unset on the ticket; the ref resolution and the returned state are unchanged.
- `apps/api/src/notifications/ticket-watch.service.spec.ts` — its direct new TicketWatchService(repo) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/outbox/outbox-admin.service.ts` — injects AuditRecorder as the last constructor parameter; retry runs resetForRetry through this.audit.audited and records outbox.retry when it changed a row; the 404 and both 409 answers are unchanged.
- `apps/api/src/outbox/outbox-admin.service.spec.ts` — its direct new OutboxAdminService(repo) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/test/integration/outbox/outbox-relay.integration.spec.ts` — its direct new OutboxAdminService(module.get(PrismaOutboxRepository)) passes mockAuditRecorder as the new last argument; the existing assertions are kept.

**US-004**
- `apps/api/src/outbox/outbox-retention.processor.ts` — injects AuditRecorder as the last constructor parameter; the purge runs deleteTerminalBefore through this.audit.audited and records system.outbox.retention when it deleted rows; the days rule, the log lines and the swallowed failure are unchanged.
- `apps/api/src/outbox/outbox-retention.processor.spec.ts` — both of its testing modules' providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.
- `apps/api/src/outbox/outbox.module.spec.ts` — its FakePrismaModule's providers and exports gain { provide: AuditRecorder, useValue: mockAuditRecorder } so OutboxRetentionProcessor resolves; the existing assertions are kept.
- `apps/api/test/integration/outbox/outbox-relay.integration.spec.ts` — its testing module gains a @Global() fake module that provides and exports { provide: AuditRecorder, useValue: mockAuditRecorder }, as outbox.module.spec.ts's FakePrismaModule does, so the imported OutboxModule's OutboxRetentionProcessor resolves; the existing assertions are kept.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — its root-level { provide: AuditRecorder, useValue: mockAuditRecorder } is not visible to the imported OutboxModule, so the testing module gains a @Global() fake module that provides and exports it (replacing the root-level provider), so OutboxRetentionProcessor and TicketsService both resolve; the existing assertions are kept.
- `apps/api/src/notifications/notification-retention.processor.ts` — injects AuditRecorder as the last constructor parameter; each purge step runs its delete through this.audit.audited and records system.notification.retention when it deleted rows; the steps' order, the days rule, the log lines and the per-step swallowed failure are unchanged.
- `apps/api/src/notifications/notification-retention.processor.spec.ts` — its direct new NotificationRetentionProcessor(...) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/notifications/fleet/fleet-health.detector.ts` — injects AuditRecorder as the last constructor parameter; each open records system.health.detect inside its existing txManager.run after the outbox record, and the close runs repo.close through this.audit.audited and records when it closed rows; the plan, the boot grace and the returned counts are unchanged.
- `apps/api/src/notifications/fleet/fleet-health.detector.spec.ts` — both direct new FleetHealthDetector(...) calls pass mockAuditRecorder as the new last argument; the existing assertions are kept.

**US-005**
- `apps/api/src/permissions/system-role.seeder.ts` — injects AuditRecorder as the last constructor parameter; seedRole runs createRole and update through this.audit.audited and records role.manage with summary seeded or restored from seed, followed by fieldsSummary(patch); validation first, the patch rules and the log lines are unchanged.
- `apps/api/src/permissions/system-role.seeder.spec.ts` — every direct new SystemRoleSeeder(seeds, repo) passes mockAuditRecorder as the new last argument, and it gains the US-005 AC4 case; the existing assertions are kept.
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — ensureSystemRoles's direct new SystemRoleSeeder(SYSTEM_ROLES, roles) passes mockAuditRecorder (from global-stubs.module.ts) as the new last argument, so grantRole and every fixture that seeds roles keep compiling; its behaviour is unchanged.
- `apps/api/test/integration/permissions/system-roles.integration.spec.ts` — its direct new SystemRoleSeeder(SYSTEM_ROLES, roles) passes mockAuditRecorder as the new last argument; the existing assertions are kept.

### Seams

- No story calls a symbol another story creates; every story is independent.
- Every story's integration ACs enter through the real wiring of the booted `AppModule`: a route over HTTP (US-001 to US-003), the processors' cron entries `scheduledPurge()`, `FleetHealthDetector.detect(now)` (US-004), and `SystemRoleSeeder.onApplicationBootstrap()` taken from the booted app (US-005). Each asserts the stored `AuditEntry` row, so it proves the writer reaches the recorder rather than a stub.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database with `bootHttpApp({ registrationEnabled: false })`. `root` registers first and is the Owner; `dev` is created through `POST /api/admin/users` and added to the spec's project with role `developer`. Each HTTP spec creates its own project (US-001: slug `wh-audit`, key `WHA`; US-002: `sk-audit`, `SKA`; US-003: `nt-audit`, `NTA`) and reads `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. A webhook URL is an IP literal (`https://93.184.215.14/hook`, `https://93.184.215.15/hook`, refused: `https://10.0.0.5/hook`), as `webhook-routes.integration.spec.ts` uses, so the URL guard needs no DNS. A skill source body is `{ gitUrl: 'https://github.com/acme/skills', ref: 'main', path: <a per-AC path> }`, and the booted app's `SKILL_RESOLVER` `resolve` is spied as `skills-routes.integration.spec.ts` does, so GitHub is never called. `resetThrottle(app)` is called in `beforeEach`. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource (and key, where named) returns an empty array; "unchanged" compares a `count` taken before and after the call. "Spied to reject" means `vi.spyOn(app.get(AuditRecorder), 'record')` with an implementation that rejects with `new Error('audit down')` the first call whose `input.key` is the key the AC's writer records and delegates every other call to the original; the spy is restored after the AC. US-001 also creates a second project (slug `wh-other`, key `WHO`) with its own webhook for AC7, and every other US-001 AC creates the webhook it acts on. In US-003, `root` creates tickets `NTA-1` and `NTA-2` through `POST /api/projects/nt-audit/tickets` with no assignee and no mention of `dev`, so `dev` has no watcher row on either before an AC acts. US-002's `beforeEach` deletes every `projectSkill`, `skill` and `skillSource` row through `fixtureDb(app)`, as `skills-routes.integration.spec.ts` does; each US-002 AC creates the source it acts on through `POST /api/admin/skills/sources` with the `resolve` spy resolving `{ sha: 's1', skills: [{ name: 'audit-a', description: 'd', dir: 'skills/a' }] }` and path `skills/a` unless the AC names other values, so "a source resolved at `s1`" and "skill `audit-a`" name that AC's own fixture, and an AC that needs "an enabled skill" enables it with `PUT` first. A `fixtureDb(app)` outbox event names `type`, `eventId` (`evt-<n>`), `projectId`, `status` and, for US-004, `updatedAt`; a notification names `userId` (dev's id), `category` `ASSIGNED`, `kind` `ticket_assigned`, `title` `t`, `link` `/`, `sourceType` `ticket_event`, `sourceId` `s-<n>` and `readAt`; a health alert names `kind` `runner_offline`, `subjectKey` `old-<n>` and `closedAt`. US-004 sets `process.env.OUTBOX_RETENTION_DAYS` and `process.env.NOTIFICATION_RETENTION_DAYS` to `'30'` before boot (restored in `afterAll`); its old rows are 40 days old, and its `beforeEach` deletes every `auditEntry`, `outboxEvent`, `notification`, `fleetHealthAlert` and `runner` row through `fixtureDb(app)`, as `fleet-health-notifications.integration.spec.ts` does, so each AC sets up the rows it reads. US-005's `beforeEach` deletes every `auditEntry` row through `fixtureDb(app)` and restores the `viewer` role's seeded `name`, so the entries the boot's own seeding wrote on the fresh database are not counted.

### US-001: Webhook configuration writes are audited

1. [integration] `POST /api/projects/wh-audit/webhooks` as `root` with `{ url: 'https://93.184.215.14/hook', events: ['STATUS_CHANGE'], secret: 'Private-secret-1-0123456789abcdef' }` returns 201 and leaves one entry for the response's `id` with `key` `webhook.create`, `resourceType` `webhook`, `projectId` the project's id, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `created`.
2. [integration] The entry AC1 leaves has a `summary` that includes neither `Private-secret-1-0123456789abcdef` nor `93.184.215.14`.
3. [integration] `POST /api/projects/wh-audit/webhooks` with `url` `https://10.0.0.5/hook` returns 400 and the count of `webhook.create` entries is unchanged.
4. [integration] `POST /api/projects/wh-audit/webhooks` with `url` `https://93.184.215.15/hook`, while `record` is spied to reject, returns an error status and the project has no webhook with that `url`.
5. [integration] `PATCH /api/projects/wh-audit/webhooks/:id` as `root` with `{ secret: 'Private-secret-2-0123456789abcdef', active: false }` returns 200 and leaves one entry for that id with `key` `webhook.update` and `summary` `fields: active, secret`.
6. [integration] `PATCH /api/projects/wh-audit/webhooks/:id` with `{ active: false }`, while `record` is spied to reject, returns an error status and the webhook's `active` is still `true`.
7. [integration] `PATCH /api/projects/wh-audit/webhooks/:id` with the id of a webhook of another project returns 404 and leaves no `webhook.update` entry for that id.
8. [integration] `DELETE /api/projects/wh-audit/webhooks/:id` as `root` returns 204 and leaves one entry for that id with `key` `webhook.delete`, `projectId` the project's id and `summary` `deleted`.
9. [integration] `DELETE /api/webhooks/:id` as `root` returns 204 and leaves one `webhook.delete` entry for that id whose `projectId` is the id of the project the webhook belonged to.
10. [integration] `DELETE /api/projects/wh-audit/webhooks/:id`, while `record` is spied to reject, returns an error status and the webhook still exists.
11. [integration] `DELETE /api/webhooks/missing-webhook` as `root` returns 404 and leaves no entry for `missing-webhook`.
12. [integration] `PATCH /api/projects/wh-audit/webhooks/:id` as `root` with `{}` returns 200 and leaves one entry for that id with `key` `webhook.update` and `summary` `null`.

### US-002: Skill writes are audited

1. [integration] `POST /api/admin/skills/sources` as `root` with path `skills/a`, `resolve` resolving `{ sha: 's1', skills: [{ name: 'audit-a', description: 'd', dir: 'skills/a' }] }`, returns 201 and leaves one entry for the response's `id` with `key` `skill.source.create`, `resourceType` `skill-source`, `projectId` `null`, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `created, status OK, skills 1`.
2. [integration] `POST /api/admin/skills/sources` with path `skills/b`, `resolve` rejecting with `new SkillResolveError('rate_limited')`, returns 201 with `status` `RESOLVE_FAILED` and leaves one entry for the response's `id` with `summary` `created, status RESOLVE_FAILED, skills 0`.
3. [integration] A second `POST /api/admin/skills/sources` with AC1's `gitUrl`, `ref` and `path` returns 409 and the count of `skill.source.create` entries is unchanged.
4. [integration] `POST /api/admin/skills/sources` with path `skills/c`, while `record` is spied to reject, returns an error status and no `skillSource` row has path `skills/c`.
5. [integration] `POST /api/admin/skills/sources/:id/update` as `root` on its own source created as AC1 creates it, `resolve` resolving `{ sha: 's2', skills: [{ name: 'audit-a', description: 'd', dir: 'skills/a' }, { name: 'audit-a2', description: 'd', dir: 'skills/a2' }] }`, returns 200 and leaves one entry for that id with `key` `skill.source.update` and `summary` `updated, status OK, skills 2`.
6. [integration] `POST /api/admin/skills/sources/:id/update` on a source, `resolve` rejecting with `new SkillResolveError('ref_not_found')`, returns 200 with `status` `RESOLVE_FAILED` and leaves a `skill.source.update` entry for that id whose `summary` starts with `updated, status RESOLVE_FAILED`.
7. [integration] `POST /api/admin/skills/sources/:id/update` on a source resolved at `s1`, `resolve` resolving `s3`, while `record` is spied to reject, returns an error status and the source's `resolvedSha` is still `s1`.
8. [integration] `DELETE /api/admin/skills/sources/:id` as `root` returns 204 and leaves one entry for that id with `key` `skill.source.delete` and `summary` `deleted`.
9. [integration] `DELETE /api/admin/skills/sources/missing-source` returns 404 and leaves no entry for `missing-source`.
10. [integration] `PUT /api/projects/sk-audit/skills/:skillId` as `root` with the id of skill `audit-a` returns 200 and leaves one entry for that skill id with `key` `skill.project.enable`, `resourceType` `skill`, `projectId` the project's id and `summary` `enabled`.
11. [integration] `DELETE /api/projects/sk-audit/skills/:skillId` as `root` on an enabled skill returns 204 and leaves one entry for that skill id with `key` `skill.project.disable` and `summary` `disabled`.
12. [integration] `PUT /api/projects/sk-audit/skills/missing-skill` returns 404 and leaves no entry for `missing-skill`.
13. [unit] `SkillsService.enableProjectSkill` with a stub catalog whose `enableProjectSkill` resolves `null` and a stub recorder whose `audited` calls its `fn` and then calls `entriesOf` with the result throws `NotFoundAppException`, and the recorder's `record` is never called.
14. [integration] `PUT /api/projects/sk-audit/skills/:skillId`, while `record` is spied to reject, returns an error status and no `projectSkill` row exists for that project and skill.
15. [integration] `DELETE /api/admin/skills/sources/:id`, while `record` is spied to reject, returns an error status and the source still exists.

### US-003: Preferences, ticket watch and outbox retry are audited

1. [integration] `PUT /api/me/notification-preferences` as `dev` with `{ items: [{ category: 'MENTIONED', email: false }, { category: 'ASSIGNED', inApp: false }] }` returns 200 and leaves one entry for dev's id with `key` `notification.preference.update`, `resourceType` `user`, `projectId` `null`, `actorId` dev's id, `origin` `rest` and `summary` `fields: ASSIGNED.inApp, MENTIONED.email`.
2. [integration] `PUT /api/me/notification-preferences` as `dev` with `{ emailEnabled: false }` leaves an entry for dev's id with `key` `notification.preference.update` and `summary` `fields: emailEnabled`.
3. [integration] `PUT /api/me/notification-preferences` as `dev` with `{}` returns 200 and the count of `notification.preference.update` entries for dev's id is unchanged.
4. [integration] `PUT /api/me/notification-preferences` as `dev` with `{ items: [{ category: 'WATCHED_ACTIVITY', inApp: false }] }`, while `record` is spied to reject, returns an error status, and `GET /api/me/notification-preferences` still answers `inApp` `true` for `WATCHED_ACTIVITY`.
5. [integration] `PUT /api/projects/nt-audit/tickets/NTA-1/watch` as `dev` returns 200 and leaves one entry for the ticket's id with `key` `ticket.watch.set`, `resourceType` `ticket`, `projectId` the project's id, `actorId` dev's id and `summary` `watching`.
6. [integration] `DELETE /api/projects/nt-audit/tickets/NTA-1/watch` as `dev` returns 200 and leaves one entry for the ticket's id with `key` `ticket.watch.unset` and `summary` `muted`.
7. [integration] `PUT /api/projects/nt-audit/tickets/NTA-999/watch` returns 404 and the count of `ticket.watch.set` entries is unchanged.
8. [integration] `PUT /api/projects/nt-audit/tickets/NTA-2/watch` as `dev` on a ticket dev does not watch, while `record` is spied to reject, returns an error status, and `GET /api/projects/nt-audit/tickets/NTA-2/watch` as `dev` answers `watching` `false`.
9. [integration] `POST /api/admin/outbox/:eventId/retry` as `root` on an outbox event created through `fixtureDb(app)` with `type` `ticket_event`, `projectId` the project's id and `status` `dead` returns 200 and leaves one entry for the event's id with `key` `outbox.retry`, `resourceType` `outbox-event`, `projectId` the project's id, `actorId` root's id and `summary` `retried ticket_event, was dead`.
10. [integration] `POST /api/admin/outbox/:eventId/retry` on an event with `status` `published` returns 409 and leaves no entry for that event's id.
11. [integration] `POST /api/admin/outbox/:eventId/retry` on a `dead` event, while `record` is spied to reject, returns an error status and the event's `status` is still `dead`.
12. [integration] `POST /api/me/notifications/read-all` as `dev`, with one unread notification of dev's created through `fixtureDb(app)`, returns 204 and the count of entries whose `actorId` is dev's id is unchanged.
13. [integration] `POST /api/admin/outbox/missing-event/retry` as `root` returns 404 and leaves no entry for `missing-event`.
14. [integration] `PUT /api/me/notification-preferences` as `dev` with `{ emailEnabled: true, items: [{ category: 'MENTIONED', email: true }] }` leaves an entry for dev's id with `summary` `fields: MENTIONED.email, emailEnabled`.
15. [unit] `OutboxAdminService.retry('e-1')` with a stub repository whose `findById` resolves an event with `status` `dead` and whose `resetForRetry` resolves `0`, and a stub recorder whose `audited` calls its `fn` and then calls `entriesOf` with the result, throws an `HttpException` with status 409, and the recorder's `record` is never called.

### US-004: Retention purges and fleet health episodes are audited

1. [integration] `app.get(OutboxRetentionProcessor).scheduledPurge()`, with two `published` outbox events whose `updatedAt` is 40 days ago, leaves one entry for `all` with `key` `system.outbox.retention`, `resourceType` `outbox-event`, `projectId` `null`, `actorType` `SYSTEM`, `actorId` `outbox`, `origin` `system` and `summary` `purged 2 terminal events`.
2. [integration] `app.get(OutboxRetentionProcessor).scheduledPurge()` with no terminal outbox event older than 30 days resolves and the count of `system.outbox.retention` entries is unchanged.
3. [integration] `app.get(OutboxRetentionProcessor).scheduledPurge()`, with one `dead` outbox event whose `updatedAt` is 40 days ago, while `record` is spied to reject, resolves and that event still exists.
4. [integration] `app.get(NotificationRetentionProcessor).scheduledPurge()`, with one notification of dev's whose `readAt` is 40 days ago, leaves one entry with `key` `system.notification.retention`, `resourceType` `notification`, `resourceId` `all`, `actorType` `SYSTEM`, `actorId` `notification` and `summary` `purged 1 read notifications`.
5. [integration] `app.get(NotificationRetentionProcessor).scheduledPurge()`, with one fleet health alert whose `closedAt` is 40 days ago, leaves one entry with `key` `system.notification.retention`, `resourceType` `fleet-health-alert`, `resourceId` `all` and `summary` `purged 1 closed health alerts`.
6. [integration] `app.get(NotificationRetentionProcessor).scheduledPurge()`, with one notification read 40 days ago and one health alert closed 40 days ago, while `record` is spied to reject, resolves, the notification still exists, and the health alert is gone.
7. [integration] `app.get(FleetHealthDetector).detect(now)`, with `now` past the boot grace and one enabled runner whose `lastSeenAt` is older than `runnerOfflineSec`, opens one `runner_offline` episode and leaves one entry for that alert's id with `key` `system.health.detect`, `resourceType` `fleet-health-alert`, `projectId` `null`, `actorType` `SYSTEM`, `actorId` `health`, `origin` `system` and `summary` `opened runner_offline`.
8. [integration] A second `detect(now)` with the same runner still offline leaves the count of `system.health.detect` entries unchanged.
9. [integration] `detect(now)` with an offline runner, while `record` is spied to reject, rejects, leaves no open `FleetHealthAlert` for that runner, and leaves no `fleet_health_alert` outbox event for it.
10. [integration] A `detect(now)` that opens a `runner_offline` episode for an offline runner, followed by a second `detect(now)` after that runner's `lastSeenAt` is set to `now`, closes the episode and leaves one entry for `all` with `key` `system.health.detect` and `summary` `closed 1`.
11. [integration] `detect(now)` with every runner online and no open episode leaves the count of `system.health.detect` entries unchanged.

### US-005: The system role seeder is audited

1. [integration] `app.get(SystemRoleSeeder).onApplicationBootstrap()`, after the `viewer` role's `name` is set to `Renamed viewer` through `fixtureDb(app)` (with the audit entries cleared in `beforeEach`), leaves one entry for the `viewer` role's id with `key` `role.manage`, `resourceType` `role`, `projectId` `null`, `actorType` `SYSTEM`, `actorId` `seed`, `origin` `system` and `summary` `restored from seed, fields: name, scope`.
2. [integration] A second `app.get(SystemRoleSeeder).onApplicationBootstrap()` with no role changed leaves the count of `role.manage` entries with `actorId` `seed` unchanged.
3. [integration] `app.get(SystemRoleSeeder).onApplicationBootstrap()`, after the `viewer` role's `name` is set to `Renamed again` through `fixtureDb(app)`, while `record` is spied to reject, rejects, and the `viewer` role's `name` is still `Renamed again`.
4. [unit] `new SystemRoleSeeder([seed 'audit-role'], repo, recorder).onApplicationBootstrap()`, with a stub repository whose `findOne` resolves `null` and whose `createRole` resolves a role with id `r-1`, and a stub recorder whose `audited` calls its `fn` and then records the entries `entriesOf` returns, calls the recorder's `record` once with `key` `role.manage`, `resourceType` `role`, `resourceId` `r-1`, `projectId` `null` and `summary` `seeded`.
5. [integration] `app.get(SystemRoleSeeder).onApplicationBootstrap()`, after the `owner` role's `name` is set to `Renamed owner` through `fixtureDb(app)`, leaves one entry for the `owner` role's id with `key` `role.manage`, `actorId` `seed` and `summary` `restored from seed, fields: name, permissions, scope`.
