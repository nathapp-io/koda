# Fleet S4a — Notifications Core (In-App) — Design

Builds the first part of fleet phase S4 (design doc §5: membership admin UIs, notifications; items g, h). S3 closed
with C14 (design doc §9.36). The user re-scoped S4 as "team-ready koda" (2026-10-08) and split it:

- **S4a (this spec): in-app notifications core.** Inbox, ticket watchers, @mentions, fleet producers, preferences.
- S4b: email delivery (`@nathapp/nestjs-notification`, SMTP) driven by S4a preferences; invite-by-email.
- S4c: team access polish (per-project agents #61, disabled-user member guard, members UI polish).

## Goal

A koda user learns about work that concerns them without watching the page. Ticket assignments, @mentions, activity
on tickets they watch, fleet jobs they requested, approval asks and fleet health problems land as rows in a
per-user inbox, show live on a bell in the web header, and can be read from the CLI. Each user controls which
categories they receive and which tickets they watch.

## Success criteria

1. Assigning a ticket to user B creates one `ASSIGNED` notification for B; B's bell count rises live without a
   reload; clicking it marks it read and opens the ticket.
2. A comment on a ticket notifies every unmuted watcher except the commenter, once each, even when the outbox
   redelivers the event.
3. `@[Name](user:<id>)` in a comment or description notifies that user (if a project member) as `MENTIONED` and
   makes them a watcher; a muted watcher still receives direct mentions and assignments.
4. A fleet job the user requested ending ESCALATED, FAILED or CRASHED, or COMPLETED with a PR, notifies the
   requester.
5. A bash approval ask notifies every global admin, whether or not anyone is watching the project live.
6. A budget warn or hard-stop incident, a runner going offline, and an OAuth credential entering the expiry window
   each notify every global admin exactly once per episode.
7. Turning a category off in preferences stops new notifications of that category for that user.
8. User A can never list, count, read or mark user B's notifications.

## Rulings (user, 2026-10-08)

- S4-1: S4 means "team-ready koda"; split into S4a/S4b/S4c, S4a first.
- S4-2: v1 event set = ticket assigned/mentioned, ticket activity on watched tickets, fleet "needs you", fleet ops
  health.
- S4-3: explicit watchers (`TicketWatcher`), auto-added and user-controllable.
- S4-4: per-category preference toggles, stored per channel so S4b adds email without a migration of meaning.
- S4-5: outbox-driven producers (approach A). #236's no-live-listener gate moves out of the enqueue: approval asks
  always reach the inbox; live-listener suppression becomes an S4b email rule.
- S4-6: @mention = stable token `@[Display Name](user:<id>)` inserted by a web autocomplete.

## Ground truth (verified on main `81083c1f`)

- Outbox: `@nathapp/nestjs-outbox` `OutboxService.record({ type, payload, metadata })` inside the ambient
  transaction (`comments.service.ts:100`, `tickets.service.ts:67`). `FanOutPublisher.register(type, handler)` runs
  every handler per record and retries the whole record if any throws (`outbox/fan-out-publisher.ts`), so handlers
  must be idempotent.
- Ticket activity reaches the outbox as `ticket_event` (`buildTicketEventOutboxPayload`: `id, action, ticketId,
  projectId, actorId, actorType, data`). Actions and `data`: `TICKET_CREATED` `{type, title}`
  (`tickets.service.ts:124`); `TICKET_UPDATED` = the changed fields (`:267`); `assigned` `{assignedTo}` = user
  **or** agent id with no type marker (`:368`); `status_changed` `{fromStatus, newStatus}` and `COMMENT_ADDED`
  `{commentId}` (`ticket-transitions.service.ts:100,126`, `comments.service.ts:100`); `TICKET_DELETED`.
  `TicketLiveSubscriber` is the precedent consumer.
- Live: `ProjectEventBus` (in-process, single API instance), `createLiveStream` (heartbeat, token expiry,
  `stillAllowed`), `LiveStreamRegistry` (per-user stream cap), `GET /projects/:slug/events`
  (`live/live.controller.ts`), web `useProjectEvents`.
- No watcher, subscription, mention or notification model exists. `User` has `email`, `name`, `role`
  (`MEMBER | ADMIN`), `disabled`; no handle.
- Fleet: approvals, runners and budgets are global-ADMIN routes (`@RequiredPermission('ADMIN')`). `FleetJob` has
  `projectId` and `requestedById`. Terminal job effects run after commit from `SyncService.afterTerminal`
  (`sync.service.ts:138`) and `FleetSweeper` (`fleet-sweeper.ts:63`) via `FleetJobTicketEffects.onTerminal`.
- Budgets: `BudgetEvaluator.evaluate` inserts deduplicated `warn` / `hard_stop` incidents under the policy row lock
  (`repo.insertIncident` returns whether a row was inserted).
- Runner liveness: `isRunnerOnline(lastSeenAt, now, runnerOfflineSec)` (`fleet/common/runner-online.ts`,
  `FLEET_RUNNER_OFFLINE_SEC` default 90). Credential expiry: `isExpiring(cred, now, warnDays)`
  (`fleet/dashboard/credential-board.ts:23`, `FLEET_CREDENTIAL_EXPIRY_WARN_DAYS` default 7).
- PR #236 MERGED (`d9a23c16`): `ApprovalCloser.enqueueRequested` records `fleet_approval_requested` (payload
  `approvalWebhookPayload(approval, slug)`, metadata `{ projectId, eventId: approval.id }`) for **every** fresh
  project ask in the caller's transaction (the live-listener gate was dropped before merge); asks without a
  `projectId` are not enqueued. No consumer exists.
- Web: `layouts/default.vue` hosts `FleetApprovalBadge`; `useApprovalNotifications` gives a polling toast/browser
  notification for approval asks; `MarkdownEditor.vue` and `CommentThread.vue` are the text inputs.
- Retention precedent: `OutboxRetentionProcessor` `@Cron('0 4 * * *')`.

## Out of scope

- Email, push, chat or webhook delivery of notifications (S4b). Invites (S4b).
- Digests, batching, quiet hours, per-project mute.
- Notifications for agents (agent recipients are skipped).
- Multi-instance fan-out (the live buses stay in-process, as today).
- Replacing the approval toast (`useApprovalNotifications` stays).

## 1. Data

One migration `<ts>_notifications_core` (slice 1) and one `<ts>_fleet_health_alerts` (slice 4).

```prisma
model Notification {
  id         String    @id @default(cuid())
  userId     String
  projectId  String?   // null for global fleet health
  category   String    // ASSIGNED | MENTIONED | WATCHED_ACTIVITY | FLEET_NEEDS_YOU | FLEET_HEALTH
  kind       String    // e.g. ticket_assigned, ticket_comment, job_escalated, approval_requested, runner_offline
  title      String    // English fallback (CLI, API consumers)
  body       String?
  params     Json      @default("{}") // kind-specific values for web i18n rendering
  link       String    // in-app path, e.g. /koda/tickets/KODA-12
  sourceType String    // ticket_event | fleet_job | fleet_approval | fleet_budget_incident | fleet_health_alert
  sourceId   String
  actorId    String?
  readAt     DateTime?
  createdAt  DateTime  @default(now())

  user    User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  project Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([userId, sourceType, sourceId, kind])
  @@index([userId, readAt, createdAt])
  @@index([userId, createdAt])
}

model TicketWatcher {
  ticketId  String
  userId    String
  reason    String   // REPORTER | ASSIGNEE | COMMENTER | MENTIONED | MANUAL
  muted     Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  ticket Ticket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([ticketId, userId])
  @@index([userId])
}

model NotificationPreference {
  userId   String
  category String
  channel  String  // IN_APP (S4a); EMAIL added by S4b
  enabled  Boolean

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, category, channel])
}

model FleetHealthAlert {          // slice 4
  id         String    @id @default(cuid())
  kind       String    // runner_offline | credential_expiring
  subjectKey String    // runnerId, or runnerId:providerId
  openedAt   DateTime  @default(now())
  closedAt   DateTime?

  @@index([kind, subjectKey, closedAt])
}
```

- `title`/`body` are rendered in English at production time (CLI fallback); the web renders from `kind` + `params`
  through its own i18n (`notifications.kinds.<kind>`), falling back to `title`. Neither stores secrets or command
  content. Approval asks read
  "Approval needed: bash on <owner/repo>" with no command text.
- Auto-watch never un-mutes: an existing row keeps `muted`; auto-add uses insert-if-absent.
- Backfill (slice 1 migration SQL): one watcher row per existing ticket for the reporter (`REPORTER`), the user
  assignee (`ASSIGNEE`), and each distinct user commenter (`COMMENTER`); deleted tickets skipped.
- A missing preference row means enabled. Unknown categories are rejected by the DTO.
- Retention: `NotificationRetentionProcessor` `@Cron('30 4 * * *')` deletes read rows older than
  `NOTIFICATION_RETENTION_DAYS` (default 90); unread rows are kept. `FleetHealthAlert` rows closed for more than 30
  days are deleted by the same job.

## 2. Producers

### 2.1 Shared pipeline (`apps/api/src/notifications/`)

`NotificationWriter.deliver(drafts)` is the only writer:

1. Drop drafts whose recipient is the actor, a disabled user, or (for project-scoped drafts) not a project member
   and not a global ADMIN.
2. Drop drafts whose `(user, category, IN_APP)` preference is disabled.
3. `createMany({ skipDuplicates: true })` on the unique key.
4. For each inserted row, `UserEventBus.publish({ userId, type: 'notification', id })` after the write.

Producers are `FanOutPublisher` handlers. They throw only on database failure (so the outbox retries; the unique key
absorbs repeats) and log and skip malformed payloads.

### 2.2 Tickets (`TicketNotificationSubscriber`, on `ticket_event`)

Watchers are upserted first, in the same handler, then recipients resolved.

| Action | Auto-watch | Notify |
|---|---|---|
| `TICKET_CREATED` | reporter (`REPORTER`); mentioned users in the description (`MENTIONED`) | mentioned → `MENTIONED` |
| `assigned` (user assignee) | assignee (`ASSIGNEE`) | assignee → `ASSIGNED` (ignores `muted`) |
| `COMMENT_ADDED` | commenter (`COMMENTER`); mentioned (`MENTIONED`) | mentioned → `MENTIONED` (ignores `muted`); other unmuted watchers → `WATCHED_ACTIVITY` |
| `status_changed` | — | unmuted watchers → `WATCHED_ACTIVITY` |
| `TICKET_UPDATED` with a changed description | newly mentioned (`MENTIONED`) | newly mentioned → `MENTIONED` |

- The `assigned` event gains `data.assigneeType: 'user' | 'agent'` (slice 1) so the producer never guesses; events
  recorded before the change are resolved by looking the id up in `User`.
- `COMMENT_ADDED` carries only `commentId`; the producer loads the comment author and body.
- A user who gets `MENTIONED` or `ASSIGNED` for an event does not also get `WATCHED_ACTIVITY` for the same event.
- `sourceId` is the `TicketEvent` id. "Newly mentioned" on update compares against the previous description, which
  the event payload must carry (`data.previousDescription` is added where description updates record the event;
  slice 3).
- Agent actors and agent assignees are never recipients.

### 2.3 @mentions (slice 3)

- Token grammar: `@[<label>](user:<cuid>)`; label is display-only. `parseMentions(text)` returns distinct user ids,
  capped at 20 per text; anything else (including plain `@name`) is plain text.
- Ids that are not project members (and not global ADMIN) are ignored.
- Markdown rendering turns tokens into a chip showing the user's current name (fallback: the label).

### 2.4 Fleet (slice 4)

| Event type | Enqueued at | Recipients → category |
|---|---|---|
| `fleet_job_outcome` | inside `JobTransitionsService.apply`, the caller's transaction (D513), for ESCALATED, FAILED, CRASHED, and COMPLETED with `resultPrUrl`; also when ingest later fills `resultPrUrl` | `requestedById` → `FLEET_NEEDS_YOU` |
| `fleet_approval_requested` | already enqueued by `ApprovalCloser.enqueueRequested` (#236); S4a adds only the consumer | global admins → `FLEET_NEEDS_YOU` |
| `fleet_budget_incident` | inside `BudgetEvaluator.evaluate` when `insertIncident` inserted a `warn` or `hard_stop` row | global admins → `FLEET_HEALTH` |
| `fleet_health_alert` | `FleetHealthDetector` when it opens an alert | global admins → `FLEET_HEALTH` |

- `fleet_job_outcome` `sourceId` is `<jobId>:<leaseEpoch>` and `kind` the outcome (`job_escalated`, `job_failed`,
  `job_crashed`, `job_pr_opened`), so a requeued job that fails again on a new lease notifies again, and a repeat of
  the same attempt does not.
- Terminal effects run after commit today (`afterTerminal`, sweeper). The plan must locate the transactions that
  write each terminal state and enqueue there; if a path has no enclosing transaction, enqueue from the existing
  after-commit hook and rely on the sweeper re-run plus the unique key (same guarantee as C9 failure comments).
- `FleetHealthDetector`: every 60 s (D515; disabled when `FLEET_SWEEP_ENABLED=false`; skips offline checks for the first `runnerOfflineSec` after boot). Per runner, an offline
  runner with no open `runner_offline` alert opens one and enqueues; an online runner closes its open alert.
  Per available runner credential, `isExpiring(cred, now, credentialExpiryWarnDays)` opens a `credential_expiring`
  alert keyed `runnerId:providerId`; leaving the window (refreshed or removed) closes it. Open + enqueue run in one
  transaction.

## 3. API

All `/me/*` routes: user principals only (agents 403), scoped to `principal.id`; never accept a user id.

| Route | Purpose |
|---|---|
| `GET /me/notifications?unread=true&current=&size=` | koda `Page<NotificationDto>` (`{ total, current, size, hasNext, hasPrev, records }`), newest first |
| `GET /me/notifications/unread-count` | `{ count }` |
| `POST /me/notifications/:id/read` | 204; 404 if not the caller's |
| `POST /me/notifications/read-all` | 204 |
| `GET /me/notification-preferences` | all five categories with effective `inApp` value |
| `PUT /me/notification-preferences` | `{ category, inApp }[]`; upserts IN_APP rows |
| `PUT /projects/:slug/tickets/:ref/watch` | watch (un-mute or insert `MANUAL`); membership-gated |
| `DELETE /projects/:slug/tickets/:ref/watch` | mute (insert muted row if absent) |
| `GET /projects/:slug/tickets/:ref/watchers` | `{ watching: boolean, count }` for the caller |

CLI: `koda notifications [--unread] [--json]`, `koda notifications read <id> | --all`,
`koda ticket watch <ref>`, `koda ticket unwatch <ref>`.

## 4. Live

- `UserEventBus`: same shape as `ProjectEventBus`, keyed by user id; `publish` never throws.
- `GET /me/events` (`MeLiveController`, `@Sse`, `@SkipThrottle`, excluded from openapi): user principals only;
  `createLiveStream` with `stillAllowed` = not revoked and not disabled; shares `LiveStreamRegistry` and
  `LIVE_MAX_STREAMS_PER_USER` with project streams.
- Events are content-free: `{ type: 'notification', id }`. Clients refetch.
- Nitro proxy `server/api/me/events.get.ts`, abort-aware, mirroring the project events proxy.

## 5. Web

- `NotificationBell` in `layouts/default.vue` beside `FleetApprovalBadge`: unread badge (99+ cap); dropdown shows
  the latest 10; clicking an item marks it read then navigates to `link`; "Mark all read"; "View all".
- `useUserEvents` composable (one stream per tab) drives a silent refetch of the count and any open list; falls back
  to `useVisiblePolling` (60 s) if the stream fails.
- `/notifications` page: paginated list, unread filter, mark read / mark all.
- `/settings/notifications` page: five toggles with descriptions.
- Ticket detail: Watch/Unwatch button and watcher count.
- `MarkdownEditor` (comment and description): typing `@` opens a member picker (`useProjectMembers`); choosing
  inserts the token. Markdown rendering shows tokens as chips.
- i18n keys for all new strings.

## 6. Errors and edge cases

- Lost membership stops new notifications (checked at production); old rows remain and their links 403 normally.
- Deleted ticket: its notifications remain until retention; the link lands on the existing not-found view.
- A disabled user receives nothing; re-enabled users resume with no backfill.
- Preference read failure in a handler throws (retry), never defaults silently to "on".
- `UserEventBus` publish happens after the insert; a dropped live event only delays the badge until the next
  refetch or poll.

## 7. Slices

| Slice | Contents | Migration |
|---|---|---|
| 1 | `Notification`, `TicketWatcher` (+ backfill), `NotificationPreference`; `NotificationWriter`; ticket subscriber (assign, comment, status, create); `/me/notifications*`, preferences, watch API; `UserEventBus` + `/me/events`; CLI; retention | yes |
| 2 | Web: bell, `useUserEvents` + proxy, `/notifications`, `/settings/notifications`, Watch button | no |
| 3 | Mentions: parser, `previousDescription` on description updates, `MENTIONED` producer, web picker + chip render | no |
| 4 | Fleet: `fleet_job_outcome`, `fleet_approval_requested` consumer, `fleet_budget_incident`, `FleetHealthAlert` + `FleetHealthDetector` | yes |

Slices 3 and 4 depend on slice 1 only.

## 8. Testing

- Unit: each producer's recipient table (actor excluded, disabled, non-member, muted watcher with mention/assign,
  preference off, agent skipped, no double category per event); `parseMentions`; `FleetHealthDetector` episode
  open/close; `UserEventBus`; `NotificationWriter` ordering (insert before publish).
- Integration (`KODA_DB_TESTS=1`): outbox redelivery creates no duplicate rows; watcher backfill SQL; `/me/*`
  isolation matrix (A cannot read, count or mark B's rows; agents 403); watch routes membership-gated; preference
  off suppresses; budget incident enqueue inside the evaluate transaction.
- Web: component specs for bell, list page, preferences, watch button, mention picker and chip.
- E2E: A assigns a ticket to B; B's bell rises live; B clicks; item read; ticket opens.
- Live check on koda-wk after slice 4: a real bash approval ask and a job escalation appear in the admin inbox;
  stopping the runner raises exactly one offline alert; restarting closes it and a second stop raises a new one.

## 9. Delivery

One spec, one plan, four PRs (one per slice). Design doc §9.x status note after each merge; koda-wk deploy and the
live check after slice 4 (human-run).

## Decisions

| # | Decision |
|---|---|
| D499 | S4 is split S4a (in-app core) / S4b (email + invites) / S4c (team access); S4a first. |
| D500 | Producers are outbox fan-out handlers; domain services only enqueue events. |
| D501 | `Notification` is unique on `(userId, sourceType, sourceId, kind)`; idempotency comes from `createMany skipDuplicates`, not from handler state. |
| D502 | Watchers are explicit rows; unwatch is a sticky `muted` flag; assignment and mentions ignore `muted`. |
| D503 | Preferences are `(user, category, channel)` rows defaulting to enabled; S4a writes `IN_APP` only. |
| D504 | Mentions are `@[label](user:<id>)` tokens; plain `@name` is never parsed. |
| D505 | Fleet notifications go to global admins (approvals, health) and to the job requester (outcomes), matching the ADMIN-only fleet surfaces. |
| D506 | Approval asks are always enqueued (as merged in #236); suppressing external delivery when someone watches live is an S4b rule. Project-less asks are out of scope. |
| D507 | Runner-offline and credential-expiring alerts are episodes in `FleetHealthAlert`, opened and closed by a 60 s detector; one notification per opened episode. |
| D508 | Budget notifications ride on the evaluator's existing deduplicated incidents. |
| D509 | The user live stream is content-free and refetch-driven, sharing the per-user stream cap with project streams. |
| D510 | Notification text carries no secrets or command content; agents never receive notifications. |
| D511 | Read notifications are purged after 90 days; unread are kept. |
| D512 | `OutboxEvent.projectId` becomes nullable; `PrismaOutboxStore.save` accepts a missing `metadata.projectId` only for `GLOBAL_OUTBOX_TYPES` = `fleet_budget_incident`, `fleet_health_alert` (both are global; the column was NOT NULL with an FK). |
| D513 | `fleet_job_outcome` is enqueued by `FleetJobOutcomeRecorder` inside `JobTransitionsService.apply` (every terminal transition, caller's transaction) and inside the ingest correction transaction (late ESCALATED, late PR url); no after-commit fallback is needed. |
| D514 | The approval consumer notifies only asks still `pending` when the handler runs, so the backlog enqueued since #236 does not flood admins. |
| D515 | The health detector runs every 60 s from `onModuleInit` (the `FleetSweeper` `setInterval` pattern) when `FLEET_SWEEP_ENABLED`; a disabled runner never has an offline alert; unreadable capabilities hold (never close) that runner's credential alerts. |
