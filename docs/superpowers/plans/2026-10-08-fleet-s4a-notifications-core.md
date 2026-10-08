# Fleet S4a — Notifications Core (In-App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every koda user a per-user in-app inbox (live bell, inbox page, CLI) fed by ticket assignment, @mentions, activity on watched tickets, fleet job outcomes, approval asks and fleet health alerts, with per-category preferences and per-ticket watch control.

**Architecture:** Domain services only enqueue outbox events (tickets already do; fleet gains three new types). Outbox fan-out handlers in a new `apps/api/src/notifications/` module resolve recipients (watchers, admins, requester), filter by eligibility and preference, insert `Notification` rows idempotently (unique per user/source/kind) and push a content-free event to an in-process `UserEventBus`, which feeds a per-user SSE stream `/me/events`. The web refetches on each event.

**Tech Stack:** NestJS 11 + Fastify + Prisma 6 (PostgreSQL 16), `@nathapp/nestjs-outbox`, `@nestjs/schedule`, Nuxt 3 + shadcn-nuxt, Commander CLI (generated client), Jest / Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-fleet-s4a-notifications-core-design.md` (decisions D499-D511).

**Delivery:** four PRs, each cut from `main` only after the previous one merged (no stacking). Order A → B, then C and D in either order (C needs only A; D needs B's web copy for its kind guard):
- **PR 1 — Part A** (`feat/fleet-s4a-1-notifications-core`; rename the current `docs/fleet-s4a-spec` branch, which carries the spec and this plan): Tasks A0-A12. Slice 1.
- **PR 2 — Part B** (`feat/fleet-s4a-2-inbox-web`): Tasks B0-B8. Slice 2.
- **PR 3 — Part C** (`feat/fleet-s4a-3-mentions`): Tasks C0-C7. Slice 3.
- **PR 4 — Part D** (`feat/fleet-s4a-4-fleet-producers`): Tasks D0-D9, then D10 (human-run koda-wk deploy + live check after merge). Slice 4.

Pushing a branch and opening a PR happen only with the user's go-ahead at that moment (each part's last task says so).

After each PR merges, append a §9.x status note (PR number, merge sha, what landed, what is next) to the fleet design doc
`projects/koda/koda-fleet-platform-design-2026-09-13.md` (in the workspace repo, outside this repo) and commit it there.

## Global Constraints

- No Prisma enums (repo rule): categories, kinds, reasons, channels and source types are strings validated in code.
- Categories exactly: `ASSIGNED`, `MENTIONED`, `WATCHED_ACTIVITY`, `FLEET_NEEDS_YOU`, `FLEET_HEALTH`. Channels: `IN_APP` only in S4a.
- `Notification` is unique on `(userId, sourceType, sourceId, kind)`; inserts use `createManyAndReturn({ skipDuplicates: true })`; handlers are idempotent and throw only on database failure.
- Never notify: the actor, a disabled user, an agent, or (for project-scoped drafts) a user who is neither a project member nor a global ADMIN.
- Assignment (`ASSIGNED`) and mentions (`MENTIONED`) ignore `TicketWatcher.muted`; `WATCHED_ACTIVITY` respects it. One notification per user per source event (priority `ASSIGNED` > `MENTIONED` > `WATCHED_ACTIVITY`).
- Auto-watch is insert-if-absent and never un-mutes an existing row.
- Notification text: `title` at most 200 chars, `body` at most 280 chars (truncate with `…`); English fallback text in `title`/`body`, web renders from `kind` + `params`. Never store secrets, command text or comment bodies beyond the 280-char excerpt.
- Mention token grammar exactly `@[<label>](user:<id>)`, label without `]`, id a cuid (`c[a-z0-9]{20,32}`); at most 20 distinct mentions per text; plain `@name` is never parsed.
- `/me/*` routes: user principals only (agents 403), scoped to `principal.id`; never take a user id parameter. Foreign or unknown notification id → 404.
- `/me/events` shares `LiveStreamRegistry` and `LIVE_MAX_STREAMS_PER_USER` with project streams; events are content-free `{ type: 'notification', id }`.
- Retention: `NOTIFICATION_RETENTION_DAYS` default 90 (read rows only); closed `FleetHealthAlert` rows purged after 30 days.
- Fleet recipients: global admins (`User.role = 'ADMIN'`, not disabled) for approvals, budgets and health; the job's `requestedById` for job outcomes.
- `FleetHealthDetector` runs every 60 000 ms, only when `FLEET_SWEEP_ENABLED` is true, and skips runner-offline checks for the first `runnerOfflineSec` after API boot.
- i18n: every new API error in `apps/api/src/i18n/{en,zh}`; every new web string in `apps/web/i18n/locales/{en,zh}.json`.
- `openapi.json` and `apps/cli/src/generated/` are regenerated with `bun run generate`, never hand-edited.
- Repo commands: `bun run test`, `bun run lint`, `bun run type-check`; API integration specs need `bun run test:db:up` in `apps/api` and run with `KODA_DB_TESTS=1`.
- Immutability (user rule): no in-place mutation of inputs; build new arrays/objects.

## Review Focus

1. A ticket soft-deleted (or a comment deleted) between the event and the outbox handler: expected to produce no notification and no retry loop, not a handler that throws forever (test: Task A6 Step 1, case "deleted ticket").
2. The API restarts after being down for longer than `runnerOfflineSec`: runners have stale `lastSeenAt`, but nobody expects an "offline" alert storm for runners that reconnect within seconds (test: Task D6 Step 1, case "boot grace").
3. Malformed or hostile mention tokens (`@[x](user:)`, `@[a]b](user:c…)`, 500 tokens, a token for a non-member): expected to render as plain text or be ignored, never to throw or notify outsiders (test: Task C1 Step 1 and Task C3 Step 1).
4. A very long comment or ticket title: expected a truncated excerpt in the notification, never a failed insert (test: Task A5 Step 1, case "truncates").
5. "Mark all read" racing a new notification: expected the new one to stay unread (read-all marks rows created at or before the request time only) (test: Task A8 Step 1, case "read-all cutoff").

---

## Shared Interface Contract

Every part uses exactly these names. A part that needs something not listed here defines it inside its own task and
lists it in that task's **Produces**.

### API module `apps/api/src/notifications/`

```ts
// notification.types.ts
export const NOTIFICATION_CATEGORIES = ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const NOTIFICATION_CHANNELS = ['IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const WATCH_REASONS = ['REPORTER', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL'] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];
export type NotificationSourceType =
  'ticket_event' | 'fleet_job' | 'fleet_approval' | 'fleet_budget_incident' | 'fleet_health_alert';
export type NotificationParams = Readonly<Record<string, string | number>>;

export interface NotificationDraft {
  readonly userId: string;
  readonly projectId: string | null;
  readonly category: NotificationCategory;
  readonly kind: string;               // see "Kinds" below
  readonly title: string;
  readonly body: string | null;
  readonly link: string;
  readonly params: NotificationParams;
  readonly sourceType: NotificationSourceType;
  readonly sourceId: string;
  readonly actorId: string | null;
}

export const TITLE_MAX = 200;
export const BODY_MAX = 280;
export function truncate(text: string, max: number): string; // '…' suffix when cut
```

```ts
// notification-writer.ts
@Injectable() export class NotificationWriter {
  /** Eligibility + preference filter, insert (skipDuplicates), then UserEventBus.publish per inserted row. Returns inserted count. */
  deliver(drafts: readonly NotificationDraft[]): Promise<number>;
}
// notification-eligibility.ts
@Injectable() export class NotificationEligibility {
  /** Drops actor, disabled, unknown and (project-scoped) non-member non-admin recipients. */
  filter(drafts: readonly NotificationDraft[]): Promise<readonly NotificationDraft[]>;
  findGlobalAdminIds(): Promise<readonly string[]>;   // role ADMIN, not disabled
}
// notification-preferences.service.ts
@Injectable() export class NotificationPreferencesService {
  disabledUserIds(userIds: readonly string[], category: NotificationCategory, channel: NotificationChannel): Promise<ReadonlySet<string>>;
  list(userId: string): Promise<readonly { category: NotificationCategory; inApp: boolean }[]>;
  update(userId: string, changes: readonly { category: NotificationCategory; inApp: boolean }[]): Promise<void>;
}
// ticket-watchers.repository.ts (Prisma)
@Injectable() export class TicketWatchersRepository {
  ensure(ticketId: string, entries: readonly { userId: string; reason: WatchReason }[]): Promise<void>; // insert-if-absent
  findUnmutedUserIds(ticketId: string): Promise<readonly string[]>;
  watch(ticketId: string, userId: string): Promise<void>;     // upsert muted=false, reason MANUAL on insert
  unwatch(ticketId: string, userId: string): Promise<void>;   // upsert muted=true, reason MANUAL on insert
  state(ticketId: string, userId: string): Promise<{ watching: boolean; count: number }>; // count = unmuted
}
// notifications.repository.ts (Prisma)
@Injectable() export class NotificationsRepository {
  insertMany(drafts: readonly NotificationDraft[]): Promise<readonly { id: string; userId: string }[]>;
  page(userId: string, opts: { unreadOnly: boolean; page: number; limit: number }): Promise<{ items: NotificationRow[]; total: number }>; // internal; HTTP maps to koda Page<T>
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, id: string, now: Date): Promise<boolean>;  // false = not found / not owner
  markAllRead(userId: string, cutoff: Date): Promise<number>;         // only createdAt <= cutoff
  purgeRead(before: Date): Promise<number>;
}
```

```ts
// apps/api/src/live/user-event-bus.ts (lives beside ProjectEventBus; exported from LiveModule).
// `GET /me/events` (MeLiveController) also lives in LiveModule. Part A makes `createLiveStream` generic:
// `LiveStreamOptions.projectId` is renamed `key`.
export interface UserLiveEvent { readonly type: 'notification'; readonly userId: string; readonly id: string; readonly at: string }
@Injectable() export class UserEventBus {
  subscribe(userId: string, listener: (event: UserLiveEvent) => void): () => void;
  publish(event: UserLiveEvent): void;   // never throws
  listenerCount(userId: string): number;
}
```

- `NotificationsModule` imports `OutboxModule`, `LiveModule`, `ProjectAccessModule`; exports `NotificationWriter`, `NotificationEligibility`. Part D's fleet producers live in `apps/api/src/notifications/fleet/` and register in the same module.
- `NotificationRetentionProcessor`: `@Cron('30 4 * * *') scheduledPurge()` calls `purge(now: Date)`, which runs each purge step with its own try/catch (Part A: read notifications; Part D adds closed health alerts).
- Mention seam (Part A → Part C): `TicketMentionResolver.mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]>` in `ticket-mention.resolver.ts`, `[]` in Part A, already called for `TICKET_CREATED` and `COMMENT_ADDED`; Part C fills the body and adds `TICKET_UPDATED` to `HandledTicketAction` (`ticket-notification.rules.ts`).

### Kinds, links and params (English fallback in quotes)

| kind | category | link | params | title |
|---|---|---|---|---|
| `ticket_assigned` | ASSIGNED | `/{slug}/tickets/{ref}` | `ref, ticketTitle, actorName` | "{actorName} assigned you {ref}: {ticketTitle}" |
| `ticket_mentioned` | MENTIONED | same | `ref, ticketTitle, actorName` | "{actorName} mentioned you on {ref}" |
| `ticket_commented` | WATCHED_ACTIVITY | same | `ref, ticketTitle, actorName` | "{actorName} commented on {ref}" (body = comment excerpt) |
| `ticket_status_changed` | WATCHED_ACTIVITY | same | `ref, ticketTitle, actorName, fromStatus, newStatus` | "{ref} moved {fromStatus} → {newStatus}" |
| `job_escalated` / `job_failed` / `job_crashed` | FLEET_NEEDS_YOU | `/{slug}/fleet/jobs/{jobId}` | `repo, feature, state` | "Fleet job on {repo} {state}" |
| `job_pr_opened` | FLEET_NEEDS_YOU | same | `repo, feature, prUrl` | "Fleet job on {repo} opened a PR" |
| `approval_requested` | FLEET_NEEDS_YOU | `/admin/fleet/approvals` | `repo, kind` | "Approval needed: {kind} on {repo}" |
| `budget_warn` / `budget_hard_stop` | FLEET_HEALTH | `/admin/fleet/budgets` | `scope, spentUsd, amountUsd` | "Budget {scope}: ${spentUsd} of ${amountUsd}" |
| `runner_offline` | FLEET_HEALTH | `/admin/fleet/runners` | `runner` | "Runner {runner} is offline" |
| `credential_expiring` | FLEET_HEALTH | `/admin/fleet/credentials` | `runner, provider, expiresAt` | "{provider} credential on {runner} expires {expiresAt}" |

`ref` is `{project.key}-{ticket.number}`. `actorName` is `User.name ?? User.email` local part, or the agent's name.

### Outbox event types (Part D)

```ts
// apps/api/src/notifications/fleet/fleet-notification-events.ts
export interface FleetJobOutcomePayload { jobId: string; leaseEpoch: number; projectId: string; requestedById: string;
  outcome: 'escalated' | 'failed' | 'crashed' | 'pr_opened'; repo: string; feature: string; resultPrUrl: string | null }
export interface FleetBudgetIncidentPayload { incidentId: string; kind: 'warn' | 'hard_stop'; scope: string; spentUsd: string; amountUsd: string }
export interface FleetHealthAlertPayload { alertId: string; kind: 'runner_offline' | 'credential_expiring'; runner: string; provider: string | null; expiresAt: string | null }
// type strings: 'fleet_job_outcome' | 'fleet_budget_incident' | 'fleet_health_alert'; 'fleet_approval_requested' already exists (#236)
```

### HTTP (Part A) — consumed by Parts B and C

| Route | Response |
|---|---|
| `GET /me/notifications?unread=true\|false&current=&size=` | koda `Page<NotificationDto>`: `{ total, current, size, hasNext, hasPrev, records }` (`KodaPageQuery`) |
| `GET /me/notifications/unread-count` | `{ count: number }` |
| `POST /me/notifications/:id/read` | 204 |
| `POST /me/notifications/read-all` | 204 |
| `GET /me/notification-preferences` | `{ items: { category, inApp }[] }` |
| `PUT /me/notification-preferences` | body `{ items: { category, inApp }[] }` → same as GET |
| `PUT` / `DELETE /projects/:slug/tickets/:ref/watch` | `{ watching, count }` |
| `GET /projects/:slug/tickets/:ref/watchers` | `{ watching, count }` |
| `GET /me/events` (SSE, not in openapi) | `event: notification`, `data: { type: 'notification', userId, id, at }` |

`NotificationDto`: `{ id, category, kind, title, body, link, params, projectId, actorId, readAt, createdAt }` (ISO strings).

### Web (Parts B, C)

- `apps/web/lib/notification-types.ts`: `NotificationDto`, `NotificationCategory`, `NotificationPreferenceDto`, `WatchStateDto`.
- `apps/web/composables/useUserEvents.ts`: `useUserEvents(onEvent: () => void): void` — one EventSource to `/api/me/events`, polling fallback.
- `apps/web/composables/useNotifications.ts`: `{ unreadCount, latest, refresh, markRead(id), markAllRead() }`.
- `apps/web/server/api/me/events.get.ts`: abort-aware Nitro proxy.
- `apps/web/lib/mentions.ts` (Part C): `mentionToken(label, userId): string`, `splitMentions(text): ({ text } | { userId, label })[]`.
- JSON responses use the repo's `JsonResponse.Ok` envelope, which `$api` unwraps; Part B adds `$api.put`.
- Outbox: `OutboxEvent.projectId` becomes nullable for `GLOBAL_OUTBOX_TYPES` only (Part D, D512).

---

## Part A — PR 1: Notifications core and ticket producers

Implements spec §1 (data, minus `FleetHealthAlert`), §2.1-§2.2 (pipeline and ticket producers; the mention step is a
seam that returns no ids until Part C), §3 (API and CLI), §4 (user live stream) and the retention job. No web change.
Branch `feat/fleet-s4a-1-notifications-core` (the renamed `docs/fleet-s4a-spec`, which carries the spec and this plan).

Ground truth this part relies on (verified on `main` `d9a23c16`):
- `ticket_event` outbox payload = `buildTicketEventOutboxPayload` (`apps/api/src/events/outbox-envelope.util.ts:31`):
  `{ id, type: 'ticket_event', action, timestamp, ticketId, projectId, actorId, actorType, data }`. The handler receives
  it as a parsed object (`TicketLiveSubscriber` precedent). Actions handled here and their `data`:
  `TICKET_CREATED` `{ type, title }` (`tickets.service.ts:124`), `assigned` `{ assignedTo }` (`:368`, user **or**
  agent id), `COMMENT_ADDED` `{ commentId }` (`comments.service.ts:100`, `ticket-transitions.service.ts:126`),
  `status_changed` `{ fromStatus, newStatus }` (`ticket-transitions.service.ts:100`).
- `FanOutPublisher.register(type, handler)` runs every handler; a throw makes the relay retry the whole record
  (`apps/api/src/outbox/fan-out-publisher.ts`).
- `createLiveStream` is project-keyed today (`apps/api/src/live/live-stream.ts`, one caller `live.controller.ts:48`).
- Pages use `KodaPageQuery` (`current`, `size` 1..100) + `parseQuery` + `toPageResult` and the envelope
  `{ total, current, size, hasNext, hasPrev, records }` (`apps/api/src/common/dto/koda-page.query.ts`). The skeleton
  contract's "`Page<T>`: `{ items, meta }`" is wrong for this repo: Part A uses the real envelope, and the query
  takes `current`/`size` (mapped to the repository's `page`/`limit`). Parts B and C read `records`.
- The main test schema is built by `prisma db push`; data migrations are tested with
  `test/helpers/migration-schema.ts` (`scratchSchemaBefore`, `applyMigration`; statements split on `;`, comment lines
  dropped, so the backfill SQL must contain no literal `;` inside strings).
- Generated CLI client names follow `<ControllerName>_<method>` → `meNotificationsControllerList` etc.

### File Structure (Part A)

API (`apps/api`):
- Modify `prisma/schema.prisma` — models `Notification`, `TicketWatcher`, `NotificationPreference`; back-relations on `User`, `Project`, `Ticket`.
- Create `prisma/migrations/20261009090000_notifications_core/migration.sql` — tables, indexes, FKs, watcher backfill.
- Create `test/integration/notifications/notifications-backfill-migration.integration.spec.ts`.
- Modify `src/live/live-stream.ts` — generic over the event type, keyed by `key` (was `projectId`).
- Modify `src/live/live-stream.spec.ts`, `src/live/live.controller.ts` — follow the rename.
- Create `src/live/user-event-bus.ts` (+ `.spec.ts`) — per-user in-process bus.
- Create `src/live/me-live.controller.ts` (+ `.spec.ts`) — `GET /me/events`.
- Modify `src/live/live.module.ts` (+ `.spec.ts`) — provide/export `UserEventBus`, register `MeLiveController`.
- Create `src/notifications/notification.types.ts` (+ `.spec.ts`) — contract types, `truncate`.
- Create `src/notifications/notifications.repository.ts` (+ `.spec.ts`) — `Notification` reads/writes.
- Create `src/notifications/ticket-watchers.repository.ts` (+ `.spec.ts`) — `TicketWatcher` reads/writes, ref lookup.
- Create `test/integration/notifications/notifications-repository.integration.spec.ts`.
- Create `src/notifications/notification-preferences.service.ts` (+ `.spec.ts`).
- Create `src/notifications/notification-eligibility.ts` (+ `.spec.ts`).
- Create `src/notifications/ticket-notification-text.ts` (+ `.spec.ts`) — kind → title/body/params/link.
- Create `src/notifications/notification-writer.ts` (+ `.spec.ts`).
- Create `src/notifications/ticket-notification.rules.ts` (+ `.spec.ts`) — pure watch/recipient rules.
- Create `src/notifications/ticket-notification-reads.repository.ts` — ticket/comment/actor reads for the subscriber.
- Create `src/notifications/ticket-mention.resolver.ts` — Part C seam (returns `[]`).
- Create `src/notifications/ticket-notification.subscriber.ts` (+ `.spec.ts`).
- Modify `src/tickets/tickets.service.ts:368` (+ `tickets.service.spec.ts:1098`) — `assigned` data gains `assigneeType`.
- Modify `test/integration/memory/outbox-envelope.integration.spec.ts:290` — the envelope assertion gains `assigneeType`.
- Create `src/config/notifications.config.ts` (+ `.spec.ts`); modify `src/config/env.validation.ts`, `src/app.module.ts`.
- Create `src/notifications/notification-retention.processor.ts` (+ `.spec.ts`).
- Create `src/notifications/notifications.module.ts` (+ `.spec.ts`); modify `src/app.module.ts`.
- Create `src/notifications/me-notifications.service.ts` (+ `.spec.ts`).
- Create `src/notifications/me-notifications.controller.ts` (+ `.spec.ts`).
- Create `src/notifications/dto/notification.dto.ts`, `dto/list-notifications.query.ts`, `dto/notification-preferences.dto.ts`, `dto/watch-state.dto.ts`.
- Create `src/notifications/ticket-watch.service.ts` (+ `.spec.ts`), `src/notifications/ticket-watch.controller.ts` (+ `.spec.ts`).
- Create `src/i18n/en/notifications.json`, `src/i18n/zh/notifications.json`.
- Create `test/integration/notifications/notifications-api.integration.spec.ts`.
- Create `src/notifications/notifications-openapi.contract.spec.ts`.
- Regenerate `openapi.json`, `apps/cli/src/generated/`.

CLI (`apps/cli`):
- Create `src/commands/notifications.ts` (+ `.spec.ts`); modify `src/index.ts`.
- Create `src/commands/ticket-watch.ts` (+ `.spec.ts`); modify `src/commands/ticket.ts` (register at the end of `ticketCommand`).

Docs:
- Modify `.nax/mono/apps/api/context.md`, regenerate agent files.

---

### Task A0: Start on the PR 1 branch

**Files:** none.

The spec and this plan were committed on `docs/fleet-s4a-spec`, cut from `main` and rebased onto `d9a23c16` (#236).
That branch becomes PR 1.

- [ ] **Step 1: Rename the branch and bring it up to date**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git fetch origin
git switch docs/fleet-s4a-spec
git branch -m feat/fleet-s4a-1-notifications-core
git rebase origin/main
git log --oneline origin/main..HEAD
```

Expected: the rebase applies cleanly; the log lists only `docs(fleet): S4a ...` commits (spec and plan).

---

### Task A1: Schema, migration and the watcher backfill (spec §1)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (new models after `model TicketLink`; back-relations on `User`, `Project`, `Ticket`)
- Create: `apps/api/prisma/migrations/20261009090000_notifications_core/migration.sql`
- Test: `apps/api/test/integration/notifications/notifications-backfill-migration.integration.spec.ts`

**Interfaces:**
- Produces: Prisma models `Notification` (unique `userId_sourceType_sourceId_kind`), `TicketWatcher` (id
  `ticketId_userId`), `NotificationPreference` (id `userId_category_channel`); delegates `prisma.notification`,
  `prisma.ticketWatcher`, `prisma.notificationPreference`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/api/test/integration/notifications/notifications-backfill-migration.integration.spec.ts`:

```ts
/**
 * Fleet S4a §1: the notifications migration backfills watchers from reporters, user assignees and user
 * commenters of live tickets.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-backfill-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20261009090000_notifications_core';

interface WatchRow { ticketId: string; userId: string; reason: string; muted: boolean }

describeIntegration('notifications core migration backfill (S4a §1)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'notifications_core_migration', TARGET);
    const { db } = scratch;
    await db.$executeRawUnsafe(`
      INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES
        ('u-rep', 'rep@k.t', 'x', CURRENT_TIMESTAMP),
        ('u-asg', 'asg@k.t', 'x', CURRENT_TIMESTAMP),
        ('u-com', 'com@k.t', 'x', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Agent" ("id", "name", "slug", "apiKeyHash", "updatedAt") VALUES ('a-1', 'Bot', 'bot', 'h', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Ticket" ("id", "projectId", "number", "type", "title", "createdByUserId", "assignedToUserId", "assignedToAgentId", "deletedAt", "updatedAt") VALUES
        ('t-live',    'p1', 1, 'TASK', 'a', 'u-rep', 'u-asg', NULL,  NULL,              CURRENT_TIMESTAMP),
        ('t-self',    'p1', 2, 'TASK', 'b', 'u-rep', 'u-rep', NULL,  NULL,              CURRENT_TIMESTAMP),
        ('t-agent',   'p1', 3, 'TASK', 'c', NULL,    NULL,    'a-1', NULL,              CURRENT_TIMESTAMP),
        ('t-deleted', 'p1', 4, 'TASK', 'd', 'u-rep', 'u-asg', NULL,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Comment" ("id", "ticketId", "body", "authorUserId", "authorAgentId", "updatedAt") VALUES
        ('c1', 't-live',    'x', 'u-com', NULL,  CURRENT_TIMESTAMP),
        ('c2', 't-live',    'y', 'u-com', NULL,  CURRENT_TIMESTAMP),
        ('c3', 't-live',    'z', 'u-asg', NULL,  CURRENT_TIMESTAMP),
        ('c4', 't-agent',   'w', NULL,    'a-1', CURRENT_TIMESTAMP),
        ('c5', 't-deleted', 'v', 'u-com', NULL,  CURRENT_TIMESTAMP)
    `);
    await applyMigration(db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  const watchers = (ticketId: string): Promise<WatchRow[]> => scratch.db.$queryRawUnsafe<WatchRow[]>(
    `SELECT "ticketId", "userId", "reason", "muted" FROM "TicketWatcher" WHERE "ticketId" = '${ticketId}' ORDER BY "userId"`,
  );

  it('adds reporter, user assignee and each distinct user commenter once, first reason wins', async () => {
    expect(await watchers('t-live')).toEqual([
      { ticketId: 't-live', userId: 'u-asg', reason: 'ASSIGNEE', muted: false },
      { ticketId: 't-live', userId: 'u-com', reason: 'COMMENTER', muted: false },
      { ticketId: 't-live', userId: 'u-rep', reason: 'REPORTER', muted: false },
    ]);
  });

  it('keeps one row when the reporter is also the assignee', async () => {
    expect(await watchers('t-self')).toEqual([{ ticketId: 't-self', userId: 'u-rep', reason: 'REPORTER', muted: false }]);
  });

  it('adds no watcher for agents or deleted tickets', async () => {
    expect(await watchers('t-agent')).toEqual([]);
    expect(await watchers('t-deleted')).toEqual([]);
  });

  it('creates the notification and preference tables empty with their unique keys', async () => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('Notification', 'NotificationPreference', 'TicketWatcher') ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expect.arrayContaining([
      'Notification_userId_sourceType_sourceId_kind_key',
      'Notification_userId_readAt_createdAt_idx',
      'Notification_userId_createdAt_idx',
      'NotificationPreference_pkey',
      'TicketWatcher_pkey',
      'TicketWatcher_userId_idx',
    ]));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-backfill-migration.integration.spec.ts`
Expected: FAIL — `ENOENT ... 20261009090000_notifications_core/migration.sql`.

- [ ] **Step 3: Add the models**

In `apps/api/prisma/schema.prisma`, after `model TicketLink { ... }` add:

```prisma
/// Fleet S4a §1: one in-app notification for one user. Unique per (user, source, kind): outbox redelivery inserts nothing.
model Notification {
  id         String    @id @default(cuid())
  userId     String
  projectId  String? // null for global fleet health
  category   String // ASSIGNED | MENTIONED | WATCHED_ACTIVITY | FLEET_NEEDS_YOU | FLEET_HEALTH
  kind       String // ticket_assigned | ticket_mentioned | ticket_commented | ticket_status_changed | job_* | approval_requested | budget_* | runner_offline | credential_expiring
  title      String // English fallback (CLI, API consumers)
  body       String?
  params     Json      @default("{}") // kind-specific values for web i18n rendering
  link       String // in-app path
  sourceType String // ticket_event | fleet_job | fleet_approval | fleet_budget_incident | fleet_health_alert
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

/// Fleet S4a §1: who follows a ticket. Unwatch is a sticky `muted` flag; auto-watch never un-mutes.
model TicketWatcher {
  ticketId  String
  userId    String
  reason    String // REPORTER | ASSIGNEE | COMMENTER | MENTIONED | MANUAL
  muted     Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  ticket Ticket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([ticketId, userId])
  @@index([userId])
}

/// Fleet S4a §1: per-user category switch per channel. A missing row means enabled.
model NotificationPreference {
  userId   String
  category String
  channel  String // IN_APP (S4a); EMAIL (S4b)
  enabled  Boolean

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, category, channel])
}
```

Add back-relations (Prisma requires both sides):
- `model User`, after `jobSchedules ...`:

```prisma
  notifications           Notification[]
  ticketWatches           TicketWatcher[]
  notificationPreferences NotificationPreference[]
```

- `model Project`, after `jobSchedules       JobSchedule[]`:

```prisma
  notifications      Notification[]
```

- `model Ticket`, after `links           TicketLink[]`:

```prisma
  watchers        TicketWatcher[]
```

Run: `cd apps/api && bunx prisma format && bunx prisma validate` — Expected: `The schema ... is valid`.

- [ ] **Step 4: Generate the migration SQL and append the backfill**

```bash
cd apps/api
git show origin/main:apps/api/prisma/schema.prisma > /tmp/schema-main.prisma
mkdir -p prisma/migrations/20261009090000_notifications_core
bunx prisma migrate diff --from-schema-datamodel /tmp/schema-main.prisma --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20261009090000_notifications_core/migration.sql
cat prisma/migrations/20261009090000_notifications_core/migration.sql
```

Expected: only `CREATE TABLE` for the three tables, their indexes and foreign keys (whitespace may differ). If anything
else appears, stop and investigate — `main`'s schema has drifted from its migrations. Then edit the file so it reads
exactly (the header comment first, the backfill last):

```sql
-- Fleet S4a: notifications core (spec §1, D501, D502, D503).
-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "actorId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketWatcher" (
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketWatcher_pkey" PRIMARY KEY ("ticketId","userId")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","category","channel")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_sourceType_sourceId_kind_key" ON "Notification"("userId", "sourceType", "sourceId", "kind");

-- CreateIndex
CREATE INDEX "TicketWatcher_userId_idx" ON "TicketWatcher"("userId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- S4a backfill: watchers of live tickets. Reporter first, then user assignee, then distinct user commenters;
-- ON CONFLICT keeps the first reason. No statement may contain a literal semicolon (migration-schema.ts splits on it).
INSERT INTO "TicketWatcher" ("ticketId", "userId", "reason", "muted", "createdAt", "updatedAt")
SELECT t."id", t."createdByUserId", 'REPORTER', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Ticket" t
WHERE t."deletedAt" IS NULL AND t."createdByUserId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "TicketWatcher" ("ticketId", "userId", "reason", "muted", "createdAt", "updatedAt")
SELECT t."id", t."assignedToUserId", 'ASSIGNEE', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Ticket" t
WHERE t."deletedAt" IS NULL AND t."assignedToUserId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "TicketWatcher" ("ticketId", "userId", "reason", "muted", "createdAt", "updatedAt")
SELECT DISTINCT c."ticketId", c."authorUserId", 'COMMENTER', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Comment" c
JOIN "Ticket" t ON t."id" = c."ticketId"
WHERE t."deletedAt" IS NULL AND c."authorUserId" IS NOT NULL
ON CONFLICT DO NOTHING;
```

Prisma's generated index/FK statements may be ordered differently; keep Prisma's statements verbatim and only add
the header and the backfill block.

- [ ] **Step 5: Run to verify it passes**

```bash
cd apps/api && bunx prisma generate
bun run test:scoped test/integration/notifications/notifications-backfill-migration.integration.spec.ts
```

Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20261009090000_notifications_core apps/api/test/integration/notifications/notifications-backfill-migration.integration.spec.ts
git commit -m "feat(notifications): Notification, TicketWatcher, NotificationPreference + watcher backfill (S4a §1)"
```

---
### Task A2: User live stream — `UserEventBus` and `GET /me/events` (spec §4, D509)

**Files:**
- Modify: `apps/api/src/live/live-stream.ts` (generic event type; option `projectId` renamed `key`)
- Modify: `apps/api/src/live/live-stream.spec.ts` (setup uses `key`)
- Modify: `apps/api/src/live/live.controller.ts:48-56` (pass `key: projectId`)
- Create: `apps/api/src/live/user-event-bus.ts`, `apps/api/src/live/user-event-bus.spec.ts`
- Create: `apps/api/src/live/me-live.controller.ts`, `apps/api/src/live/me-live.controller.spec.ts`
- Modify: `apps/api/src/live/live.module.ts`, `apps/api/src/live/live.module.spec.ts`

**Interfaces:**
- Consumes: `LiveStreamRegistry`, `JwtAuthProvider.getPrincipal`, `kodaTokenExtractor`, `decodeJwtPayload`,
  `tokenExpiryMs`, `LIVE_CFG` (all existing).
- Produces: `UserLiveEvent`, `UserEventBus` exactly as in the Shared Interface Contract;
  `LiveStreamOptions<E extends LiveStreamEvent = LiveEvent>` with `key: string` and
  `subscribe: (key: string, listener: (event: E) => void) => () => void`; `createLiveStream<E>(options)`;
  `MeLiveController` serving `GET /api/me/events` (SSE, excluded from openapi). `LiveModule` exports
  `ProjectEventBus` and `UserEventBus`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/live/user-event-bus.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { UserEventBus, UserLiveEvent } from './user-event-bus';

const event = (userId: string, id = 'n1'): UserLiveEvent => ({ type: 'notification', userId, id, at: '2026-10-09T00:00:00.000Z' });

describe('UserEventBus (S4a §4)', () => {
  it('delivers only to the addressed user', () => {
    const bus = new UserEventBus();
    const a = jest.fn();
    const b = jest.fn();
    bus.subscribe('u1', a);
    bus.subscribe('u2', b);
    bus.publish(event('u1'));
    expect(a).toHaveBeenCalledWith(event('u1'));
    expect(b).not.toHaveBeenCalled();
  });

  it('unsubscribes and counts listeners per user', () => {
    const bus = new UserEventBus();
    const off = bus.subscribe('u1', jest.fn());
    bus.subscribe('u1', jest.fn());
    expect(bus.listenerCount('u1')).toBe(2);
    off();
    expect(bus.listenerCount('u1')).toBe(1);
    expect(bus.listenerCount('nobody')).toBe(0);
  });

  it('never throws when a listener does, and still reaches the others', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bus = new UserEventBus();
    const ok = jest.fn();
    bus.subscribe('u1', () => { throw new Error('boom'); });
    bus.subscribe('u1', ok);
    expect(() => bus.publish(event('u1'))).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });
});
```

Create `apps/api/src/live/me-live.controller.spec.ts`:

```ts
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { firstValueFrom, take, toArray } from 'rxjs';
import type { JwtAuthProvider } from '../auth/jwt-auth.provider';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { LiveStreamRegistry } from './live-stream-registry';
import { MeLiveController } from './me-live.controller';
import { UserEventBus } from './user-event-bus';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwtFor = (payload: Record<string, unknown>): string => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@koda.test',
  name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};

function setup(revoked = false) {
  const jwtAuth = { getPrincipal: jest.fn().mockResolvedValue({ ...user, revoked }) } as unknown as JwtAuthProvider;
  const bus = new UserEventBus();
  const streams = new LiveStreamRegistry();
  const controller = new MeLiveController(bus, streams, jwtAuth, { heartbeatMs: 25000, maxStreamsPerUser: 5 });
  const req = { headers: { authorization: `Bearer ${jwtFor({ sub: 'u1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 900 })}` } };
  return { controller, jwtAuth, bus, streams, req };
}

describe('MeLiveController (S4a §4)', () => {
  it('refuses agent principals with 403', async () => {
    const { controller, req } = setup();
    await expect(controller.events(agent, req)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('refuses a request without a readable bearer token', async () => {
    const { controller } = setup();
    await expect(controller.events(user, { headers: {} })).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('shares the per-user cap with project streams: a 6th stream is 429', async () => {
    const { controller, streams, req } = setup();
    for (let i = 0; i < 5; i += 1) streams.tryAcquire('u1', 5);
    await expect(controller.events(user, req)).rejects.toBeInstanceOf(ThrottleAppException);
  });

  it('streams ready then the caller\'s notification events only, and releases the slot', async () => {
    const { controller, bus, streams, req } = setup();
    const stream = await controller.events(user, req);
    expect(streams.activeFor('u1')).toBe(1);
    const firstTwo = firstValueFrom(stream.pipe(take(2), toArray()));
    bus.publish({ type: 'notification', userId: 'someone-else', id: 'n0', at: 'x' });
    bus.publish({ type: 'notification', userId: 'u1', id: 'n1', at: 'x' });
    const messages = await firstTwo;
    expect(messages.map((m) => m.type)).toEqual(['ready', 'notification']);
    expect(messages[1]).toEqual({ type: 'notification', id: 'n1', data: { type: 'notification', userId: 'u1', id: 'n1', at: 'x' } });
    expect(streams.activeFor('u1')).toBe(0);
  });

  it('closes the stream when the fresh principal is revoked (disabled or logged out)', async () => {
    jest.useFakeTimers();
    try {
      const { controller, req } = setup(true);
      const stream = await controller.events(user, req);
      let completed = false;
      const sub = stream.subscribe({ complete: () => { completed = true; } });
      await jest.advanceTimersByTimeAsync(25000);
      expect(completed).toBe(true);
      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });
});
```

In `apps/api/src/live/live.module.spec.ts`, add imports `import { MeLiveController } from './me-live.controller';`
and `import { UserEventBus } from './user-event-bus';` and append inside the `describe`:

```ts
  it('resolves the user bus and the /me/events controller (S4a §4)', () => {
    expect(moduleRef.get(UserEventBus)).toBeInstanceOf(UserEventBus);
    expect(moduleRef.get(MeLiveController)).toBeInstanceOf(MeLiveController);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/live`
Expected: FAIL — `Cannot find module './user-event-bus'` and `'./me-live.controller'`.

- [ ] **Step 3: Make the stream generic**

Replace the options interface and signature in `apps/api/src/live/live-stream.ts`:

```ts
import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { LiveEvent } from './live-event';

const MAX_TIMER_MS = 2_147_483_647;

/** What a stream forwards: a named, id-carrying event (clients dedupe on id). */
export interface LiveStreamEvent {
  type: string;
  id: string;
}

export interface LiveStreamOptions<E extends LiveStreamEvent = LiveEvent> {
  /** Bus key: a project id for project streams, a user id for `/me/events` (S4a §4). */
  key: string;
  heartbeatMs: number;
  expiresAtMs: number | null;
  now: () => number;
  subscribe: (key: string, listener: (event: E) => void) => () => void;
  stillAllowed: () => Promise<boolean>;
  onClose: () => void;
}
```

and change the function header and subscribe call:

```ts
export function createLiveStream<E extends LiveStreamEvent = LiveEvent>(options: LiveStreamOptions<E>): Observable<MessageEvent> {
```

```ts
    const unsubscribe = options.subscribe(options.key, (event) => {
```

Update the doc comment's first sentence to "One caller's live stream (project or user)." Leave the rest of the body
unchanged.

In `apps/api/src/live/live.controller.ts`, in the `createLiveStream({ ... })` call replace `projectId,` with
`key: projectId,`.

In `apps/api/src/live/live-stream.spec.ts`, in `setup` replace `projectId: 'p1',` with `key: 'p1',` and rename the
first `subscribe` mock parameter `_projectId` to `_key`. The assertion
`expect(s.options.subscribe).toHaveBeenCalledWith('p1', expect.any(Function))` stays.

- [ ] **Step 4: Implement the bus** — `apps/api/src/live/user-event-bus.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';

/** Fleet S4a §4: content-free "you have a new notification" signal; the client refetches. */
export interface UserLiveEvent {
  readonly type: 'notification';
  readonly userId: string;
  readonly id: string;
  readonly at: string;
}

export type UserLiveListener = (event: UserLiveEvent) => void;

interface Subscription {
  readonly listener: UserLiveListener;
}

/**
 * In-process fan-out of user events to open `/me/events` streams, keyed by user id. Single API
 * instance by design (same constraint as ProjectEventBus). publish() never throws.
 */
@Injectable()
export class UserEventBus {
  private readonly logger = new Logger(UserEventBus.name);
  private subscriptions: ReadonlyMap<string, readonly Subscription[]> = new Map();

  subscribe(userId: string, listener: UserLiveListener): () => void {
    const subscription: Subscription = { listener };
    this.subscriptions = new Map([...this.subscriptions, [userId, [...this.forUser(userId), subscription]]]);
    return () => this.remove(userId, subscription);
  }

  publish(event: UserLiveEvent): void {
    for (const { listener } of this.forUser(event.userId)) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(`User live listener failed for ${event.userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  listenerCount(userId: string): number {
    return this.forUser(userId).length;
  }

  private forUser(userId: string): readonly Subscription[] {
    return this.subscriptions.get(userId) ?? [];
  }

  private remove(userId: string, subscription: Subscription): void {
    const remaining = this.forUser(userId).filter((s) => s !== subscription);
    const next = new Map(this.subscriptions);
    if (remaining.length > 0) next.set(userId, remaining);
    else next.delete(userId);
    this.subscriptions = next;
  }
}
```

- [ ] **Step 5: Implement the controller** — `apps/api/src/live/me-live.controller.ts`:

```ts
import { Controller, Inject, MessageEvent, Req, Sse } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { kodaTokenExtractor } from '../auth/auth.module';
import { JwtAuthProvider } from '../auth/jwt-auth.provider';
import { isUserPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ILiveConfig, LIVE_CFG } from '../config/live.config';
import { decodeJwtPayload, tokenExpiryMs } from './jwt-payload';
import { createLiveStream } from './live-stream';
import { LiveStreamRegistry } from './live-stream-registry';
import { UserEventBus, UserLiveEvent } from './user-event-bus';

/**
 * Fleet S4a §4: the caller's own notification signal over SSE. Users only (agents and runners
 * refused); excluded from openapi. Shares the per-user stream cap with project streams (D509).
 */
@ApiTags('live')
@Controller('me/events')
export class MeLiveController {
  constructor(
    private readonly bus: UserEventBus,
    private readonly streams: LiveStreamRegistry,
    private readonly jwtAuth: JwtAuthProvider,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  @Sse()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async events(@Principal() principal: KodaPrincipal, @Req() req: unknown): Promise<Observable<MessageEvent>> {
    if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'live');
    const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
    if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
    if (!this.streams.tryAcquire(principal.id, this.config.maxStreamsPerUser)) {
      throw new ThrottleAppException({}, 'live');
    }
    return createLiveStream<UserLiveEvent>({
      key: principal.id,
      heartbeatMs: this.config.heartbeatMs,
      expiresAtMs: tokenExpiryMs(jwtPayload),
      now: Date.now,
      subscribe: (userId, listener) => this.bus.subscribe(userId, listener),
      stillAllowed: async () => !(await this.jwtAuth.getPrincipal(jwtPayload)).revoked,
      onClose: () => this.streams.release(principal.id),
    });
  }
}
```

`kodaTokenExtractor` returns `null` for a request without a bearer header (that is the "no readable token" test).
If the spec's `{ headers: {} }` makes it throw instead, read `apps/api/src/auth/auth.module.ts` and pass the same
request shape `live.controller.spec.ts` uses for its negative cases.

- [ ] **Step 6: Wire the module** — `apps/api/src/live/live.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { LiveController } from './live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { MeLiveController } from './me-live.controller';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';
import { UserEventBus } from './user-event-bus';

@Module({
  imports: [OutboxModule, AuthModule, ProjectAccessModule],
  controllers: [LiveController, MeLiveController],
  providers: [ProjectEventBus, UserEventBus, TicketLiveSubscriber, LiveStreamRegistry],
  exports: [ProjectEventBus, UserEventBus],
})
export class LiveModule {}
```

- [ ] **Step 7: Run to verify they pass**

Run: `cd apps/api && bunx jest src/live && bun run type-check`
Expected: PASS (all `src/live` specs, including the unchanged `live.controller.spec.ts` and `live-stream.spec.ts`);
type-check clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/live
git commit -m "feat(live): UserEventBus and GET /me/events user stream (S4a §4, D509)"
```

---
### Task A3: Contract types and the two Prisma repositories (spec §1, D501, D502)

**Files:**
- Create: `apps/api/src/notifications/notification.types.ts`, `apps/api/src/notifications/notification.types.spec.ts`
- Create: `apps/api/src/notifications/notifications.repository.ts`, `apps/api/src/notifications/notifications.repository.spec.ts`
- Create: `apps/api/src/notifications/ticket-watchers.repository.ts`, `apps/api/src/notifications/ticket-watchers.repository.spec.ts`
- Test: `apps/api/test/integration/notifications/notifications-repository.integration.spec.ts`

**Interfaces:**
- Consumes: Prisma models from A1.
- Produces (exact, from the Shared Interface Contract): `NOTIFICATION_CATEGORIES`, `NotificationCategory`,
  `NOTIFICATION_CHANNELS`, `NotificationChannel`, `WATCH_REASONS`, `WatchReason`, `NotificationSourceType`,
  `NotificationParams`, `NotificationDraft`, `TITLE_MAX = 200`, `BODY_MAX = 280`,
  `truncate(text: string, max: number): string`; `NotificationsRepository` with `insertMany`, `page`,
  `unreadCount`, `markRead`, `markAllRead`, `purgeRead`; `TicketWatchersRepository` with `ensure`,
  `findUnmutedUserIds`, `watch`, `unwatch`, `state`.
- Produces (additions, used by A9): `NotificationRow` (below);
  `TicketWatchersRepository.findTicketIdByRef(projectId: string, ref: string): Promise<string | null>`.

```ts
export interface NotificationRow {
  id: string; userId: string; projectId: string | null; category: string; kind: string; title: string;
  body: string | null; link: string; params: NotificationParams; actorId: string | null;
  readAt: Date | null; createdAt: Date;
}
```

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/notifications/notification.types.spec.ts`:

```ts
import { BODY_MAX, NOTIFICATION_CATEGORIES, TITLE_MAX, truncate, WATCH_REASONS } from './notification.types';

describe('notification types (S4a)', () => {
  it('pins the categories and watch reasons', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH']);
    expect(WATCH_REASONS).toEqual(['REPORTER', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL']);
    expect([TITLE_MAX, BODY_MAX]).toEqual([200, 280]);
  });

  it('leaves short text alone and cuts long text to exactly max chars ending in an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a'.repeat(10), 10)).toBe('a'.repeat(10));
    const cut = truncate('a'.repeat(11), 10);
    expect(cut).toBe(`${'a'.repeat(9)}…`);
    expect(cut).toHaveLength(10);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncate(`${'a'.repeat(8)}😀😀`, 10);
    expect(cut).toBe(`${'a'.repeat(8)}…`);
  });

  it('collapses whitespace so a multi-line comment reads as one line', () => {
    expect(truncate('line one\n\n  line two', 50)).toBe('line one line two');
  });
});
```

`apps/api/src/notifications/notifications.repository.spec.ts`:

```ts
import { NotificationsRepository } from './notifications.repository';
import type { NotificationDraft } from './notification.types';

const draft = (over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId: 'u1', projectId: 'p1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', body: null,
  link: '/p/tickets/PP-1', params: { ref: 'PP-1' }, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'u2', ...over,
});

function setup() {
  const notification = {
    createManyAndReturn: jest.fn().mockResolvedValue([{ id: 'n1', userId: 'u1' }]),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
  };
  const repo = new NotificationsRepository({ client: { notification } } as never);
  return { repo, notification };
}

describe('NotificationsRepository (S4a §1)', () => {
  it('inserts with skipDuplicates and returns only the inserted ids', async () => {
    const { repo, notification } = setup();
    await expect(repo.insertMany([draft()])).resolves.toEqual([{ id: 'n1', userId: 'u1' }]);
    expect(notification.createManyAndReturn).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: 'u1', sourceType: 'ticket_event', sourceId: 'e1', kind: 'ticket_assigned', params: { ref: 'PP-1' } })],
      skipDuplicates: true,
      select: { id: true, userId: true },
    });
  });

  it('does not touch the database for an empty batch', async () => {
    const { repo, notification } = setup();
    await expect(repo.insertMany([])).resolves.toEqual([]);
    expect(notification.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('pages newest first, filtering unread when asked', async () => {
    const { repo, notification } = setup();
    await repo.page('u1', { unreadOnly: true, page: 3, limit: 10 });
    expect(notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', readAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 10,
      select: expect.any(Object),
    });
    expect(notification.count).toHaveBeenCalledWith({ where: { userId: 'u1', readAt: null } });
  });

  it('markRead is owner-scoped and idempotent', async () => {
    const { repo, notification } = setup();
    const now = new Date('2026-10-09T00:00:00Z');
    notification.updateMany.mockResolvedValueOnce({ count: 0 });
    notification.count.mockResolvedValueOnce(1);
    await expect(repo.markRead('u1', 'n1', now)).resolves.toBe(true);
    expect(notification.updateMany).toHaveBeenCalledWith({ where: { id: 'n1', userId: 'u1', readAt: null }, data: { readAt: now } });
    expect(notification.count).toHaveBeenCalledWith({ where: { id: 'n1', userId: 'u1' } });
    notification.updateMany.mockResolvedValueOnce({ count: 0 });
    notification.count.mockResolvedValueOnce(0);
    await expect(repo.markRead('u1', 'not-mine', now)).resolves.toBe(false);
  });

  it('markAllRead marks only rows created at or before the cutoff', async () => {
    const { repo, notification } = setup();
    const cutoff = new Date('2026-10-09T00:00:00Z');
    notification.updateMany.mockResolvedValueOnce({ count: 4 });
    await expect(repo.markAllRead('u1', cutoff)).resolves.toBe(4);
    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', readAt: null, createdAt: { lte: cutoff } },
      data: { readAt: cutoff },
    });
  });

  it('purgeRead deletes read rows created before the cutoff only', async () => {
    const { repo, notification } = setup();
    const before = new Date('2026-07-01T00:00:00Z');
    await expect(repo.purgeRead(before)).resolves.toBe(3);
    expect(notification.deleteMany).toHaveBeenCalledWith({ where: { readAt: { not: null }, createdAt: { lt: before } } });
  });
});
```

`apps/api/src/notifications/ticket-watchers.repository.spec.ts`:

```ts
import { TicketWatchersRepository } from './ticket-watchers.repository';

function setup() {
  const ticketWatcher = {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
    upsert: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(2),
  };
  const project = { findUnique: jest.fn().mockResolvedValue({ key: 'PP' }) };
  const ticket = { findFirst: jest.fn().mockResolvedValue({ id: 't1' }) };
  const repo = new TicketWatchersRepository({ client: { ticketWatcher, project, ticket } } as never);
  return { repo, ticketWatcher, project, ticket };
}

describe('TicketWatchersRepository (S4a §1, D502)', () => {
  it('ensure inserts if absent, first reason per user wins, and never updates', async () => {
    const { repo, ticketWatcher } = setup();
    await repo.ensure('t1', [{ userId: 'u1', reason: 'REPORTER' }, { userId: 'u1', reason: 'COMMENTER' }, { userId: 'u2', reason: 'MENTIONED' }]);
    expect(ticketWatcher.createMany).toHaveBeenCalledWith({
      data: [{ ticketId: 't1', userId: 'u1', reason: 'REPORTER' }, { ticketId: 't1', userId: 'u2', reason: 'MENTIONED' }],
      skipDuplicates: true,
    });
    expect(ticketWatcher.upsert).not.toHaveBeenCalled();
  });

  it('ensure is a no-op for no entries', async () => {
    const { repo, ticketWatcher } = setup();
    await repo.ensure('t1', []);
    expect(ticketWatcher.createMany).not.toHaveBeenCalled();
  });

  it('findUnmutedUserIds reads unmuted rows', async () => {
    const { repo, ticketWatcher } = setup();
    await expect(repo.findUnmutedUserIds('t1')).resolves.toEqual(['u1', 'u2']);
    expect(ticketWatcher.findMany).toHaveBeenCalledWith({ where: { ticketId: 't1', muted: false }, select: { userId: true } });
  });

  it('watch un-mutes, unwatch mutes, both insert MANUAL when absent', async () => {
    const { repo, ticketWatcher } = setup();
    await repo.watch('t1', 'u1');
    expect(ticketWatcher.upsert).toHaveBeenLastCalledWith({
      where: { ticketId_userId: { ticketId: 't1', userId: 'u1' } },
      create: { ticketId: 't1', userId: 'u1', reason: 'MANUAL', muted: false },
      update: { muted: false },
    });
    await repo.unwatch('t1', 'u1');
    expect(ticketWatcher.upsert).toHaveBeenLastCalledWith({
      where: { ticketId_userId: { ticketId: 't1', userId: 'u1' } },
      create: { ticketId: 't1', userId: 'u1', reason: 'MANUAL', muted: true },
      update: { muted: true },
    });
  });

  it('state reports the caller\'s watching flag and the unmuted count', async () => {
    const { repo, ticketWatcher } = setup();
    ticketWatcher.findUnique.mockResolvedValueOnce({ muted: true });
    await expect(repo.state('t1', 'u1')).resolves.toEqual({ watching: false, count: 2 });
    ticketWatcher.findUnique.mockResolvedValueOnce({ muted: false });
    await expect(repo.state('t1', 'u1')).resolves.toEqual({ watching: true, count: 2 });
    await expect(repo.state('t1', 'u9')).resolves.toEqual({ watching: false, count: 2 });
    expect(ticketWatcher.count).toHaveBeenCalledWith({ where: { ticketId: 't1', muted: false } });
  });

  it('findTicketIdByRef resolves KEY-N of this project only, case-insensitive, and never a deleted ticket', async () => {
    const { repo, ticket } = setup();
    await expect(repo.findTicketIdByRef('p1', 'pp-7')).resolves.toBe('t1');
    expect(ticket.findFirst).toHaveBeenLastCalledWith({ where: { projectId: 'p1', number: 7, deletedAt: null }, select: { id: true } });
    await expect(repo.findTicketIdByRef('p1', 'OTHER-7')).resolves.toBeNull();
    await repo.findTicketIdByRef('p1', 'ckabc');
    expect(ticket.findFirst).toHaveBeenLastCalledWith({ where: { id: 'ckabc', projectId: 'p1', deletedAt: null }, select: { id: true } });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/notifications`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the types** — `apps/api/src/notifications/notification.types.ts`:

```ts
/** Fleet S4a: the notification contract shared by the pipeline, producers and API (spec §1-§3). */
export const NOTIFICATION_CATEGORIES = ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const WATCH_REASONS = ['REPORTER', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL'] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];

export type NotificationSourceType =
  'ticket_event' | 'fleet_job' | 'fleet_approval' | 'fleet_budget_incident' | 'fleet_health_alert';

export type NotificationParams = Readonly<Record<string, string | number>>;

export interface NotificationDraft {
  readonly userId: string;
  readonly projectId: string | null;
  readonly category: NotificationCategory;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly link: string;
  readonly params: NotificationParams;
  readonly sourceType: NotificationSourceType;
  readonly sourceId: string;
  readonly actorId: string | null;
}

export interface NotificationRow {
  id: string;
  userId: string;
  projectId: string | null;
  category: string;
  kind: string;
  title: string;
  body: string | null;
  link: string;
  params: NotificationParams;
  actorId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export const TITLE_MAX = 200;
export const BODY_MAX = 280;

/**
 * One-line excerpt of at most `max` UTF-16 units: whitespace runs collapse to one space; text over
 * the limit is cut at a code-point boundary and ends with '…' (Review Focus 4).
 */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const points = Array.from(flat);
  const kept: string[] = [];
  let length = 0;
  for (const point of points) {
    if (length + point.length > max - 1) break;
    kept.push(point);
    length += point.length;
  }
  return `${kept.join('')}…`;
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}
```

(`isNotificationCategory` is an addition used by A4 and A8.)

- [ ] **Step 4: Implement `NotificationsRepository`** — `apps/api/src/notifications/notifications.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { NotificationDraft, NotificationParams, NotificationRow } from './notification.types';

const ROW_SELECT = {
  id: true, userId: true, projectId: true, category: true, kind: true, title: true, body: true, link: true,
  params: true, actorId: true, readAt: true, createdAt: true,
} as const;

type RawRow = Prisma.NotificationGetPayload<{ select: typeof ROW_SELECT }>;

const toParams = (value: Prisma.JsonValue): NotificationParams =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as NotificationParams) : {};

const toRow = (r: RawRow): NotificationRow => ({ ...r, params: toParams(r.params) });

/** Fleet S4a §1: every Prisma access to `Notification`. Joins an open txManager.run. */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /** D501: the unique (userId, sourceType, sourceId, kind) key makes a repeat insert a no-op. */
  async insertMany(drafts: readonly NotificationDraft[]): Promise<readonly { id: string; userId: string }[]> {
    if (drafts.length === 0) return [];
    return this.db.notification.createManyAndReturn({
      data: drafts.map((d) => ({
        userId: d.userId, projectId: d.projectId, category: d.category, kind: d.kind, title: d.title, body: d.body,
        link: d.link, params: { ...d.params } as Prisma.InputJsonObject, sourceType: d.sourceType, sourceId: d.sourceId,
        actorId: d.actorId,
      })),
      skipDuplicates: true,
      select: { id: true, userId: true },
    });
  }

  async page(userId: string, opts: { unreadOnly: boolean; page: number; limit: number }): Promise<{ items: NotificationRow[]; total: number }> {
    const where = opts.unreadOnly ? { userId, readAt: null } : { userId };
    const [rows, total] = await Promise.all([
      this.db.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
        select: ROW_SELECT,
      }),
      this.db.notification.count({ where }),
    ]);
    return { items: rows.map(toRow), total };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.db.notification.count({ where: { userId, readAt: null } });
  }

  /** False only when the row does not exist or is not the caller's; marking a read row again is true. */
  async markRead(userId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now } });
    if (count === 1) return true;
    return (await this.db.notification.count({ where: { id, userId } })) === 1;
  }

  /** Review Focus 5: only rows created at or before the cutoff, so a racing new notification stays unread. */
  async markAllRead(userId: string, cutoff: Date): Promise<number> {
    const { count } = await this.db.notification.updateMany({
      where: { userId, readAt: null, createdAt: { lte: cutoff } },
      data: { readAt: cutoff },
    });
    return count;
  }

  async purgeRead(before: Date): Promise<number> {
    const { count } = await this.db.notification.deleteMany({ where: { readAt: { not: null }, createdAt: { lt: before } } });
    return count;
  }
}
```

- [ ] **Step 5: Implement `TicketWatchersRepository`** — `apps/api/src/notifications/ticket-watchers.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { parseTicketRef } from '../common/utils/ticket-ref.util';
import type { WatchReason } from './notification.types';

/** Fleet S4a §1 (D502): every Prisma access to `TicketWatcher`. Joins an open txManager.run. */
@Injectable()
export class TicketWatchersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /** Insert-if-absent; never un-mutes or changes the reason of an existing row. First reason per user wins. */
  async ensure(ticketId: string, entries: readonly { userId: string; reason: WatchReason }[]): Promise<void> {
    const firstByUser = entries.reduce<ReadonlyMap<string, WatchReason>>(
      (acc, e) => (acc.has(e.userId) ? acc : new Map([...acc, [e.userId, e.reason]])),
      new Map(),
    );
    if (firstByUser.size === 0) return;
    await this.db.ticketWatcher.createMany({
      data: [...firstByUser].map(([userId, reason]) => ({ ticketId, userId, reason })),
      skipDuplicates: true,
    });
  }

  async findUnmutedUserIds(ticketId: string): Promise<readonly string[]> {
    const rows = await this.db.ticketWatcher.findMany({ where: { ticketId, muted: false }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  async watch(ticketId: string, userId: string): Promise<void> {
    await this.setMuted(ticketId, userId, false);
  }

  async unwatch(ticketId: string, userId: string): Promise<void> {
    await this.setMuted(ticketId, userId, true);
  }

  async state(ticketId: string, userId: string): Promise<{ watching: boolean; count: number }> {
    const [row, count] = await Promise.all([
      this.db.ticketWatcher.findUnique({ where: { ticketId_userId: { ticketId, userId } }, select: { muted: true } }),
      this.db.ticketWatcher.count({ where: { ticketId, muted: false } }),
    ]);
    return { watching: row !== null && !row.muted, count };
  }

  /** `KEY-N` (case-insensitive, this project's key only) or a ticket id of this project; deleted tickets never resolve. */
  async findTicketIdByRef(projectId: string, ref: string): Promise<string | null> {
    const parsed = parseTicketRef(ref.trim().toUpperCase());
    if (parsed) {
      const project = await this.db.project.findUnique({ where: { id: projectId }, select: { key: true } });
      if (!project || parsed.prefix !== project.key) return null;
      const row = await this.db.ticket.findFirst({ where: { projectId, number: parsed.number, deletedAt: null }, select: { id: true } });
      return row?.id ?? null;
    }
    const row = await this.db.ticket.findFirst({ where: { id: ref, projectId, deletedAt: null }, select: { id: true } });
    return row?.id ?? null;
  }

  private async setMuted(ticketId: string, userId: string, muted: boolean): Promise<void> {
    await this.db.ticketWatcher.upsert({
      where: { ticketId_userId: { ticketId, userId } },
      create: { ticketId, userId, reason: 'MANUAL', muted },
      update: { muted },
    });
  }
}
```

Note `findTicketIdByRef('p1', 'ckabc')` in the unit test: `parseTicketRef('CKABC')` returns `null` (no `-N`), so
the id branch runs with the original `ref` (not upper-cased) — that is what the assertion pins.

- [ ] **Step 6: Run the unit tests**

Run: `cd apps/api && bunx jest src/notifications`
Expected: PASS.

- [ ] **Step 7: Write the repository integration test (PG)**

Create `apps/api/test/integration/notifications/notifications-repository.integration.spec.ts`:

```ts
/**
 * Fleet S4a §1: Notification unique key, read-all cutoff and purge, and watcher semantics on Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-repository.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { NotificationsRepository } from '../../../src/notifications/notifications.repository';
import { TicketWatchersRepository } from '../../../src/notifications/ticket-watchers.repository';
import type { NotificationDraft } from '../../../src/notifications/notification.types';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('notifications repositories (PG)', () => {
  const prisma = new PrismaClient();
  const notifications = new NotificationsRepository({ client: prisma } as never);
  const watchers = new TicketWatchersRepository({ client: prisma } as never);
  const ids = { u1: '', u2: '', project: '', ticket: '' };

  const draft = (over: Partial<NotificationDraft> = {}): NotificationDraft => ({
    userId: ids.u1, projectId: ids.project, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'A', body: null,
    link: '/p/tickets/PP-1', params: { ref: 'PP-1' }, sourceType: 'ticket_event', sourceId: 'evt-1', actorId: ids.u2, ...over,
  });

  beforeAll(async () => {
    await resetDb();
    ids.u1 = (await prisma.user.create({ data: { email: 'u1@k.t', passwordHash: 'x' } })).id;
    ids.u2 = (await prisma.user.create({ data: { email: 'u2@k.t', passwordHash: 'x' } })).id;
    ids.project = (await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'PP' } })).id;
    ids.ticket = (await prisma.ticket.create({ data: { projectId: ids.project, number: 1, type: 'TASK', title: 't' } })).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a repeated draft inserts nothing (outbox redelivery, D501)', async () => {
    expect(await notifications.insertMany([draft()])).toHaveLength(1);
    expect(await notifications.insertMany([draft(), draft({ userId: ids.u2 })])).toEqual([{ id: expect.any(String), userId: ids.u2 }]);
    expect(await prisma.notification.count({ where: { sourceId: 'evt-1' } })).toBe(2);
  });

  it('read-all marks only rows created at or before the cutoff (Review Focus 5)', async () => {
    const cutoff = new Date();
    await prisma.notification.create({
      data: { userId: ids.u1, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'late', link: '/x', sourceType: 'ticket_event', sourceId: 'evt-late', createdAt: new Date(cutoff.getTime() + 1000) },
    });
    await notifications.markAllRead(ids.u1, cutoff);
    const unread = await prisma.notification.findMany({ where: { userId: ids.u1, readAt: null }, select: { sourceId: true } });
    expect(unread).toEqual([{ sourceId: 'evt-late' }]);
    expect(await notifications.unreadCount(ids.u1)).toBe(1);
  });

  it('markRead refuses another user\'s row and is idempotent for the owner', async () => {
    const [row] = await notifications.insertMany([draft({ sourceId: 'evt-own' })]);
    const now = new Date();
    expect(await notifications.markRead(ids.u2, row.id, now)).toBe(false);
    expect(await notifications.markRead(ids.u1, row.id, now)).toBe(true);
    expect(await notifications.markRead(ids.u1, row.id, now)).toBe(true);
  });

  it('purgeRead keeps unread rows however old', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await prisma.notification.create({
      data: { userId: ids.u2, category: 'ASSIGNED', kind: 'k', title: 'old read', link: '/x', sourceType: 'ticket_event', sourceId: 'old-read', createdAt: old, readAt: old },
    });
    await prisma.notification.create({
      data: { userId: ids.u2, category: 'ASSIGNED', kind: 'k', title: 'old unread', link: '/x', sourceType: 'ticket_event', sourceId: 'old-unread', createdAt: old },
    });
    expect(await notifications.purgeRead(new Date('2021-01-01T00:00:00Z'))).toBe(1);
    expect(await prisma.notification.count({ where: { sourceId: 'old-unread' } })).toBe(1);
  });

  it('auto-watch never un-mutes; watch/unwatch toggle the sticky mute (D502)', async () => {
    await watchers.ensure(ids.ticket, [{ userId: ids.u1, reason: 'REPORTER' }]);
    await watchers.unwatch(ids.ticket, ids.u1);
    await watchers.ensure(ids.ticket, [{ userId: ids.u1, reason: 'COMMENTER' }]);
    expect(await watchers.state(ids.ticket, ids.u1)).toEqual({ watching: false, count: 0 });
    expect(await watchers.findUnmutedUserIds(ids.ticket)).toEqual([]);
    await watchers.watch(ids.ticket, ids.u1);
    expect(await watchers.state(ids.ticket, ids.u1)).toEqual({ watching: true, count: 1 });
    const row = await prisma.ticketWatcher.findUniqueOrThrow({ where: { ticketId_userId: { ticketId: ids.ticket, userId: ids.u1 } } });
    expect(row.reason).toBe('REPORTER');
  });
});
```

- [ ] **Step 8: Run the integration test**

Run: `cd apps/api && bun run test:scoped test/integration/notifications/notifications-repository.integration.spec.ts`
Expected: 5 passing.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/notifications/notification.types.ts apps/api/src/notifications/notification.types.spec.ts \
  apps/api/src/notifications/notifications.repository.ts apps/api/src/notifications/notifications.repository.spec.ts \
  apps/api/src/notifications/ticket-watchers.repository.ts apps/api/src/notifications/ticket-watchers.repository.spec.ts \
  apps/api/test/integration/notifications/notifications-repository.integration.spec.ts
git commit -m "feat(notifications): contract types, Notification and TicketWatcher repositories (S4a §1, D501, D502)"
```

---

### Task A4: Preferences and eligibility (spec §2.1 steps 1-2, D503)

**Files:**
- Create: `apps/api/src/notifications/notification-preferences.service.ts`, `apps/api/src/notifications/notification-preferences.service.spec.ts`
- Create: `apps/api/src/notifications/notification-eligibility.ts`, `apps/api/src/notifications/notification-eligibility.spec.ts`

**Interfaces:**
- Consumes: `NotificationDraft`, `NotificationCategory`, `NotificationChannel`, `NOTIFICATION_CATEGORIES` (A3);
  `TRANSACTION_MANAGER` (`@nathapp/nestjs-data`).
- Produces (exact contract): `NotificationPreferencesService.disabledUserIds`, `.list`, `.update`;
  `NotificationEligibility.filter`, `.findGlobalAdminIds`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/notifications/notification-preferences.service.spec.ts`:

```ts
import { NotificationPreferencesService } from './notification-preferences.service';

function setup(rows: Array<{ userId?: string; category?: string; enabled?: boolean }> = []) {
  const notificationPreference = {
    findMany: jest.fn().mockResolvedValue(rows),
    upsert: jest.fn().mockResolvedValue({}),
  };
  const txManager = { run: jest.fn((fn: () => Promise<unknown>) => fn()), getClient: jest.fn(), isInTransaction: jest.fn(() => false) };
  const service = new NotificationPreferencesService({ client: { notificationPreference } } as never, txManager);
  return { service, notificationPreference, txManager };
}

describe('NotificationPreferencesService (S4a §2.1, D503)', () => {
  it('returns the users who switched the category off on the channel', async () => {
    const { service, notificationPreference } = setup([{ userId: 'u2' }]);
    const off = await service.disabledUserIds(['u1', 'u2'], 'WATCHED_ACTIVITY', 'IN_APP');
    expect([...off]).toEqual(['u2']);
    expect(notificationPreference.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u1', 'u2'] }, category: 'WATCHED_ACTIVITY', channel: 'IN_APP', enabled: false },
      select: { userId: true },
    });
  });

  it('asks nothing for no users', async () => {
    const { service, notificationPreference } = setup();
    expect((await service.disabledUserIds([], 'ASSIGNED', 'IN_APP')).size).toBe(0);
    expect(notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it('lists all five categories, defaulting to on', async () => {
    const { service } = setup([{ category: 'FLEET_HEALTH', enabled: false }]);
    await expect(service.list('u1')).resolves.toEqual([
      { category: 'ASSIGNED', inApp: true },
      { category: 'MENTIONED', inApp: true },
      { category: 'WATCHED_ACTIVITY', inApp: true },
      { category: 'FLEET_NEEDS_YOU', inApp: true },
      { category: 'FLEET_HEALTH', inApp: false },
    ]);
  });

  it('upserts the IN_APP rows in one transaction', async () => {
    const { service, notificationPreference, txManager } = setup();
    await service.update('u1', [{ category: 'ASSIGNED', inApp: false }, { category: 'FLEET_HEALTH', inApp: true }]);
    expect(txManager.run).toHaveBeenCalledTimes(1);
    expect(notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId_category_channel: { userId: 'u1', category: 'ASSIGNED', channel: 'IN_APP' } },
      create: { userId: 'u1', category: 'ASSIGNED', channel: 'IN_APP', enabled: false },
      update: { enabled: false },
    });
    expect(notificationPreference.upsert).toHaveBeenCalledTimes(2);
  });

  it('propagates a read failure instead of defaulting to on (spec §6)', async () => {
    const { service, notificationPreference } = setup();
    notificationPreference.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.disabledUserIds(['u1'], 'ASSIGNED', 'IN_APP')).rejects.toThrow('db down');
  });
});
```

`apps/api/src/notifications/notification-eligibility.spec.ts`:

```ts
import { NotificationEligibility } from './notification-eligibility';
import type { NotificationDraft } from './notification.types';

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

function setup() {
  const user = {
    findMany: jest.fn().mockImplementation(async ({ where }: { where: { id?: { in: string[] }; role?: string } }) => {
      if (where.role === 'ADMIN') return [{ id: 'admin' }];
      return [
        { id: 'member', role: 'MEMBER' },
        { id: 'admin', role: 'ADMIN' },
        { id: 'outsider', role: 'MEMBER' },
        { id: 'actor', role: 'MEMBER' },
      ].filter((u) => where.id?.in.includes(u.id));
    }),
  };
  const projectMember = { findMany: jest.fn().mockResolvedValue([{ projectId: 'p1', userId: 'member' }, { projectId: 'p1', userId: 'actor' }]) };
  const eligibility = new NotificationEligibility({ client: { user, projectMember } } as never);
  return { eligibility, user, projectMember };
}

describe('NotificationEligibility (S4a §2.1 step 1)', () => {
  it('drops the actor, disabled or unknown users, and non-member non-admins of the project', async () => {
    const { eligibility, user } = setup();
    const kept = await eligibility.filter([draft('member'), draft('admin'), draft('outsider'), draft('actor'), draft('disabled-or-gone')]);
    expect(kept.map((d) => d.userId)).toEqual(['member', 'admin']);
    expect(user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['member', 'admin', 'outsider', 'disabled-or-gone'] }, disabled: false },
      select: { id: true, role: true },
    });
  });

  it('keeps global drafts (projectId null) for any active user without a membership query', async () => {
    const { eligibility, projectMember } = setup();
    const kept = await eligibility.filter([draft('outsider', { projectId: null, actorId: null })]);
    expect(kept.map((d) => d.userId)).toEqual(['outsider']);
    expect(projectMember.findMany).not.toHaveBeenCalled();
  });

  it('returns nothing for nothing', async () => {
    const { eligibility, user } = setup();
    await expect(eligibility.filter([])).resolves.toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();
  });

  it('finds active global admins', async () => {
    const { eligibility, user } = setup();
    await expect(eligibility.findGlobalAdminIds()).resolves.toEqual(['admin']);
    expect(user.findMany).toHaveBeenCalledWith({ where: { role: 'ADMIN', disabled: false }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/notifications/notification-preferences.service.spec.ts src/notifications/notification-eligibility.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the preferences service** — `apps/api/src/notifications/notification-preferences.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NOTIFICATION_CATEGORIES, NotificationCategory, NotificationChannel } from './notification.types';

export interface PreferenceItem {
  category: NotificationCategory;
  inApp: boolean;
}

/** Fleet S4a §1 (D503): (user, category, channel) switches; a missing row means enabled. */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /** Throws on a read failure: the producer's outbox retry is safer than notifying someone who opted out. */
  async disabledUserIds(userIds: readonly string[], category: NotificationCategory, channel: NotificationChannel): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db.notificationPreference.findMany({
      where: { userId: { in: [...userIds] }, category, channel, enabled: false },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  async list(userId: string): Promise<readonly PreferenceItem[]> {
    const rows = await this.db.notificationPreference.findMany({
      where: { userId, channel: 'IN_APP' },
      select: { category: true, enabled: true },
    });
    const enabled = new Map(rows.map((r) => [r.category, r.enabled]));
    return NOTIFICATION_CATEGORIES.map((category) => ({ category, inApp: enabled.get(category) ?? true }));
  }

  async update(userId: string, changes: readonly PreferenceItem[]): Promise<void> {
    await this.txManager.run(async () => {
      for (const change of changes) {
        await this.db.notificationPreference.upsert({
          where: { userId_category_channel: { userId, category: change.category, channel: 'IN_APP' } },
          create: { userId, category: change.category, channel: 'IN_APP', enabled: change.inApp },
          update: { enabled: change.inApp },
        });
      }
    });
  }
}
```

The `list` spec stubs `findMany` with `{ category, enabled }` rows; the `disabledUserIds` spec stubs `{ userId }`
rows; both shapes come from the same mock — that is fine because each test only reads its own fields.

- [ ] **Step 4: Implement eligibility** — `apps/api/src/notifications/notification-eligibility.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { NotificationDraft } from './notification.types';

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Fleet S4a §2.1 step 1: who may receive a draft. Never the actor; never a disabled or unknown user
 * (agents are not users, so agent ids fall out here too); for a project-scoped draft, only a
 * project member or a global ADMIN. Two queries per call at most.
 */
@Injectable()
export class NotificationEligibility {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async filter(drafts: readonly NotificationDraft[]): Promise<readonly NotificationDraft[]> {
    const candidates = drafts.filter((d) => d.userId !== d.actorId);
    if (candidates.length === 0) return [];
    const userIds = unique(candidates.map((d) => d.userId));
    const users = await this.db.user.findMany({ where: { id: { in: userIds }, disabled: false }, select: { id: true, role: true } });
    const roleOf = new Map(users.map((u) => [u.id, u.role]));
    const projectIds = unique(candidates.flatMap((d) => (d.projectId ? [d.projectId] : [])));
    const memberships = projectIds.length === 0
      ? []
      : await this.db.projectMember.findMany({
        where: { projectId: { in: projectIds }, userId: { in: userIds } },
        select: { projectId: true, userId: true },
      });
    const isMember = new Set(memberships.map((m) => `${m.projectId}:${m.userId}`));
    return candidates.filter((d) => {
      const role = roleOf.get(d.userId);
      if (role === undefined) return false;
      if (d.projectId === null || role === 'ADMIN') return true;
      return isMember.has(`${d.projectId}:${d.userId}`);
    });
  }

  async findGlobalAdminIds(): Promise<readonly string[]> {
    const rows = await this.db.user.findMany({ where: { role: 'ADMIN', disabled: false }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => r.id);
  }
}
```

The eligibility spec's `projectMember.findMany` mock returns a fixed list; `outsider` is absent from it, which is
what drops them.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/api && bunx jest src/notifications/notification-preferences.service.spec.ts src/notifications/notification-eligibility.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications/notification-preferences.service.ts apps/api/src/notifications/notification-preferences.service.spec.ts \
  apps/api/src/notifications/notification-eligibility.ts apps/api/src/notifications/notification-eligibility.spec.ts
git commit -m "feat(notifications): preferences and recipient eligibility (S4a §2.1, D503)"
```

---
### Task A5: Ticket notification text and the `NotificationWriter` (spec §2.1, D501, D510)

**Files:**
- Create: `apps/api/src/notifications/ticket-notification-text.ts`, `apps/api/src/notifications/ticket-notification-text.spec.ts`
- Create: `apps/api/src/notifications/notification-writer.ts`, `apps/api/src/notifications/notification-writer.spec.ts`

**Interfaces:**
- Consumes: `NotificationDraft`, `NotificationCategory`, `truncate`, `TITLE_MAX`, `BODY_MAX` (A3);
  `NotificationEligibility.filter` and `NotificationPreferencesService.disabledUserIds` (A4);
  `NotificationsRepository.insertMany` (A3); `UserEventBus.publish` (A2).
- Produces: `NotificationWriter.deliver(drafts: readonly NotificationDraft[]): Promise<number>` (contract);
  `TicketNotificationKind = 'ticket_assigned' | 'ticket_mentioned' | 'ticket_commented' | 'ticket_status_changed'`;
  `TICKET_KIND_CATEGORY: Readonly<Record<TicketNotificationKind, NotificationCategory>>`;
  `TicketDraftInput` and `ticketDraft(input: TicketDraftInput): NotificationDraft` (below). Part C reuses
  `ticketDraft` with kind `ticket_mentioned`.

```ts
export interface TicketDraftInput {
  kind: TicketNotificationKind;
  userId: string;
  eventId: string;          // TicketEvent id = sourceId
  actorId: string;
  projectId: string;
  slug: string;
  ref: string;              // KEY-N
  ticketTitle: string;
  actorName: string;
  excerpt: string | null;   // comment body or description (mentions, comments)
  fromStatus?: string;      // ticket_status_changed only
  newStatus?: string;
}
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/notifications/ticket-notification-text.spec.ts`:

```ts
import { ticketDraft, TicketDraftInput } from './ticket-notification-text';

const input = (over: Partial<TicketDraftInput> = {}): TicketDraftInput => ({
  kind: 'ticket_assigned', userId: 'u1', eventId: 'evt-1', actorId: 'u2', projectId: 'p1', slug: 'koda', ref: 'KODA-12',
  ticketTitle: 'Fix login', actorName: 'Alice', excerpt: null, ...over,
});

describe('ticketDraft (S4a kinds table)', () => {
  it('builds an assignment', () => {
    expect(ticketDraft(input())).toEqual({
      userId: 'u1', projectId: 'p1', category: 'ASSIGNED', kind: 'ticket_assigned',
      title: 'Alice assigned you KODA-12: Fix login', body: null, link: '/koda/tickets/KODA-12',
      params: { ref: 'KODA-12', ticketTitle: 'Fix login', actorName: 'Alice' },
      sourceType: 'ticket_event', sourceId: 'evt-1', actorId: 'u2',
    });
  });

  it('builds a mention, a comment and a status change', () => {
    expect(ticketDraft(input({ kind: 'ticket_mentioned', excerpt: 'hey @x look' }))).toMatchObject({
      category: 'MENTIONED', title: 'Alice mentioned you on KODA-12', body: 'hey @x look',
    });
    expect(ticketDraft(input({ kind: 'ticket_commented', excerpt: 'done' }))).toMatchObject({
      category: 'WATCHED_ACTIVITY', title: 'Alice commented on KODA-12', body: 'done',
    });
    expect(ticketDraft(input({ kind: 'ticket_status_changed', fromStatus: 'VERIFIED', newStatus: 'IN_PROGRESS' }))).toMatchObject({
      category: 'WATCHED_ACTIVITY', title: 'KODA-12 moved VERIFIED → IN_PROGRESS', body: 'Fix login',
      params: { ref: 'KODA-12', ticketTitle: 'Fix login', actorName: 'Alice', fromStatus: 'VERIFIED', newStatus: 'IN_PROGRESS' },
    });
  });

  it('truncates a long title and a long excerpt (Review Focus 4)', () => {
    const draft = ticketDraft(input({ kind: 'ticket_commented', ticketTitle: 'T'.repeat(500), excerpt: `${'word '.repeat(400)}end` }));
    expect(draft.title.length).toBeLessThanOrEqual(200);
    expect(draft.body?.length).toBeLessThanOrEqual(280);
    expect(draft.body?.endsWith('…')).toBe(true);
    const assigned = ticketDraft(input({ ticketTitle: 'T'.repeat(500) }));
    expect(assigned.title).toHaveLength(200);
    expect(String(assigned.params.ticketTitle).length).toBeLessThanOrEqual(200);
  });
});
```

`apps/api/src/notifications/notification-writer.spec.ts`:

```ts
import { NotificationWriter } from './notification-writer';
import { ticketDraft } from './ticket-notification-text';
import type { NotificationDraft } from './notification.types';
import { UserEventBus } from '../live/user-event-bus';

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

function setup() {
  const order: string[] = [];
  const eligibility = { filter: jest.fn(async (d: readonly NotificationDraft[]) => d.filter((x) => x.userId !== 'ineligible')) };
  const preferences = { disabledUserIds: jest.fn(async () => new Set(['muted-pref'])) };
  const repo = {
    insertMany: jest.fn(async (d: readonly NotificationDraft[]) => {
      order.push('insert');
      return d.map((x, i) => ({ id: `n${i}`, userId: x.userId }));
    }),
  };
  const bus = new UserEventBus();
  jest.spyOn(bus, 'publish').mockImplementation(() => { order.push('publish'); });
  const writer = new NotificationWriter(eligibility as never, preferences as never, repo as never, bus);
  return { writer, eligibility, preferences, repo, bus, order };
}

describe('NotificationWriter (S4a §2.1)', () => {
  it('filters eligibility, then preferences per category, inserts, then publishes each inserted row', async () => {
    const { writer, preferences, repo, bus, order } = setup();
    const count = await writer.deliver([draft('a'), draft('ineligible'), draft('muted-pref'), draft('b', { category: 'ASSIGNED', kind: 'ticket_assigned' })]);
    expect(count).toBe(2);
    expect(preferences.disabledUserIds).toHaveBeenCalledWith(['a', 'muted-pref'], 'WATCHED_ACTIVITY', 'IN_APP');
    expect(preferences.disabledUserIds).toHaveBeenCalledWith(['b'], 'ASSIGNED', 'IN_APP');
    expect(repo.insertMany.mock.calls[0][0].map((d: NotificationDraft) => d.userId)).toEqual(['a', 'b']);
    expect(bus.publish).toHaveBeenCalledWith({ type: 'notification', userId: 'a', id: 'n0', at: expect.any(String) });
    expect(order).toEqual(['insert', 'publish', 'publish']);
  });

  it('publishes nothing when the insert added no rows (redelivery)', async () => {
    const { writer, repo, bus } = setup();
    repo.insertMany.mockResolvedValueOnce([]);
    await expect(writer.deliver([draft('a')])).resolves.toBe(0);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does nothing for no drafts', async () => {
    const { writer, eligibility } = setup();
    await expect(writer.deliver([])).resolves.toBe(0);
    expect(eligibility.filter).not.toHaveBeenCalled();
  });

  it('propagates a database failure so the outbox retries', async () => {
    const { writer, repo } = setup();
    repo.insertMany.mockRejectedValueOnce(new Error('db down'));
    await expect(writer.deliver([draft('a')])).rejects.toThrow('db down');
  });

  it('truncates: a draft built from a huge title and comment inserts without error (Review Focus 4)', async () => {
    const { writer, repo } = setup();
    const huge = ticketDraft({
      kind: 'ticket_commented', userId: 'a', eventId: 'e9', actorId: 'actor', projectId: 'p1', slug: 's', ref: 'S-1',
      ticketTitle: 'x'.repeat(5000), actorName: 'y'.repeat(300), excerpt: 'z'.repeat(100_000),
    });
    await expect(writer.deliver([huge])).resolves.toBe(1);
    const inserted = repo.insertMany.mock.calls[0][0][0] as NotificationDraft;
    expect(inserted.title.length).toBeLessThanOrEqual(200);
    expect((inserted.body ?? '').length).toBeLessThanOrEqual(280);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/notifications/ticket-notification-text.spec.ts src/notifications/notification-writer.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the text builder** — `apps/api/src/notifications/ticket-notification-text.ts`:

```ts
import { BODY_MAX, NotificationCategory, NotificationDraft, TITLE_MAX, truncate } from './notification.types';

export type TicketNotificationKind = 'ticket_assigned' | 'ticket_mentioned' | 'ticket_commented' | 'ticket_status_changed';

export const TICKET_KIND_CATEGORY: Readonly<Record<TicketNotificationKind, NotificationCategory>> = Object.freeze({
  ticket_assigned: 'ASSIGNED',
  ticket_mentioned: 'MENTIONED',
  ticket_commented: 'WATCHED_ACTIVITY',
  ticket_status_changed: 'WATCHED_ACTIVITY',
});

export interface TicketDraftInput {
  kind: TicketNotificationKind;
  userId: string;
  eventId: string;
  actorId: string;
  projectId: string;
  slug: string;
  ref: string;
  ticketTitle: string;
  actorName: string;
  excerpt: string | null;
  fromStatus?: string;
  newStatus?: string;
}

const NAME_MAX = 80;

function englishTitle(kind: TicketNotificationKind, p: { ref: string; ticketTitle: string; actorName: string; fromStatus?: string; newStatus?: string }): string {
  switch (kind) {
    case 'ticket_assigned': return `${p.actorName} assigned you ${p.ref}: ${p.ticketTitle}`;
    case 'ticket_mentioned': return `${p.actorName} mentioned you on ${p.ref}`;
    case 'ticket_commented': return `${p.actorName} commented on ${p.ref}`;
    case 'ticket_status_changed': return `${p.ref} moved ${p.fromStatus ?? '?'} → ${p.newStatus ?? '?'}`;
  }
}

function englishBody(input: TicketDraftInput, ticketTitle: string): string | null {
  switch (input.kind) {
    case 'ticket_assigned': return null;
    case 'ticket_status_changed': return truncate(ticketTitle, BODY_MAX);
    default: return input.excerpt === null ? null : truncate(input.excerpt, BODY_MAX);
  }
}

/**
 * Fleet S4a kinds table: one ticket notification draft. English `title`/`body` are the CLI fallback; the
 * web renders from `kind` + `params` (spec §1). Everything user-written is truncated (D510).
 */
export function ticketDraft(input: TicketDraftInput): NotificationDraft {
  const ticketTitle = truncate(input.ticketTitle, TITLE_MAX);
  const actorName = truncate(input.actorName, NAME_MAX);
  const status = input.kind === 'ticket_status_changed'
    ? { fromStatus: input.fromStatus ?? '?', newStatus: input.newStatus ?? '?' }
    : {};
  const params = { ref: input.ref, ticketTitle, actorName, ...status };
  return {
    userId: input.userId,
    projectId: input.projectId,
    category: TICKET_KIND_CATEGORY[input.kind],
    kind: input.kind,
    title: truncate(englishTitle(input.kind, { ...params }), TITLE_MAX),
    body: englishBody(input, ticketTitle),
    link: `/${input.slug}/tickets/${input.ref}`,
    params,
    sourceType: 'ticket_event',
    sourceId: input.eventId,
    actorId: input.actorId,
  };
}
```

- [ ] **Step 4: Implement the writer** — `apps/api/src/notifications/notification-writer.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { UserEventBus } from '../live/user-event-bus';
import { NotificationEligibility } from './notification-eligibility';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsRepository } from './notifications.repository';
import type { NotificationCategory, NotificationDraft } from './notification.types';

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Fleet S4a §2.1: the only writer of notifications. Eligibility, then IN_APP preferences per category,
 * then one idempotent insert (D501), then a content-free live signal per inserted row. Throws only
 * when the database does, so an outbox handler that calls it is retried.
 */
@Injectable()
export class NotificationWriter {
  constructor(
    private readonly eligibility: NotificationEligibility,
    private readonly preferences: NotificationPreferencesService,
    private readonly repo: NotificationsRepository,
    private readonly bus: UserEventBus,
  ) {}

  async deliver(drafts: readonly NotificationDraft[]): Promise<number> {
    if (drafts.length === 0) return 0;
    const eligible = await this.eligibility.filter(drafts);
    const allowed = await this.applyPreferences(eligible);
    const inserted = await this.repo.insertMany(allowed);
    const at = new Date().toISOString();
    for (const row of inserted) this.bus.publish({ type: 'notification', userId: row.userId, id: row.id, at });
    return inserted.length;
  }

  private async applyPreferences(drafts: readonly NotificationDraft[]): Promise<readonly NotificationDraft[]> {
    if (drafts.length === 0) return [];
    const categories = unique(drafts.map((d) => d.category));
    const off = new Map<NotificationCategory, ReadonlySet<string>>(await Promise.all(categories.map(async (category) => {
      const userIds = unique(drafts.filter((d) => d.category === category).map((d) => d.userId));
      return [category, await this.preferences.disabledUserIds(userIds, category, 'IN_APP')] as const;
    })));
    return drafts.filter((d) => !off.get(d.category)?.has(d.userId));
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/api && bunx jest src/notifications/ticket-notification-text.spec.ts src/notifications/notification-writer.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications/ticket-notification-text.ts apps/api/src/notifications/ticket-notification-text.spec.ts \
  apps/api/src/notifications/notification-writer.ts apps/api/src/notifications/notification-writer.spec.ts
git commit -m "feat(notifications): ticket notification text and NotificationWriter (S4a §2.1)"
```

---
### Task A6: Ticket producers — rules, reads and `TicketNotificationSubscriber` (spec §2.2, D502)

**Files:**
- Create: `apps/api/src/notifications/ticket-notification.rules.ts`, `apps/api/src/notifications/ticket-notification.rules.spec.ts`
- Create: `apps/api/src/notifications/ticket-notification-reads.repository.ts`
- Create: `apps/api/src/notifications/ticket-mention.resolver.ts`
- Create: `apps/api/src/notifications/ticket-notification.subscriber.ts`, `apps/api/src/notifications/ticket-notification.subscriber.spec.ts`
- Modify: `apps/api/src/tickets/tickets.service.ts:366-370` (the `assigned` event data)
- Modify: `apps/api/src/tickets/tickets.service.spec.ts:1098`
- Modify: `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts:290`

**Interfaces:**
- Consumes: `FanOutPublisher.register` (existing); `TicketWatchersRepository.ensure`, `.findUnmutedUserIds` (A3);
  `ticketDraft`, `TicketNotificationKind` (A5); `NotificationWriter.deliver` (A5).
- Produces:
  - `HANDLED_TICKET_ACTIONS: ReadonlySet<string>` = `TICKET_CREATED`, `assigned`, `COMMENT_ADDED`, `status_changed`.
  - `TicketEventFacts`, `TicketRecipient`, `watchEntries(facts)`, `ticketRecipients(facts, unmutedWatcherIds)`
    (pure; signatures below). Part C extends `HANDLED_TICKET_ACTIONS` with `TICKET_UPDATED`.
  - `TicketEnvelope`, `parseTicketEnvelope(payload: unknown): TicketEnvelope | null`.
  - `TicketNotificationReadsRepository` with `findTicket`, `findComment`, `actorName`, `isUser`.
  - **Part C seam:** `TicketMentionResolver.mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]>`
    — returns `[]` in Part A. Part C replaces the body (parse tokens, keep project members and global admins) and
    must keep the signature. The subscriber already calls it for `TICKET_CREATED` (ticket description) and
    `COMMENT_ADDED` (comment body).
  - `TicketNotificationSubscriber` with public `readonly handle: (payload: unknown) => Promise<void>` (integration
    tests call it directly to replay a payload).
  - `ticket_event` `assigned` data gains `assigneeType: 'user' | 'agent' | null`.

```ts
export type HandledTicketAction = 'TICKET_CREATED' | 'assigned' | 'COMMENT_ADDED' | 'status_changed';
export interface TicketEventFacts {
  action: HandledTicketAction;
  reporterId: string | null;        // TICKET_CREATED: Ticket.createdByUserId
  assigneeUserId: string | null;    // assigned: the new user assignee (never an agent)
  commentAuthorId: string | null;   // COMMENT_ADDED: Comment.authorUserId
  mentionedIds: readonly string[];  // from TicketMentionResolver
}
export interface TicketRecipient { userId: string; kind: TicketNotificationKind }
export function watchEntries(facts: TicketEventFacts): readonly { userId: string; reason: WatchReason }[];
export function ticketRecipients(facts: TicketEventFacts, unmutedWatcherIds: readonly string[]): readonly TicketRecipient[];
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/notifications/ticket-notification.rules.spec.ts`:

```ts
import { ticketRecipients, TicketEventFacts, watchEntries } from './ticket-notification.rules';

const facts = (over: Partial<TicketEventFacts>): TicketEventFacts => ({
  action: 'COMMENT_ADDED', reporterId: null, assigneeUserId: null, commentAuthorId: null, mentionedIds: [], ...over,
});

describe('ticket notification rules (S4a §2.2)', () => {
  it.each([
    ['TICKET_CREATED', facts({ action: 'TICKET_CREATED', reporterId: 'r', mentionedIds: ['m'] }), [{ userId: 'r', reason: 'REPORTER' }, { userId: 'm', reason: 'MENTIONED' }]],
    ['assigned', facts({ action: 'assigned', assigneeUserId: 'a' }), [{ userId: 'a', reason: 'ASSIGNEE' }]],
    ['assigned to nobody/agent', facts({ action: 'assigned' }), []],
    ['COMMENT_ADDED', facts({ commentAuthorId: 'c', mentionedIds: ['m'] }), [{ userId: 'c', reason: 'COMMENTER' }, { userId: 'm', reason: 'MENTIONED' }]],
    ['COMMENT_ADDED by an agent', facts({ commentAuthorId: null }), []],
    ['status_changed', facts({ action: 'status_changed' }), []],
  ])('watch entries for %s', (_name, f, expected) => {
    expect(watchEntries(f)).toEqual(expected);
  });

  it('assignment notifies the assignee only, whatever the watchers', () => {
    expect(ticketRecipients(facts({ action: 'assigned', assigneeUserId: 'a' }), ['w1', 'a'])).toEqual([{ userId: 'a', kind: 'ticket_assigned' }]);
  });

  it('a comment notifies mentions as MENTIONED and other unmuted watchers as WATCHED_ACTIVITY, one each', () => {
    expect(ticketRecipients(facts({ commentAuthorId: 'c', mentionedIds: ['m', 'w2'] }), ['c', 'w1', 'w2'])).toEqual([
      { userId: 'm', kind: 'ticket_mentioned' },
      { userId: 'w2', kind: 'ticket_mentioned' },
      { userId: 'c', kind: 'ticket_commented' },
      { userId: 'w1', kind: 'ticket_commented' },
    ]);
  });

  it('a mention reaches a muted watcher (muted users are absent from the watcher list but present in mentions)', () => {
    expect(ticketRecipients(facts({ mentionedIds: ['muted'] }), [])).toEqual([{ userId: 'muted', kind: 'ticket_mentioned' }]);
  });

  it('a status change notifies unmuted watchers; creation notifies mentions only', () => {
    expect(ticketRecipients(facts({ action: 'status_changed' }), ['w1', 'w1', 'w2'])).toEqual([
      { userId: 'w1', kind: 'ticket_status_changed' },
      { userId: 'w2', kind: 'ticket_status_changed' },
    ]);
    expect(ticketRecipients(facts({ action: 'TICKET_CREATED', reporterId: 'r', mentionedIds: ['m'] }), ['r'])).toEqual([
      { userId: 'm', kind: 'ticket_mentioned' },
    ]);
  });
});
```

`apps/api/src/notifications/ticket-notification.subscriber.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors } from '../../test/helpers/outbox-record';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';
import type { NotificationDraft } from './notification.types';

const envelope = (action: string, data: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: 'evt-1', type: 'ticket_event', action, timestamp: '2026-10-09T00:00:00.000Z', ticketId: 't1', projectId: 'p1',
  actorId: 'actor', actorType: 'user', data, ...over,
});

const TICKET = {
  id: 't1', projectId: 'p1', number: 12, title: 'Fix login', description: 'desc', createdByUserId: 'reporter', deletedAt: null,
  project: { key: 'KODA', slug: 'koda' },
};

function setup() {
  const registry = new FanOutPublisher(noopLastErrors);
  const reads = {
    findTicket: jest.fn().mockResolvedValue(TICKET),
    findComment: jest.fn().mockResolvedValue({ id: 'c1', ticketId: 't1', body: 'looks good', authorUserId: 'actor' }),
    actorName: jest.fn().mockResolvedValue('Alice'),
    isUser: jest.fn().mockResolvedValue(true),
  };
  const watchers = { ensure: jest.fn().mockResolvedValue(undefined), findUnmutedUserIds: jest.fn().mockResolvedValue(['reporter', 'actor', 'w1']) };
  const mentions = { mentionedUserIds: jest.fn().mockResolvedValue([]) };
  const writer = { deliver: jest.fn().mockResolvedValue(1) };
  const sub = new TicketNotificationSubscriber(registry, reads as never, watchers as never, mentions as never, writer as never);
  sub.onModuleInit();
  const delivered = (): NotificationDraft[] => writer.deliver.mock.calls.flatMap((c) => c[0] as NotificationDraft[]);
  return { registry, reads, watchers, mentions, writer, sub, delivered };
}

describe('TicketNotificationSubscriber (S4a §2.2)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('registers on ticket_event at init', () => {
    const { registry, sub } = setup();
    expect(registry.getHandlers('ticket_event')).toContain(sub.handle);
  });

  it('assigned to a user: watches as ASSIGNEE, then notifies the assignee', async () => {
    const { sub, watchers, delivered } = setup();
    await sub.handle(envelope('assigned', { assignedTo: 'bob', assigneeType: 'user' }));
    expect(watchers.ensure).toHaveBeenCalledWith('t1', [{ userId: 'bob', reason: 'ASSIGNEE' }]);
    expect(delivered()).toEqual([expect.objectContaining({
      userId: 'bob', kind: 'ticket_assigned', category: 'ASSIGNED', link: '/koda/tickets/KODA-12', sourceId: 'evt-1', actorId: 'actor',
      title: 'Alice assigned you KODA-12: Fix login',
    })]);
  });

  it('assigned to an agent, or unassigned: nothing', async () => {
    const { sub, writer, watchers } = setup();
    await sub.handle(envelope('assigned', { assignedTo: 'agent-1', assigneeType: 'agent' }));
    await sub.handle(envelope('assigned', { assignedTo: null, assigneeType: null }));
    expect(watchers.ensure).toHaveBeenCalledWith('t1', []);
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('a legacy assigned event without assigneeType asks whether the id is a user', async () => {
    const { sub, reads, delivered } = setup();
    reads.isUser.mockResolvedValueOnce(false);
    await sub.handle(envelope('assigned', { assignedTo: 'agent-1' }));
    expect(reads.isUser).toHaveBeenCalledWith('agent-1');
    expect(delivered()).toEqual([]);
  });

  it('a comment: watches the author, notifies unmuted watchers with the excerpt', async () => {
    const { sub, watchers, reads, delivered, mentions } = setup();
    await sub.handle(envelope('COMMENT_ADDED', { commentId: 'c1' }));
    expect(reads.findComment).toHaveBeenCalledWith('c1');
    expect(mentions.mentionedUserIds).toHaveBeenCalledWith('p1', 'looks good');
    expect(watchers.ensure).toHaveBeenCalledWith('t1', [{ userId: 'actor', reason: 'COMMENTER' }]);
    expect(delivered().map((d) => [d.userId, d.kind, d.body])).toEqual([
      ['reporter', 'ticket_commented', 'looks good'],
      ['actor', 'ticket_commented', 'looks good'],
      ['w1', 'ticket_commented', 'looks good'],
    ]);
  });

  it('a status change notifies unmuted watchers', async () => {
    const { sub, delivered } = setup();
    await sub.handle(envelope('status_changed', { fromStatus: 'CREATED', newStatus: 'VERIFIED' }));
    expect(delivered().map((d) => d.title)).toEqual(Array(3).fill('KODA-12 moved CREATED → VERIFIED'));
  });

  it('creation watches the reporter and notifies nobody without mentions', async () => {
    const { sub, watchers, writer, mentions } = setup();
    await sub.handle(envelope('TICKET_CREATED', { type: 'BUG', title: 'Fix login' }));
    expect(mentions.mentionedUserIds).toHaveBeenCalledWith('p1', 'desc');
    expect(watchers.ensure).toHaveBeenCalledWith('t1', [{ userId: 'reporter', reason: 'REPORTER' }]);
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('deleted ticket: no watcher, no notification, no throw (Review Focus 1)', async () => {
    const { sub, reads, watchers, writer } = setup();
    reads.findTicket.mockResolvedValueOnce({ ...TICKET, deletedAt: new Date() });
    await expect(sub.handle(envelope('COMMENT_ADDED', { commentId: 'c1' }))).resolves.toBeUndefined();
    reads.findTicket.mockResolvedValueOnce(null);
    await expect(sub.handle(envelope('status_changed', { fromStatus: 'A', newStatus: 'B' }))).resolves.toBeUndefined();
    expect(watchers.ensure).not.toHaveBeenCalled();
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('deleted comment or a comment of another ticket: nothing, no throw', async () => {
    const { sub, reads, writer } = setup();
    reads.findComment.mockResolvedValueOnce(null);
    await sub.handle(envelope('COMMENT_ADDED', { commentId: 'gone' }));
    reads.findComment.mockResolvedValueOnce({ id: 'c2', ticketId: 'other', body: 'x', authorUserId: 'u' });
    await sub.handle(envelope('COMMENT_ADDED', { commentId: 'c2' }));
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('skips malformed payloads and unhandled actions without reading anything', async () => {
    const { sub, reads } = setup();
    await sub.handle(null);
    await sub.handle({ action: 'assigned' });
    await sub.handle(envelope('TICKET_DELETED'));
    expect(reads.findTicket).not.toHaveBeenCalled();
  });

  it('propagates a database failure so the outbox retries', async () => {
    const { sub, writer } = setup();
    writer.deliver.mockRejectedValueOnce(new Error('db down'));
    await expect(sub.handle(envelope('status_changed', { fromStatus: 'A', newStatus: 'B' }))).rejects.toThrow('db down');
  });
});
```

In `apps/api/src/tickets/tickets.service.spec.ts:1098` change `data: { assignedTo: 'user-456' },` to
`data: { assignedTo: 'user-456', assigneeType: 'user' },`.

In `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts:290` change
`data: { assignedTo: adminUserId },` to `data: { assignedTo: adminUserId, assigneeType: 'user' },`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/notifications/ticket-notification src/tickets/tickets.service.spec.ts`
Expected: FAIL — rules/subscriber modules not found; the H13 assign test fails on the missing `assigneeType`.

- [ ] **Step 3: Record the assignee type** — in `apps/api/src/tickets/tickets.service.ts` replace the `assigned`
event data (inside `assign`, ~line 368):

```ts
        await this.recordTicketEvent(ticket.id, project.id, 'assigned', principal, {
          assignedTo: assignInput.userId ?? assignInput.agentId ?? null,
          // S4a §2.2: the notification producer must not guess whether the id is a user or an agent.
          assigneeType: assignInput.userId ? 'user' : assignInput.agentId ? 'agent' : null,
        });
```

- [ ] **Step 4: Implement the pure rules** — `apps/api/src/notifications/ticket-notification.rules.ts`:

```ts
import type { WatchReason } from './notification.types';
import type { TicketNotificationKind } from './ticket-notification-text';

export type HandledTicketAction = 'TICKET_CREATED' | 'assigned' | 'COMMENT_ADDED' | 'status_changed';

export const HANDLED_TICKET_ACTIONS: ReadonlySet<string> = new Set<HandledTicketAction>(['TICKET_CREATED', 'assigned', 'COMMENT_ADDED', 'status_changed']);

export interface TicketEventFacts {
  action: HandledTicketAction;
  reporterId: string | null;
  assigneeUserId: string | null;
  commentAuthorId: string | null;
  mentionedIds: readonly string[];
}

export interface TicketRecipient {
  userId: string;
  kind: TicketNotificationKind;
}

const watch = (userId: string | null, reason: WatchReason) => (userId ? [{ userId, reason }] : []);
const mentioned = (f: TicketEventFacts) => f.mentionedIds.map((userId) => ({ userId, reason: 'MENTIONED' as const }));

/** S4a §2.2: who becomes a watcher because of this event (insert-if-absent; D502). */
export function watchEntries(f: TicketEventFacts): readonly { userId: string; reason: WatchReason }[] {
  switch (f.action) {
    case 'TICKET_CREATED': return [...watch(f.reporterId, 'REPORTER'), ...mentioned(f)];
    case 'assigned': return watch(f.assigneeUserId, 'ASSIGNEE');
    case 'COMMENT_ADDED': return [...watch(f.commentAuthorId, 'COMMENTER'), ...mentioned(f)];
    case 'status_changed': return [];
  }
}

/**
 * S4a §2.2: one notification per user per event, priority ASSIGNED > MENTIONED > WATCHED_ACTIVITY.
 * Assignment and mentions ignore mute (callers pass mentions separately); watched activity uses only
 * the unmuted watcher list. The actor is dropped later by NotificationEligibility.
 */
export function ticketRecipients(f: TicketEventFacts, unmutedWatcherIds: readonly string[]): readonly TicketRecipient[] {
  const direct: TicketRecipient[] = f.action === 'assigned'
    ? (f.assigneeUserId ? [{ userId: f.assigneeUserId, kind: 'ticket_assigned' }] : [])
    : f.mentionedIds.map((userId) => ({ userId, kind: 'ticket_mentioned' as const }));
  const activityKind: TicketNotificationKind | null =
    f.action === 'COMMENT_ADDED' ? 'ticket_commented' : f.action === 'status_changed' ? 'ticket_status_changed' : null;
  const activity: TicketRecipient[] = activityKind === null ? [] : unmutedWatcherIds.map((userId) => ({ userId, kind: activityKind }));
  return [...direct, ...activity].reduce<TicketRecipient[]>(
    (acc, r) => (acc.some((x) => x.userId === r.userId) ? acc : [...acc, r]),
    [],
  );
}
```

- [ ] **Step 5: Implement the reads and the mention seam**

`apps/api/src/notifications/ticket-notification-reads.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';

export interface TicketForNotification {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string | null;
  createdByUserId: string | null;
  deletedAt: Date | null;
  project: { key: string; slug: string };
}

export interface CommentForNotification {
  id: string;
  ticketId: string;
  body: string;
  authorUserId: string | null;
}

/** Fleet S4a §2.2: what the ticket producer reads. Comments are hard-deleted, so a missing row means deleted. */
@Injectable()
export class TicketNotificationReadsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findTicket(ticketId: string): Promise<TicketForNotification | null> {
    return this.db.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true, projectId: true, number: true, title: true, description: true, createdByUserId: true, deletedAt: true,
        project: { select: { key: true, slug: true } },
      },
    });
  }

  findComment(commentId: string): Promise<CommentForNotification | null> {
    return this.db.comment.findUnique({ where: { id: commentId }, select: { id: true, ticketId: true, body: true, authorUserId: true } });
  }

  /** Display name for the kinds table: user name, else email local part; agent name. Never an email address. */
  async actorName(actorId: string, actorType: 'user' | 'agent'): Promise<string> {
    if (actorType === 'agent') {
      const agent = await this.db.agent.findUnique({ where: { id: actorId }, select: { name: true } });
      return agent?.name ?? 'An agent';
    }
    const user = await this.db.user.findUnique({ where: { id: actorId }, select: { name: true, email: true } });
    if (!user) return 'Someone';
    return user.name?.trim() || user.email.split('@')[0];
  }

  async isUser(id: string): Promise<boolean> {
    return (await this.db.user.count({ where: { id } })) === 1;
  }
}
```

`apps/api/src/notifications/ticket-mention.resolver.ts`:

```ts
import { Injectable } from '@nestjs/common';

/**
 * Fleet S4a §2.3 seam. Part A ships no mention parsing: every call returns no ids. Part C (slice 3)
 * replaces the body with `@[label](user:<id>)` parsing filtered to project members and global admins,
 * keeping this signature.
 */
@Injectable()
export class TicketMentionResolver {
  async mentionedUserIds(_projectId: string, _text: string | null): Promise<readonly string[]> {
    return [];
  }
}
```

- [ ] **Step 6: Implement the subscriber** — `apps/api/src/notifications/ticket-notification.subscriber.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { NotificationWriter } from './notification-writer';
import { TicketMentionResolver } from './ticket-mention.resolver';
import { TicketForNotification, TicketNotificationReadsRepository } from './ticket-notification-reads.repository';
import { HANDLED_TICKET_ACTIONS, HandledTicketAction, TicketEventFacts, ticketRecipients, watchEntries } from './ticket-notification.rules';
import { ticketDraft } from './ticket-notification-text';
import { TicketWatchersRepository } from './ticket-watchers.repository';

export interface TicketEnvelope {
  id: string;
  action: string;
  ticketId: string;
  projectId: string;
  actorId: string;
  actorType: 'user' | 'agent';
  data: Readonly<Record<string, unknown>>;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The `ticket_event` envelope (buildTicketEventOutboxPayload); null when a required field is missing. */
export function parseTicketEnvelope(payload: unknown): TicketEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (!str(p.id) || !str(p.action) || !str(p.ticketId) || !str(p.projectId) || !str(p.actorId)) return null;
  if (p.actorType !== 'user' && p.actorType !== 'agent') return null;
  const data = typeof p.data === 'object' && p.data !== null && !Array.isArray(p.data) ? (p.data as Record<string, unknown>) : {};
  return { id: p.id, action: p.action, ticketId: p.ticketId, projectId: p.projectId, actorId: p.actorId, actorType: p.actorType, data };
}

interface EventContext {
  facts: TicketEventFacts;
  excerpt: string | null;
}

/**
 * Fleet S4a §2.2: ticket_event → watchers, then notifications. Watchers are written before recipients
 * are resolved, in the same handler, so an outbox retry repeats both (both idempotent). Throws only on
 * database failure; a deleted ticket or comment ends the handler quietly (Review Focus 1).
 */
@Injectable()
export class TicketNotificationSubscriber implements OnModuleInit {
  private readonly logger = new Logger(TicketNotificationSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reads: TicketNotificationReadsRepository,
    private readonly watchers: TicketWatchersRepository,
    private readonly mentions: TicketMentionResolver,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const event = parseTicketEnvelope(payload);
    if (!event) {
      this.logger.warn('Skipped a malformed ticket_event payload');
      return;
    }
    if (!HANDLED_TICKET_ACTIONS.has(event.action)) return;
    const ticket = await this.reads.findTicket(event.ticketId);
    if (!ticket || ticket.deletedAt) return;
    const context = await this.contextFor(event, ticket);
    if (!context) return;
    await this.watchers.ensure(ticket.id, watchEntries(context.facts));
    const recipients = ticketRecipients(context.facts, await this.watchers.findUnmutedUserIds(ticket.id));
    if (recipients.length === 0) return;
    const actorName = await this.reads.actorName(event.actorId, event.actorType);
    const ref = `${ticket.project.key}-${ticket.number}`;
    await this.writer.deliver(recipients.map((r) => ticketDraft({
      kind: r.kind, userId: r.userId, eventId: event.id, actorId: event.actorId, projectId: ticket.projectId,
      slug: ticket.project.slug, ref, ticketTitle: ticket.title, actorName, excerpt: context.excerpt,
      fromStatus: str(event.data.fromStatus) ? event.data.fromStatus : undefined,
      newStatus: str(event.data.newStatus) ? event.data.newStatus : undefined,
    })));
  };

  private async contextFor(event: TicketEnvelope, ticket: TicketForNotification): Promise<EventContext | null> {
    const base = { action: event.action as HandledTicketAction, reporterId: null, assigneeUserId: null, commentAuthorId: null, mentionedIds: [] };
    switch (event.action) {
      case 'TICKET_CREATED':
        return {
          facts: { ...base, reporterId: ticket.createdByUserId, mentionedIds: await this.mentions.mentionedUserIds(ticket.projectId, ticket.description) },
          excerpt: ticket.description,
        };
      case 'assigned':
        return { facts: { ...base, assigneeUserId: await this.userAssignee(event.data) }, excerpt: null };
      case 'COMMENT_ADDED': {
        const commentId = event.data.commentId;
        if (!str(commentId)) return null;
        const comment = await this.reads.findComment(commentId);
        if (!comment || comment.ticketId !== ticket.id) return null;
        return {
          facts: { ...base, commentAuthorId: comment.authorUserId, mentionedIds: await this.mentions.mentionedUserIds(ticket.projectId, comment.body) },
          excerpt: comment.body,
        };
      }
      case 'status_changed':
        return { facts: base, excerpt: null };
      default:
        return null;
    }
  }

  /** Events recorded before `assigneeType` existed fall back to a User lookup. */
  private async userAssignee(data: Readonly<Record<string, unknown>>): Promise<string | null> {
    const id = data.assignedTo;
    if (!str(id)) return null;
    if (data.assigneeType === 'user') return id;
    if (data.assigneeType === 'agent' || data.assigneeType === null) return null;
    return (await this.reads.isUser(id)) ? id : null;
  }
}
```

Note the "assigned to nobody/agent" spec case: `assigned` with no user still reaches `watchers.ensure('t1', [])`
(an empty insert is a no-op in A3's `ensure`) and then stops because there are no recipients.

- [ ] **Step 7: Run to verify they pass**

Run: `cd apps/api && bunx jest src/notifications src/tickets/tickets.service.spec.ts && bun run type-check`
Expected: PASS; type-check clean. The `outbox-envelope` integration change is exercised in Task A12's integration run.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/notifications/ticket-notification.rules.ts apps/api/src/notifications/ticket-notification.rules.spec.ts \
  apps/api/src/notifications/ticket-notification-reads.repository.ts apps/api/src/notifications/ticket-mention.resolver.ts \
  apps/api/src/notifications/ticket-notification.subscriber.ts apps/api/src/notifications/ticket-notification.subscriber.spec.ts \
  apps/api/src/tickets/tickets.service.ts apps/api/src/tickets/tickets.service.spec.ts \
  apps/api/test/integration/memory/outbox-envelope.integration.spec.ts
git commit -m "feat(notifications): ticket producer — watchers then assign/comment/status notifications (S4a §2.2)"
```

---
### Task A7: Retention config, retention job and `NotificationsModule` wiring (spec §1 retention, D511)

**Files:**
- Create: `apps/api/src/config/notifications.config.ts`, `apps/api/src/config/notifications.config.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts` (after `OUTBOX_RETENTION_DAYS`, ~line 31)
- Create: `apps/api/src/notifications/notification-retention.processor.ts`, `apps/api/src/notifications/notification-retention.processor.spec.ts`
- Create: `apps/api/src/notifications/notifications.module.ts`, `apps/api/src/notifications/notifications.module.spec.ts`
- Modify: `apps/api/src/app.module.ts` (load `notificationsConfig`; import `NotificationsModule` after `LiveModule`)

**Interfaces:**
- Consumes: everything from A2-A6.
- Produces: `NOTIFICATIONS_CFG = 'notifications'`, `INotificationsConfig { retentionDays: number | null }`,
  `notificationsConfig`; `NotificationRetentionProcessor.scheduledPurge(): Promise<void>` (`@Cron('30 4 * * *')`, calls
  `purge(now: Date): Promise<void>`, the composable entry point Part D extends;
  Part D adds the closed-`FleetHealthAlert` purge to this method); `NotificationsModule` (imports `OutboxModule`,
  `LiveModule`, `ProjectAccessModule`; exports `NotificationWriter`, `NotificationEligibility`; Part D registers
  its fleet producers in this module's `providers`).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/config/notifications.config.spec.ts`:

```ts
import { notificationsConfig } from './notifications.config';
import { validate } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 's',
  JWT_REFRESH_SECRET: 'r',
  API_KEY_SECRET: 'k',
};

describe('notificationsConfig (S4a D511)', () => {
  const saved = { days: process.env['NOTIFICATION_RETENTION_DAYS'], env: process.env['NODE_ENV'] };

  afterEach(() => {
    if (saved.days === undefined) delete process.env['NOTIFICATION_RETENTION_DAYS'];
    else process.env['NOTIFICATION_RETENTION_DAYS'] = saved.days;
    process.env['NODE_ENV'] = saved.env;
  });

  it('defaults to 90 days outside tests and to off under NODE_ENV=test', () => {
    delete process.env['NOTIFICATION_RETENTION_DAYS'];
    process.env['NODE_ENV'] = 'production';
    expect(notificationsConfig()).toEqual({ retentionDays: 90 });
    process.env['NODE_ENV'] = 'test';
    expect(notificationsConfig()).toEqual({ retentionDays: null });
  });

  it('reads an override; 0 switches the purge off', () => {
    process.env['NOTIFICATION_RETENTION_DAYS'] = '30';
    expect(notificationsConfig().retentionDays).toBe(30);
    process.env['NOTIFICATION_RETENTION_DAYS'] = '0';
    expect(notificationsConfig().retentionDays).toBeNull();
  });

  it.each(['-1', '1.5', 'abc'])('refuses NOTIFICATION_RETENTION_DAYS=%s', (value) => {
    process.env['NOTIFICATION_RETENTION_DAYS'] = value;
    expect(() => notificationsConfig()).toThrow();
    expect(() => validate({ ...REQUIRED, NOTIFICATION_RETENTION_DAYS: value })).toThrow();
    expect(() => validate({ ...REQUIRED, NOTIFICATION_RETENTION_DAYS: '30' })).not.toThrow();
  });
});
```

`REQUIRED` is the minimal valid env from `apps/api/src/config/env.validation.spec.ts:3`.

`apps/api/src/notifications/notification-retention.processor.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { NotificationRetentionProcessor } from './notification-retention.processor';
import type { INotificationsConfig } from '../config/notifications.config';

function setup(config: INotificationsConfig | undefined) {
  const repo = { purgeRead: jest.fn().mockResolvedValue(7) };
  const cfg = { get: jest.fn().mockReturnValue(config) };
  const processor = new NotificationRetentionProcessor(repo as never, cfg as never);
  return { processor, repo };
}

describe('NotificationRetentionProcessor (S4a D511)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('purges read rows older than the retention window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-09T04:30:00Z'));
    try {
      const { processor, repo } = setup({ retentionDays: 90 });
      await processor.scheduledPurge();
      expect(repo.purgeRead).toHaveBeenCalledWith(new Date('2026-07-11T04:30:00Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing when retention is off or the config is missing', async () => {
    for (const config of [{ retentionDays: null }, undefined]) {
      const { processor, repo } = setup(config);
      await processor.scheduledPurge();
      expect(repo.purgeRead).not.toHaveBeenCalled();
    }
  });

  it('logs and swallows a failed purge (next night retries)', async () => {
    const { processor, repo } = setup({ retentionDays: 90 });
    repo.purgeRead.mockRejectedValueOnce(new Error('db down'));
    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
  });
});
```

`apps/api/src/notifications/notifications.module.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { NotificationWriter } from './notification-writer';
import { NotificationsModule } from './notifications.module';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';

describe('NotificationsModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, NotificationsModule] }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves the writer and the ticket producer', () => {
    expect(moduleRef.get(NotificationWriter)).toBeInstanceOf(NotificationWriter);
    expect(moduleRef.get(TicketNotificationSubscriber)).toBeInstanceOf(TicketNotificationSubscriber);
  });

  it('registers the ticket producer on ticket_event at init', async () => {
    await moduleRef.init();
    const subscriber = moduleRef.get(TicketNotificationSubscriber);
    expect(moduleRef.get(FanOutPublisher).getHandlers('ticket_event')).toContain(subscriber.handle);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/config/notifications.config.spec.ts src/notifications/notification-retention.processor.spec.ts src/notifications/notifications.module.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the config** — `apps/api/src/config/notifications.config.ts`:

```ts
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const NOTIFICATIONS_CFG = 'notifications';
export const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;

export interface INotificationsConfig {
  /** Days a read notification survives before the nightly purge. null disables the purge. */
  retentionDays: number | null;
}

export class NotificationsConfigSchema {
  // Digits-only to match the Joi `NOTIFICATION_RETENTION_DAYS` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^\d+$/)
  NOTIFICATION_RETENTION_DAYS?: string;
}

/**
 * Fleet S4a (D511): read notifications are purged after NOTIFICATION_RETENTION_DAYS (default 90);
 * unread rows are kept. Same default rule as outbox retention: off under NODE_ENV=test; 0 is the
 * kill switch.
 */
export const notificationsConfig = registerAs(NOTIFICATIONS_CFG, (): INotificationsConfig => {
  validateUtil(process.env, NotificationsConfigSchema);
  const raw = process.env['NOTIFICATION_RETENTION_DAYS'];
  if (raw !== undefined) {
    const days = parseInt(raw, 10);
    return { retentionDays: days > 0 ? days : null };
  }
  return { retentionDays: process.env['NODE_ENV'] !== 'test' ? DEFAULT_NOTIFICATION_RETENTION_DAYS : null };
});
```

In `apps/api/src/config/env.validation.ts`, after the `OUTBOX_RETENTION_DAYS` rule:

```ts
  NOTIFICATION_RETENTION_DAYS: Joi.number()
    .integer()
    .min(0)
    .optional(),
```

- [ ] **Step 4: Implement the retention job** — `apps/api/src/notifications/notification-retention.processor.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { INotificationsConfig, NOTIFICATIONS_CFG } from '../config/notifications.config';
import { NotificationsRepository } from './notifications.repository';

const DAY_MS = 86_400_000;

/**
 * Fleet S4a (D511): nightly purge of read notifications older than NOTIFICATION_RETENTION_DAYS.
 * 04:00 is the outbox purge; this runs at 04:30. A failed purge is logged and swallowed — the next
 * night's run is the retry.
 */
@Injectable()
export class NotificationRetentionProcessor {
  private readonly logger = new Logger(NotificationRetentionProcessor.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly config: ConfigService,
  ) {}

  @Cron('30 4 * * *')
  async scheduledPurge(): Promise<void> {
    await this.purge(new Date());
  }

  /** Each purge step logs and swallows its own failure, so one failing step never skips the next (Part D adds one). */
  async purge(now: Date): Promise<void> {
    await this.purgeReadNotifications(now);
  }

  private async purgeReadNotifications(now: Date): Promise<void> {
    const days = this.config.get<INotificationsConfig>(NOTIFICATIONS_CFG)?.retentionDays;
    if (days === null || days === undefined || days <= 0) return;
    const before = new Date(now.getTime() - days * DAY_MS);
    try {
      const deleted = await this.repo.purgeRead(before);
      this.logger.log(`Purged ${deleted} read notification(s) created before ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Notification retention purge failed, will retry next run: ${message}`);
    }
  }
}
```

- [ ] **Step 5: Implement the module** — `apps/api/src/notifications/notifications.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { NotificationEligibility } from './notification-eligibility';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationRetentionProcessor } from './notification-retention.processor';
import { NotificationWriter } from './notification-writer';
import { NotificationsRepository } from './notifications.repository';
import { TicketMentionResolver } from './ticket-mention.resolver';
import { TicketNotificationReadsRepository } from './ticket-notification-reads.repository';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';
import { TicketWatchersRepository } from './ticket-watchers.repository';

/**
 * Fleet S4a: in-app notifications. Producers are outbox fan-out handlers (D500); the writer is the
 * only path that inserts rows. Controllers are added in Tasks A8-A9.
 */
@Module({
  imports: [OutboxModule, LiveModule, ProjectAccessModule],
  providers: [
    NotificationsRepository,
    TicketWatchersRepository,
    NotificationPreferencesService,
    NotificationEligibility,
    NotificationWriter,
    NotificationRetentionProcessor,
    TicketNotificationReadsRepository,
    TicketMentionResolver,
    TicketNotificationSubscriber,
  ],
  exports: [NotificationWriter, NotificationEligibility],
})
export class NotificationsModule {}
```

In `apps/api/src/app.module.ts`: add `import { NotificationsModule } from './notifications/notifications.module';`
and `import { notificationsConfig } from './config/notifications.config';`; add `notificationsConfig` to the
`ConfigModule.forRoot` `load` array (after `fleetConfig`); add `NotificationsModule` to `imports` right after
`LiveModule`.

`GlobalStubsModule` exports `ConfigModule` (`global-stubs.module.ts:117`), so `ConfigService` resolves for the
retention processor in the module spec.

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/api && bunx jest src/config src/notifications src/app.module.spec.ts && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/config/notifications.config.ts apps/api/src/config/notifications.config.spec.ts apps/api/src/config/env.validation.ts \
  apps/api/src/notifications/notification-retention.processor.ts apps/api/src/notifications/notification-retention.processor.spec.ts \
  apps/api/src/notifications/notifications.module.ts apps/api/src/notifications/notifications.module.spec.ts apps/api/src/app.module.ts
git commit -m "feat(notifications): NotificationsModule, retention job and NOTIFICATION_RETENTION_DAYS (S4a D511)"
```

---

### Task A8: `/me/notifications` and `/me/notification-preferences` (spec §3)

**Files:**
- Create: `apps/api/src/notifications/dto/notification.dto.ts`
- Create: `apps/api/src/notifications/dto/list-notifications.query.ts`
- Create: `apps/api/src/notifications/dto/notification-preferences.dto.ts`
- Create: `apps/api/src/notifications/me-notifications.service.ts`, `apps/api/src/notifications/me-notifications.service.spec.ts`
- Create: `apps/api/src/notifications/me-notifications.controller.ts`, `apps/api/src/notifications/me-notifications.controller.spec.ts`
- Create: `apps/api/src/i18n/en/notifications.json`, `apps/api/src/i18n/zh/notifications.json`
- Modify: `apps/api/src/notifications/notifications.module.ts` (controller + service)

**Interfaces:**
- Consumes: `NotificationsRepository` (A3), `NotificationPreferencesService` (A4), `KodaPageQuery`, `parseQuery`
  (`common/dto/koda-page.query.ts`).
- Produces: routes (all wrapped in `JsonResponse.Ok` except 204s):
  - `GET /api/me/notifications?current=&size=&unread=true|false` → `{ total, current, size, hasNext, hasPrev, records: NotificationDto[] }`
  - `GET /api/me/notifications/unread-count` → `{ count }`
  - `POST /api/me/notifications/:id/read` → 204; 404 `notifications` when not the caller's
  - `POST /api/me/notifications/read-all` → 204
  - `GET /api/me/notification-preferences` → `{ items: { category, inApp }[] }`
  - `PUT /api/me/notification-preferences` body `{ items: { category, inApp }[] }` (1..5 items) → same shape as GET
  - Agents and runners → 403 `notifications`.
  - `NotificationDto { id, category, kind, title, body, link, params, projectId, actorId, readAt, createdAt }`
    (ISO strings; `readAt` null when unread).
  - Generated CLI client functions: `meNotificationsControllerList`, `meNotificationsControllerUnreadCount`,
    `meNotificationsControllerMarkRead`, `meNotificationsControllerMarkAllRead`,
    `meNotificationsControllerGetPreferences`, `meNotificationsControllerUpdatePreferences`.
  - `MeNotificationsService` with `list(userId, { current, size, unreadOnly })`, `unreadCount(userId)`,
    `markRead(userId, id)`, `markAllRead(userId, cutoff: Date)`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/notifications/me-notifications.service.spec.ts`:

```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { MeNotificationsService } from './me-notifications.service';

const row = {
  id: 'n1', userId: 'u1', projectId: 'p1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 'T', body: null,
  link: '/koda/tickets/KODA-1', params: { ref: 'KODA-1' }, actorId: 'u2', readAt: null, createdAt: new Date('2026-10-09T01:00:00Z'),
};

function setup() {
  const repo = {
    page: jest.fn().mockResolvedValue({ items: [row], total: 21 }),
    unreadCount: jest.fn().mockResolvedValue(3),
    markRead: jest.fn().mockResolvedValue(true),
    markAllRead: jest.fn().mockResolvedValue(2),
  };
  return { repo, service: new MeNotificationsService(repo as never) };
}

describe('MeNotificationsService (S4a §3)', () => {
  it('pages the caller\'s rows into the koda page envelope with ISO dates', async () => {
    const { service, repo } = setup();
    const page = await service.list('u1', { current: 2, size: 10, unreadOnly: true });
    expect(repo.page).toHaveBeenCalledWith('u1', { unreadOnly: true, page: 2, limit: 10 });
    expect(page).toEqual({
      total: 21, current: 2, size: 10, hasNext: true, hasPrev: true,
      records: [{
        id: 'n1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 'T', body: null, link: '/koda/tickets/KODA-1',
        params: { ref: 'KODA-1' }, projectId: 'p1', actorId: 'u2', readAt: null, createdAt: '2026-10-09T01:00:00.000Z',
      }],
    });
  });

  it('counts unread', async () => {
    const { service } = setup();
    await expect(service.unreadCount('u1')).resolves.toEqual({ count: 3 });
  });

  it('marks one read, 404 when it is not the caller\'s', async () => {
    const { service, repo } = setup();
    await service.markRead('u1', 'n1');
    expect(repo.markRead).toHaveBeenCalledWith('u1', 'n1', expect.any(Date));
    repo.markRead.mockResolvedValueOnce(false);
    await expect(service.markRead('u1', 'other')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('read-all cutoff: passes the given cutoff through unchanged (Review Focus 5)', async () => {
    const { service, repo } = setup();
    const cutoff = new Date('2026-10-09T02:00:00Z');
    await service.markAllRead('u1', cutoff);
    expect(repo.markAllRead).toHaveBeenCalledWith('u1', cutoff);
  });
});
```

`apps/api/src/notifications/me-notifications.controller.spec.ts`:

```ts
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { MeNotificationsController } from './me-notifications.controller';

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@k.t', name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};

function setup() {
  const service = {
    list: jest.fn().mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] }),
    unreadCount: jest.fn().mockResolvedValue({ count: 0 }),
    markRead: jest.fn().mockResolvedValue(undefined),
    markAllRead: jest.fn().mockResolvedValue(undefined),
  };
  const preferences = {
    list: jest.fn().mockResolvedValue([{ category: 'ASSIGNED', inApp: true }]),
    update: jest.fn().mockResolvedValue(undefined),
  };
  return { service, preferences, controller: new MeNotificationsController(service as never, preferences as never) };
}

describe('MeNotificationsController (S4a §3)', () => {
  it('refuses agents on every route (403)', async () => {
    const { controller } = setup();
    await expect(controller.list({}, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.unreadCount(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.markRead('n1', agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.markAllRead(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.getPreferences(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.updatePreferences({ items: [] }, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('lists the caller\'s page with defaults and the unread filter', async () => {
    const { controller, service } = setup();
    await controller.list({}, user);
    expect(service.list).toHaveBeenCalledWith('u1', { current: 1, size: 20, unreadOnly: false });
    await controller.list({ current: '2', size: '5', unread: 'true' } as never, user);
    expect(service.list).toHaveBeenLastCalledWith('u1', { current: 2, size: 5, unreadOnly: true });
  });

  it('read-all cutoff: uses the request time, captured before the update runs (Review Focus 5)', async () => {
    const { controller, service } = setup();
    const before = Date.now();
    await controller.markAllRead(user);
    const cutoff = service.markAllRead.mock.calls[0][1] as Date;
    expect(service.markAllRead.mock.calls[0][0]).toBe('u1');
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reads and writes the caller\'s preferences', async () => {
    const { controller, preferences } = setup();
    const res = await controller.updatePreferences({ items: [{ category: 'FLEET_HEALTH', inApp: false }] }, user);
    expect(preferences.update).toHaveBeenCalledWith('u1', [{ category: 'FLEET_HEALTH', inApp: false }]);
    expect(res).toEqual(expect.objectContaining({ data: { items: [{ category: 'ASSIGNED', inApp: true }] } }));
  });
});
```

`JsonResponse.Ok(x)` is an instance with `ret: 0`, `data: x`, `message: undefined`
(`@nathapp/nestjs-common/dist/serialize/json-response.js:13`), so `objectContaining({ data })` holds.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/notifications/me-notifications`
Expected: FAIL — modules not found.

- [ ] **Step 3: DTOs**

`apps/api/src/notifications/dto/notification.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_CATEGORIES, NotificationCategory } from '../notification.types';

export class NotificationDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES }) category: NotificationCategory;
  @ApiProperty({ description: 'ticket_assigned, ticket_mentioned, ticket_commented, ticket_status_changed, job_*, approval_requested, budget_*, runner_offline, credential_expiring' })
  kind: string;
  @ApiProperty({ description: 'English fallback; the web renders from kind + params' }) title: string;
  @ApiPropertyOptional({ nullable: true, type: String }) body: string | null;
  @ApiProperty({ description: 'In-app path, e.g. /koda/tickets/KODA-12' }) link: string;
  @ApiProperty({ type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] } })
  params: Record<string, string | number>;
  @ApiPropertyOptional({ nullable: true, type: String }) projectId: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) actorId: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' }) readAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class NotificationPageDto {
  @ApiProperty() total: number;
  @ApiProperty() current: number;
  @ApiProperty() size: number;
  @ApiProperty() hasNext: boolean;
  @ApiProperty() hasPrev: boolean;
  @ApiProperty({ type: [NotificationDto] }) records: NotificationDto[];
}

export class UnreadCountDto {
  @ApiProperty() count: number;
}
```

`apps/api/src/notifications/dto/list-notifications.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';

export class ListNotificationsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true = unread only' })
  @IsOptional()
  @IsIn(['true', 'false'])
  unread?: 'true' | 'false';
}
```

`apps/api/src/notifications/dto/notification-preferences.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, ValidateNested } from 'class-validator';
import { NOTIFICATION_CATEGORIES, NotificationCategory } from '../notification.types';

export class NotificationPreferenceItemDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  @IsIn(NOTIFICATION_CATEGORIES)
  category: NotificationCategory;

  @ApiProperty()
  @IsBoolean()
  inApp: boolean;
}

export class NotificationPreferencesDto {
  @ApiProperty({ type: [NotificationPreferenceItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(NOTIFICATION_CATEGORIES.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceItemDto)
  items: NotificationPreferenceItemDto[];
}
```

The response of GET/PUT preferences reuses `NotificationPreferencesDto` (same shape).

- [ ] **Step 4: Service** — `apps/api/src/notifications/me-notifications.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { NotificationsRepository } from './notifications.repository';
import type { NotificationRow } from './notification.types';
import type { NotificationDto } from './dto/notification.dto';

const toDto = (r: NotificationRow): NotificationDto => ({
  id: r.id, category: r.category as NotificationDto['category'], kind: r.kind, title: r.title, body: r.body, link: r.link,
  params: { ...r.params }, projectId: r.projectId, actorId: r.actorId,
  readAt: r.readAt ? r.readAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
});

/** Fleet S4a §3: the caller's own inbox. Every method takes the caller's user id, never a parameter. */
@Injectable()
export class MeNotificationsService {
  constructor(private readonly repo: NotificationsRepository) {}

  async list(userId: string, q: { current: number; size: number; unreadOnly: boolean }): Promise<IPageResult<NotificationDto>> {
    const { items, total } = await this.repo.page(userId, { unreadOnly: q.unreadOnly, page: q.current, limit: q.size });
    return {
      total, current: q.current, size: q.size,
      hasNext: q.current * q.size < total, hasPrev: q.current > 1,
      records: items.map(toDto),
    };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.repo.unreadCount(userId) };
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!(await this.repo.markRead(userId, id, new Date()))) throw new NotFoundAppException({}, 'notifications');
  }

  async markAllRead(userId: string, cutoff: Date): Promise<void> {
    await this.repo.markAllRead(userId, cutoff);
  }
}
```

`IPageResult<T>` is the six-field envelope `toPageResult` (`common/dto/koda-page.query.ts`) returns; the service
builds it directly because the repository returns `{ items, total }`, not a `Page`.

- [ ] **Step 5: Controller** — `apps/api/src/notifications/me-notifications.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { isUserPrincipal, KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery } from '../common/dto/koda-page.query';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { NotificationPageDto, UnreadCountDto } from './dto/notification.dto';
import { NotificationPreferencesDto } from './dto/notification-preferences.dto';
import { MeNotificationsService } from './me-notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';

function caller(principal: KodaPrincipal): UserPrincipal {
  if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'notifications');
  return principal;
}

/** Fleet S4a §3: the signed-in user's inbox and preferences. Users only; never takes a user id. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me')
export class MeNotificationsController {
  constructor(
    private readonly notifications: MeNotificationsService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  @Get('notifications')
  @ApiOperation({ summary: 'My notifications, newest first (users only)' })
  @ApiResponse({ status: 200, type: NotificationPageDto })
  @ApiResponse({ status: 403, description: 'Agents and runners have no inbox' })
  async list(@Query() rawQuery: ListNotificationsQuery, @Principal() principal: KodaPrincipal) {
    const me = caller(principal);
    const { current, size, unread } = parseQuery(ListNotificationsQuery, rawQuery);
    return JsonResponse.Ok(await this.notifications.list(me.id, { current, size, unreadOnly: unread === 'true' }));
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'How many of my notifications are unread' })
  @ApiResponse({ status: 200, type: UnreadCountDto })
  async unreadCount(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.notifications.unreadCount(caller(principal).id));
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark one of my notifications read (idempotent)' })
  @ApiResponse({ status: 204, description: 'Read' })
  @ApiResponse({ status: 404, description: 'No such notification of mine' })
  async markRead(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.notifications.markRead(caller(principal).id, id);
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark every notification I had when this request arrived read' })
  @ApiResponse({ status: 204, description: 'Read' })
  async markAllRead(@Principal() principal: KodaPrincipal): Promise<void> {
    const me = caller(principal);
    await this.notifications.markAllRead(me.id, new Date());
  }

  @Get('notification-preferences')
  @ApiOperation({ summary: 'My in-app notification categories' })
  @ApiResponse({ status: 200, type: NotificationPreferencesDto })
  async getPreferences(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok({ items: await this.preferences.list(caller(principal).id) });
  }

  @Put('notification-preferences')
  @ApiOperation({ summary: 'Switch in-app notification categories on or off' })
  @ApiResponse({ status: 200, type: NotificationPreferencesDto })
  @ApiResponse({ status: 400, description: 'Unknown category or malformed body' })
  async updatePreferences(@Body() dto: NotificationPreferencesDto, @Principal() principal: KodaPrincipal) {
    const me = caller(principal);
    await this.preferences.update(me.id, dto.items.map((i) => ({ category: i.category, inApp: i.inApp })));
    return JsonResponse.Ok({ items: await this.preferences.list(me.id) });
  }
}
```

`caller` throws synchronously inside an `async` method, which surfaces as a rejected promise — what the agent
spec's `rejects` assertions expect.

- [ ] **Step 6: i18n** — `apps/api/src/i18n/en/notifications.json`:

```json
{
  "404": "Notification not found",
  "40003": "Notifications are available to signed-in users only",
  "-2": "Validation error"
}
```

`apps/api/src/i18n/zh/notifications.json`:

```json
{
  "404": "通知不存在",
  "40003": "通知仅对已登录用户开放",
  "-2": "验证错误"
}
```

- [ ] **Step 7: Register** — in `notifications.module.ts` add `controllers: [MeNotificationsController]` and
`MeNotificationsService` to `providers` (imports for both).

- [ ] **Step 8: Run to verify they pass**

Run: `cd apps/api && bunx jest src/notifications && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/notifications apps/api/src/i18n/en/notifications.json apps/api/src/i18n/zh/notifications.json
git commit -m "feat(notifications): /me/notifications and /me/notification-preferences (S4a §3)"
```

---

### Task A9: Watch routes on tickets (spec §3, D502)

**Files:**
- Create: `apps/api/src/notifications/dto/watch-state.dto.ts`
- Create: `apps/api/src/notifications/ticket-watch.service.ts`, `apps/api/src/notifications/ticket-watch.service.spec.ts`
- Create: `apps/api/src/notifications/ticket-watch.controller.ts`, `apps/api/src/notifications/ticket-watch.controller.spec.ts`
- Modify: `apps/api/src/notifications/notifications.module.ts`

**Interfaces:**
- Consumes: `TicketWatchersRepository.watch`, `.unwatch`, `.state`, `.findTicketIdByRef` (A3);
  `ProjectMembershipGuard`, `CurrentProject`, `ProjectContext` (existing).
- Produces: `GET /api/projects/:slug/tickets/:ref/watchers`, `PUT` and `DELETE /api/projects/:slug/tickets/:ref/watch`
  → `WatchStateDto { watching: boolean; count: number }`; non-members 403 (guard); agents 403; unknown or deleted
  ticket 404 `tickets`. Generated client: `ticketWatchControllerState`, `ticketWatchControllerWatch`,
  `ticketWatchControllerUnwatch`. `TicketWatchService.state|watch|unwatch(projectId, ref, userId): Promise<WatchStateDto>`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/notifications/ticket-watch.service.spec.ts`:

```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketWatchService } from './ticket-watch.service';

function setup(ticketId: string | null = 't1') {
  const repo = {
    findTicketIdByRef: jest.fn().mockResolvedValue(ticketId),
    watch: jest.fn().mockResolvedValue(undefined),
    unwatch: jest.fn().mockResolvedValue(undefined),
    state: jest.fn().mockResolvedValue({ watching: true, count: 2 }),
  };
  return { repo, service: new TicketWatchService(repo as never) };
}

describe('TicketWatchService (S4a §3, D502)', () => {
  it('watch un-mutes then returns the state', async () => {
    const { service, repo } = setup();
    await expect(service.watch('p1', 'KODA-1', 'u1')).resolves.toEqual({ watching: true, count: 2 });
    expect(repo.findTicketIdByRef).toHaveBeenCalledWith('p1', 'KODA-1');
    expect(repo.watch).toHaveBeenCalledWith('t1', 'u1');
  });

  it('unwatch mutes then returns the state', async () => {
    const { service, repo } = setup();
    repo.state.mockResolvedValueOnce({ watching: false, count: 1 });
    await expect(service.unwatch('p1', 'KODA-1', 'u1')).resolves.toEqual({ watching: false, count: 1 });
    expect(repo.unwatch).toHaveBeenCalledWith('t1', 'u1');
  });

  it('404s an unknown or deleted ticket without writing', async () => {
    const { service, repo } = setup(null);
    await expect(service.watch('p1', 'KODA-404', 'u1')).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(service.state('p1', 'KODA-404', 'u1')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.watch).not.toHaveBeenCalled();
  });
});
```

`apps/api/src/notifications/ticket-watch.controller.spec.ts`:

```ts
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectContext } from '../projects/project-context';
import { TicketWatchController } from './ticket-watch.controller';

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@k.t', name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};
const ctx: ProjectContext = { project: { id: 'p1', slug: 'koda' }, role: 'VIEWER' };

function setup() {
  const service = {
    state: jest.fn().mockResolvedValue({ watching: false, count: 0 }),
    watch: jest.fn().mockResolvedValue({ watching: true, count: 1 }),
    unwatch: jest.fn().mockResolvedValue({ watching: false, count: 0 }),
  };
  return { service, controller: new TicketWatchController(service as never) };
}

describe('TicketWatchController (S4a §3)', () => {
  it('lets any project member (even a VIEWER) watch, scoped to the guard-resolved project', async () => {
    const { controller, service } = setup();
    await controller.watch('KODA-1', ctx, user);
    expect(service.watch).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
    await controller.unwatch('KODA-1', ctx, user);
    expect(service.unwatch).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
    await controller.state('KODA-1', ctx, user);
    expect(service.state).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
  });

  it('refuses agents (403)', async () => {
    const { controller } = setup();
    await expect(controller.watch('KODA-1', ctx, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.state('KODA-1', ctx, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/notifications/ticket-watch`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/api/src/notifications/dto/watch-state.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

export class WatchStateDto {
  @ApiProperty({ description: 'Whether the caller receives activity notifications for this ticket' }) watching: boolean;
  @ApiProperty({ description: 'Unmuted watchers' }) count: number;
}
```

`apps/api/src/notifications/ticket-watch.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketWatchersRepository } from './ticket-watchers.repository';
import type { WatchStateDto } from './dto/watch-state.dto';

/** Fleet S4a §3 (D502): the caller's watch on one ticket. Unwatch is a sticky mute. */
@Injectable()
export class TicketWatchService {
  constructor(private readonly repo: TicketWatchersRepository) {}

  async state(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    return this.repo.state(await this.ticketId(projectId, ref), userId);
  }

  async watch(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    const ticketId = await this.ticketId(projectId, ref);
    await this.repo.watch(ticketId, userId);
    return this.repo.state(ticketId, userId);
  }

  async unwatch(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    const ticketId = await this.ticketId(projectId, ref);
    await this.repo.unwatch(ticketId, userId);
    return this.repo.state(ticketId, userId);
  }

  private async ticketId(projectId: string, ref: string): Promise<string> {
    const id = await this.repo.findTicketIdByRef(projectId, ref);
    if (!id) throw new NotFoundAppException({}, 'tickets');
    return id;
  }
}
```

`apps/api/src/notifications/ticket-watch.controller.ts`:

```ts
import { Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { isUserPrincipal, KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { CurrentProject } from '../projects/current-project.decorator';
import type { ProjectContext } from '../projects/project-context';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { WatchStateDto } from './dto/watch-state.dto';
import { TicketWatchService } from './ticket-watch.service';

function caller(principal: KodaPrincipal): UserPrincipal {
  if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'notifications');
  return principal;
}

/** Fleet S4a §3: watch / unwatch a ticket (any project member; users only). */
@ApiTags('notifications')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@ApiParam({ name: 'ref', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/tickets/:ref')
@UseGuards(ProjectMembershipGuard)
export class TicketWatchController {
  constructor(private readonly service: TicketWatchService) {}

  @Get('watchers')
  @ApiOperation({ summary: 'Whether I watch this ticket, and how many people do' })
  @ApiResponse({ status: 200, type: WatchStateDto })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async state(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.service.state(ctx.project.id, ref, caller(principal).id));
  }

  @Put('watch')
  @ApiOperation({ summary: 'Watch this ticket (receive its activity notifications)' })
  @ApiResponse({ status: 200, type: WatchStateDto })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async watch(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.service.watch(ctx.project.id, ref, caller(principal).id));
  }

  @Delete('watch')
  @ApiOperation({ summary: 'Stop watching this ticket; assignments and mentions still notify' })
  @ApiResponse({ status: 200, type: WatchStateDto })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async unwatch(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.service.unwatch(ctx.project.id, ref, caller(principal).id));
  }
}
```

Register in `notifications.module.ts`: `controllers: [MeNotificationsController, TicketWatchController]`, add
`TicketWatchService` to `providers`. `ProjectMembershipGuard` comes from `ProjectAccessModule`, already imported
(its `KodaCaslAbilityFactory` is exported there, see the module comment in `project-access.module.ts`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bunx jest src/notifications && bun run type-check`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications
git commit -m "feat(notifications): watch/unwatch ticket routes (S4a §3, D502)"
```

---
### Task A10: End-to-end API behaviour on Postgres (spec success criteria 1, 2, 7, 8)

**Files:**
- Create: `apps/api/test/integration/notifications/notifications-api.integration.spec.ts`

**Interfaces:**
- Consumes: every route and producer from A2-A9; `bootHttpApp`, `data`, `loginToken`, `TEST_PASSWORD`
  (`test/helpers/http-app.ts`); `openSse` (`test/helpers/sse-client.ts`); `OutboxRelay.dispatchPendingBatch()`;
  `TicketNotificationSubscriber.handle` (A6).
- Produces: nothing new (test only).

No production code changes in this task unless a case fails; if one does, fix it in the owning task's files and
amend nothing — make a separate `fix(notifications): ...` commit.

- [ ] **Step 1: Write the integration spec**

```ts
/**
 * Fleet S4a — notifications over real HTTP + outbox relay on Postgres (spec success criteria 1, 2, 7, 8).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-api.integration.spec.ts
 */
import type { AddressInfo } from 'net';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { TicketNotificationSubscriber } from '../../../src/notifications/ticket-notification.subscriber';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { openSse, SseConnection } from '../../helpers/sse-client';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Note { id: string; kind: string; category: string; link: string; title: string; readAt: string | null }
interface NotePage { total: number; records: Note[] }

describeIntegration('notifications API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let baseUrl: string;
  let relay: OutboxRelay;
  let prisma: PrismaClient;
  let streams: SseConnection[] = [];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  /** The relay takes 20 rows per batch; drain until a batch publishes nothing. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      const pending = await prisma.outboxEvent.count({ where: { status: 'pending' } });
      if (pending === 0) return;
      await relay.dispatchPendingBatch();
    }
  };
  const inbox = async (who: string, query = ''): Promise<NotePage> =>
    data<NotePage>(await request(server).get(`/api/me/notifications${query}`).set(auth(who)).expect(200));
  const kinds = async (who: string): Promise<string[]> => (await inbox(who, '?size=100')).records.map((n) => `${n.kind} ${n.link}`);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay = app.get(OutboxRelay);
    prisma = app.get(PrismaService).client as PrismaClient;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Notif', slug: 'notif', key: 'NTF' }).expect(201);

    for (const who of ['dev', 'watcher', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    for (const who of ['dev', 'watcher']) {
      await request(server).post('/api/projects/notif/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Notif Bot', slug: 'notif-bot', roles: ['DEVELOPER'] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

    await request(server).post('/api/projects/notif/tickets').set(auth('root')).send({ type: 'BUG', title: 'First' }).expect(201);
    await drain();
  });

  afterEach(() => {
    streams.forEach((s) => s.close());
    streams = [];
  });

  afterAll(async () => {
    await app?.close();
  });

  it('assignment notifies the assignee live, never the actor (criterion 1)', async () => {
    const stream = await openSse(`${baseUrl}/api/me/events`, tokens.dev);
    streams = [...streams, stream];
    expect(stream.status).toBe(200);
    await stream.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/notif/tickets/NTF-1/assign').set(auth('root')).send({ userId: ids.dev }).expect(200);
    await drain();

    const frame = await stream.next((m) => m.event === 'notification');
    const page = await inbox('dev');
    expect(page.records).toEqual([expect.objectContaining({
      kind: 'ticket_assigned', category: 'ASSIGNED', link: '/notif/tickets/NTF-1', title: 'Root assigned you NTF-1: First', readAt: null,
    })]);
    expect(JSON.parse(frame.data)).toEqual(expect.objectContaining({ type: 'notification', id: page.records[0].id }));
    expect(data<{ count: number }>(await request(server).get('/api/me/notifications/unread-count').set(auth('dev')).expect(200)).count).toBe(1);
    expect((await inbox('root')).total).toBe(0);
  });

  it('a comment notifies every unmuted watcher except the commenter (criterion 2)', async () => {
    await request(server).post('/api/projects/notif/tickets/NTF-1/comments').set(auth('watcher'))
      .send({ body: 'I can reproduce this', type: 'GENERAL' }).expect(201);
    await drain();
    expect(await kinds('dev')).toContain('ticket_commented /notif/tickets/NTF-1');
    expect(await kinds('root')).toContain('ticket_commented /notif/tickets/NTF-1');
    expect(await kinds('watcher')).not.toContain('ticket_commented /notif/tickets/NTF-1');
    const watchers = await prisma.ticketWatcher.findMany({ select: { userId: true, reason: true }, orderBy: { userId: 'asc' } });
    expect(watchers).toEqual(expect.arrayContaining([
      { userId: ids.root, reason: 'REPORTER' }, { userId: ids.dev, reason: 'ASSIGNEE' }, { userId: ids.watcher, reason: 'COMMENTER' },
    ]));
  });

  it('replaying the same ticket_event inserts nothing (D501)', async () => {
    const before = await prisma.notification.count();
    const last = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'ticket_event' }, orderBy: { createdAt: 'desc' } });
    const subscriber = app.get(TicketNotificationSubscriber);
    await subscriber.handle(JSON.parse(last.payload));
    await subscriber.handle(JSON.parse(last.payload));
    expect(await prisma.notification.count()).toBe(before);
  });

  it('a category switched off stops new notifications of that category only (criterion 7)', async () => {
    await request(server).put('/api/me/notification-preferences').set(auth('dev'))
      .send({ items: [{ category: 'WATCHED_ACTIVITY', inApp: false }] }).expect(200);
    const devBefore = (await inbox('dev')).total;
    await request(server).post('/api/projects/notif/tickets/NTF-1/verify').set(auth('root')).send({ body: 'verified' }).expect(200);
    await drain();
    expect((await inbox('dev')).total).toBe(devBefore);
    expect(await kinds('watcher')).toContain('ticket_status_changed /notif/tickets/NTF-1');
    const prefs = data<{ items: Array<{ category: string; inApp: boolean }> }>(
      await request(server).get('/api/me/notification-preferences').set(auth('dev')).expect(200));
    expect(prefs.items).toContainEqual({ category: 'WATCHED_ACTIVITY', inApp: false });
    expect(prefs.items).toContainEqual({ category: 'ASSIGNED', inApp: true });
  });

  it('unwatch mutes activity but an assignment still notifies (D502)', async () => {
    const off = data<{ watching: boolean; count: number }>(
      await request(server).delete('/api/projects/notif/tickets/NTF-1/watch').set(auth('watcher')).expect(200));
    expect(off.watching).toBe(false);
    const before = (await inbox('watcher')).total;
    await request(server).post('/api/projects/notif/tickets/NTF-1/comments').set(auth('root'))
      .send({ body: 'any update?', type: 'GENERAL' }).expect(201);
    await drain();
    expect((await inbox('watcher')).total).toBe(before);

    await request(server).post('/api/projects/notif/tickets/NTF-1/assign').set(auth('root')).send({ userId: ids.watcher }).expect(200);
    await drain();
    expect((await inbox('watcher')).records[0]).toEqual(expect.objectContaining({ kind: 'ticket_assigned' }));
    const state = data<{ watching: boolean }>(await request(server).get('/api/projects/notif/tickets/NTF-1/watchers').set(auth('watcher')).expect(200));
    expect(state.watching).toBe(false);
    const on = data<{ watching: boolean }>(await request(server).put('/api/projects/notif/tickets/NTF-1/watch').set(auth('watcher')).expect(200));
    expect(on.watching).toBe(true);
  });

  it('isolation: nobody reads or marks another user\'s inbox; agents and outsiders are refused (criterion 8)', async () => {
    const rootNote = (await inbox('root')).records[0];
    expect(rootNote).toBeDefined();
    await request(server).post(`/api/me/notifications/${rootNote.id}/read`).set(auth('dev')).expect(404);
    expect((await inbox('dev')).records.map((n) => n.id)).not.toContain(rootNote.id);
    expect((await inbox('root')).records[0].readAt).toBeNull();

    await request(server).get('/api/me/notifications').set(auth('agent')).expect(403);
    await request(server).get('/api/me/notifications/unread-count').set(auth('agent')).expect(403);
    await request(server).put('/api/me/notification-preferences').set(auth('agent')).send({ items: [{ category: 'ASSIGNED', inApp: false }] }).expect(403);
    await request(server).put('/api/projects/notif/tickets/NTF-1/watch').set(auth('outsider')).expect(403);
    await request(server).put('/api/projects/notif/tickets/NTF-999/watch').set(auth('dev')).expect(404);
    await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({ items: [{ category: 'NOPE', inApp: false }] }).expect(400);
  });

  it('a ticket deleted before the relay runs produces no notification (Review Focus 1)', async () => {
    await request(server).post('/api/projects/notif/tickets').set(auth('root')).send({ type: 'TASK', title: 'Doomed' }).expect(201);
    await request(server).post('/api/projects/notif/tickets/NTF-2/comments').set(auth('dev')).send({ body: 'hm', type: 'GENERAL' }).expect(201);
    await request(server).delete('/api/projects/notif/tickets/NTF-2').set(auth('root')).expect(200);
    await drain();
    expect(await prisma.notification.count({ where: { link: '/notif/tickets/NTF-2' } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { status: 'dead' } })).toBe(0);
  });

  it('mark one read, then read-all, leaves nothing unread', async () => {
    const [first] = (await inbox('watcher')).records;
    await request(server).post(`/api/me/notifications/${first.id}/read`).set(auth('watcher')).expect(204);
    await request(server).post(`/api/me/notifications/${first.id}/read`).set(auth('watcher')).expect(204);
    await request(server).post('/api/me/notifications/read-all').set(auth('watcher')).expect(204);
    expect(data<{ count: number }>(await request(server).get('/api/me/notifications/unread-count').set(auth('watcher')).expect(200)).count).toBe(0);
    expect((await inbox('watcher', '?unread=true')).total).toBe(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-api.integration.spec.ts`
Expected: 8 passing. If the `NTF-1/verify` call 400s (it needs the ticket in `CREATED`; the earlier tests only
assign and comment), read `ticket-transitions.service.ts` `verify` preconditions and adjust the test's call, not
the producer.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/notifications/notifications-api.integration.spec.ts
git commit -m "test(notifications): end-to-end inbox, watchers, preferences and isolation on PG (S4a)"
```

---

### Task A11: OpenAPI contract and CLI (`koda notifications`, `koda ticket watch|unwatch`) (spec §3)

**Files:**
- Create: `apps/api/src/notifications/notifications-openapi.contract.spec.ts`
- Regenerate: `openapi.json`, `apps/cli/src/generated/`
- Create: `apps/cli/src/commands/notifications.ts`, `apps/cli/src/commands/notifications.spec.ts`
- Create: `apps/cli/src/commands/ticket-watch.ts`, `apps/cli/src/commands/ticket-watch.spec.ts`
- Modify: `apps/cli/src/commands/ticket.ts` (call `registerTicketWatch(ticket)` at the end of `ticketCommand`)
- Modify: `apps/cli/src/index.ts` (register `notificationsCommand` after `memberCommand`)

**Interfaces:**
- Consumes: generated `meNotificationsControllerList`, `meNotificationsControllerMarkRead`,
  `meNotificationsControllerMarkAllRead`, `ticketWatchControllerWatch`, `ticketWatchControllerUnwatch`;
  `unwrap`, `handleApiError`, `withContext`, `table`, `parsePositiveInt` (existing CLI utils).
- Produces: `notificationsCommand(program: Command): void`; `registerTicketWatch(ticket: Command): void`.
  Commands: `koda notifications [list] [--unread] [--page n] [--size n] [--json]` (`list` is the default
  subcommand), `koda notifications read <id>`, `koda notifications read --all`, `koda ticket watch <ref>`,
  `koda ticket unwatch <ref>`. All need a user access token in `KODA_API_KEY` (agent keys get 403).

- [ ] **Step 1: Pin the contract** — `apps/api/src/notifications/notifications-openapi.contract.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('notifications OpenAPI contract (S4a §3)', () => {
  it('exposes the inbox, preferences and watch routes', () => {
    expect(Object.keys(spec.paths['/api/me/notifications'] ?? {})).toContain('get');
    expect(Object.keys(spec.paths['/api/me/notifications/unread-count'] ?? {})).toContain('get');
    expect(Object.keys(spec.paths['/api/me/notifications/{id}/read'] ?? {})).toContain('post');
    expect(Object.keys(spec.paths['/api/me/notifications/read-all'] ?? {})).toContain('post');
    expect(Object.keys(spec.paths['/api/me/notification-preferences'] ?? {}).sort()).toEqual(['get', 'put']);
    expect(Object.keys(spec.paths['/api/projects/{slug}/tickets/{ref}/watch'] ?? {}).sort()).toEqual(['delete', 'put']);
    expect(Object.keys(spec.paths['/api/projects/{slug}/tickets/{ref}/watchers'] ?? {})).toContain('get');
  });

  it('pins the NotificationDto fields the web and CLI read', () => {
    expect(Object.keys(spec.components.schemas['NotificationDto']?.properties ?? {}).sort()).toEqual(
      ['actorId', 'body', 'category', 'createdAt', 'id', 'kind', 'link', 'params', 'projectId', 'readAt', 'title'],
    );
  });

  it('keeps the SSE stream out of the spec', () => {
    expect(spec.paths['/api/me/events']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Regenerate and run the contract spec**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun run generate
cd apps/api && bunx jest src/notifications/notifications-openapi.contract.spec.ts
grep -c "meNotificationsControllerList\|ticketWatchControllerWatch" ../cli/src/generated/sdk.gen.ts
```

Expected: `openapi.json` and `apps/cli/src/generated/` change; contract spec PASS; the grep count is ≥ 2.

- [ ] **Step 3: Write the failing CLI tests**

`apps/cli/src/commands/notifications.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  meNotificationsControllerList: jest.fn(),
  meNotificationsControllerMarkRead: jest.fn(),
  meNotificationsControllerMarkAllRead: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { notificationsCommand } from './notifications';
import { meNotificationsControllerList, meNotificationsControllerMarkAllRead, meNotificationsControllerMarkRead } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };
const PAGE = {
  ret: 0,
  data: {
    total: 1, current: 1, size: 20, hasNext: false, hasPrev: false,
    records: [{ id: 'n1', kind: 'ticket_assigned', title: 'Root assigned you KODA-1: Fix', link: '/koda/tickets/KODA-1', readAt: null, createdAt: '2026-10-09T00:00:00.000Z' }],
  },
};

describe('notificationsCommand (S4a §3)', () => {
  let program: Command;
  let log: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    notificationsCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('lists by default, newest first, with the unread filter and paging', async () => {
    (meNotificationsControllerList as jest.Mock).mockResolvedValue(PAGE);
    await program.parseAsync(['node', 'koda', 'notifications', '--unread', '--page', '2']);
    expect(meNotificationsControllerList).toHaveBeenCalledWith({ query: { current: 2, size: 20, unread: 'true' } });
    expect(log.mock.calls.flat().join('\n')).toContain('Root assigned you KODA-1: Fix');
  });

  it('prints JSON with --json', async () => {
    (meNotificationsControllerList as jest.Mock).mockResolvedValue(PAGE);
    await program.parseAsync(['node', 'koda', 'notifications', 'list', '--json']);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(PAGE.data);
  });

  it('marks one read', async () => {
    (meNotificationsControllerMarkRead as jest.Mock).mockResolvedValue({});
    await program.parseAsync(['node', 'koda', 'notifications', 'read', 'n1']);
    expect(meNotificationsControllerMarkRead).toHaveBeenCalledWith({ path: { id: 'n1' } });
  });

  it('marks all read', async () => {
    (meNotificationsControllerMarkAllRead as jest.Mock).mockResolvedValue({});
    await program.parseAsync(['node', 'koda', 'notifications', 'read', '--all']);
    expect(meNotificationsControllerMarkAllRead).toHaveBeenCalledWith({});
  });

  it('refuses read without an id or --all', async () => {
    await program.parseAsync(['node', 'koda', 'notifications', 'read']);
    expect(meNotificationsControllerMarkRead).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
```

`apps/cli/src/commands/ticket-watch.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  ticketWatchControllerWatch: jest.fn(),
  ticketWatchControllerUnwatch: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { registerTicketWatch } from './ticket-watch';
import { ticketWatchControllerUnwatch, ticketWatchControllerWatch } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('koda ticket watch|unwatch (S4a §3)', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerTicketWatch(program.command('ticket'));
    (resolveContext as jest.Mock).mockImplementation(async (flags: { projectSlug?: string }) => ({ ...CTX, projectSlug: flags.projectSlug ?? CTX.projectSlug }));
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('watch targets the context project', async () => {
    (ticketWatchControllerWatch as jest.Mock).mockResolvedValue({ ret: 0, data: { watching: true, count: 2 } });
    await program.parseAsync(['node', 'koda', 'ticket', 'watch', 'KODA-1']);
    expect(ticketWatchControllerWatch).toHaveBeenCalledWith({ path: { slug: 'my-proj', ref: 'KODA-1' } });
  });

  it('unwatch honours --project', async () => {
    (ticketWatchControllerUnwatch as jest.Mock).mockResolvedValue({ ret: 0, data: { watching: false, count: 1 } });
    await program.parseAsync(['node', 'koda', 'ticket', 'unwatch', 'KODA-1', '--project', 'other']);
    expect(ticketWatchControllerUnwatch).toHaveBeenCalledWith({ path: { slug: 'other', ref: 'KODA-1' } });
  });
});
```

Run: `cd apps/cli && bunx jest src/commands/notifications.spec.ts src/commands/ticket-watch.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the CLI commands**

`apps/cli/src/commands/notifications.ts`:

```ts
import { Command } from 'commander';
import {
  meNotificationsControllerList,
  meNotificationsControllerMarkAllRead,
  meNotificationsControllerMarkRead,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';
import { parsePositiveInt } from '../utils/parse-positive-int';

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  link: string;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: NotificationRow[];
}

// Inboxes belong to users: pass a user access token through KODA_API_KEY (agent keys get 403).
const TOKEN_HINT = 'Requires a user access token: KODA_API_KEY=<token> koda notifications …';

export function notificationsCommand(program: Command): void {
  const notifications = program.command('notifications');
  notifications.description(`My in-app notifications. ${TOKEN_HINT}`);

  notifications
    .command('list', { isDefault: true })
    .description('List my notifications, newest first')
    .option('--unread', 'Only unread notifications')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await meNotificationsControllerList({
          query: { current: options.page, size: options.size, ...(options.unread ? { unread: 'true' as const } : {}) },
        });
        const page = unwrap<NotificationPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['ID', 'Unread', 'When', 'Title', 'Link'], page.records.map((n) => [
            n.id, n.readAt ? '' : '*', n.createdAt.slice(0, 16).replace('T', ' '), n.title, n.link,
          ]));
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  notifications
    .command('read [id]')
    .description('Mark one notification read, or every one with --all')
    .option('--all', 'Mark all my notifications read')
    .action(async (id: string | undefined, options) => {
      if (!id && !options.all) {
        console.error('Give a notification id or --all');
        process.exit(1);
        return;
      }
      try {
        await withContext({}, { requireProject: false });
        if (options.all) {
          await meNotificationsControllerMarkAllRead({});
          console.log('All notifications marked read');
        } else {
          await meNotificationsControllerMarkRead({ path: { id: id as string } });
          console.log(`Marked ${id} read`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `No such notification: ${id}` });
      }
    });
}
```

`withContext({}, { requireProject: false })` wires the generated client (base URL + Authorization) without
needing a project, as `src/commands/user.ts:41` does for its non-project routes.

`apps/cli/src/commands/ticket-watch.ts`:

```ts
import { Command } from 'commander';
import { ticketWatchControllerUnwatch, ticketWatchControllerWatch } from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

interface WatchState {
  watching: boolean;
  count: number;
}

/** S4a §3: `koda ticket watch|unwatch <ref>` (user access token; unwatch keeps assignments and mentions). */
export function registerTicketWatch(ticket: Command): void {
  for (const [name, call, verb] of [
    ['watch', ticketWatchControllerWatch, 'Watching'],
    ['unwatch', ticketWatchControllerUnwatch, 'Stopped watching'],
  ] as const) {
    ticket
      .command(`${name} <ref>`)
      .description(name === 'watch' ? 'Receive activity notifications for a ticket' : 'Stop activity notifications for a ticket (assignments and mentions still notify)')
      .option('--project <slug>', 'Project slug')
      .option('--json', 'Output as JSON')
      .action(async (ref: string, options) => {
        try {
          const ctx = await withContext({ projectSlug: options.project });
          const state = unwrap<WatchState>(await call({ path: { slug: ctx.projectSlug, ref } }));
          if (options.json) console.log(JSON.stringify(state, null, 2));
          else console.log(`${verb} ${ref} (${state.count} watching)`);
          process.exit(0);
        } catch (err: unknown) {
          handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
        }
      });
  }
}
```

In `apps/cli/src/commands/ticket.ts`, add `import { registerTicketWatch } from './ticket-watch';` and, as the last
statement inside `ticketCommand` (after the `ticket label` subcommands), `registerTicketWatch(ticket);`. The
existing `ticket*.spec.ts` files mock `../generated` without the watch functions: they stay green because the watch
actions only call the generated function when invoked.

In `apps/cli/src/index.ts`, add `import { notificationsCommand } from './commands/notifications';` and after
`memberCommand(program);`:

```ts
// Notifications command (S4a)
notificationsCommand(program);
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/cli && bunx jest && bun run lint && bun run type-check`
Expected: PASS (all CLI specs, including the existing `ticket*.spec.ts`); clean.

- [ ] **Step 6: Commit**

```bash
git add openapi.json apps/cli/src/generated apps/api/src/notifications/notifications-openapi.contract.spec.ts \
  apps/cli/src/commands/notifications.ts apps/cli/src/commands/notifications.spec.ts \
  apps/cli/src/commands/ticket-watch.ts apps/cli/src/commands/ticket-watch.spec.ts \
  apps/cli/src/commands/ticket.ts apps/cli/src/index.ts
git commit -m "feat(cli): koda notifications and koda ticket watch|unwatch (S4a §3)"
```

---

### Task A12: PR 1 gates, docs and pull request

**Files:**
- Modify: `.nax/mono/apps/api/context.md`; regenerated agent files.

- [ ] **Step 1: Full gates** (all must pass; fix in the owning task's files with a `fix(notifications): ...` commit)

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run generate && git status --short openapi.json apps/cli/src/generated   # expect no diff (A11 committed it)
cd apps/api && bun run lint && bun run type-check && bun run test
bun run test:db:up
bun run test:scoped test/integration/notifications
bun run test:scoped test/integration/memory/outbox-envelope.integration.spec.ts
bun run test:scoped test/integration/live
cd ../cli && bun run lint && bun run type-check && bun run test
```

Expected: every command exits 0. `bun run test:scoped` accepts a directory (see the usage line in
`apps/api/scripts/test-scoped.ts`).

- [ ] **Step 2: Docs** — in `.nax/mono/apps/api/context.md` add a section:

```markdown
## Notifications (fleet S4a)

- `src/notifications/` owns in-app notifications. Producers are outbox fan-out handlers (`FanOutPublisher.register`);
  domain services only enqueue events. `NotificationWriter.deliver` is the only insert path (eligibility, IN_APP
  preference, `createManyAndReturn({ skipDuplicates })` on `(userId, sourceType, sourceId, kind)`, then
  `UserEventBus.publish`). A producer throws only on database failure; a missing or deleted source ends quietly.
- `TicketWatcher` rows are insert-if-absent; unwatch is a sticky `muted` flag. Assignment and mentions ignore mute.
- `/me/*` routes are users-only and never take a user id. `/me/events` shares `LiveStreamRegistry` with project
  streams.
- Notification text: English `title`/`body` (CLI fallback, truncated to 200/280), web renders from `kind` + `params`.
```

then regenerate the agent files and commit both:

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && nax generate --all-packages
git add .nax/mono/apps/api/context.md AGENTS.md CLAUDE.md GEMINI.md codex.md apps/api
git commit -m "docs: api context for notifications (S4a)"
```

(`git add apps/api` picks up the regenerated per-package agent files; check `git status` first and add only
generated agent files plus the context source.)

- [ ] **Step 3: Push and open the PR** (only with the user's go-ahead to push)

```bash
git push -u origin feat/fleet-s4a-1-notifications-core
gh pr create --base main --title "feat(notifications): S4a PR 1 — notifications core and ticket producers" --body "$(cat <<'BODY'
## Summary
- New `Notification`, `TicketWatcher`, `NotificationPreference` tables; watcher backfill from reporters, user assignees and user commenters of live tickets (S4a spec §1).
- Outbox-driven ticket producer: assignment → assignee; comment / status change → unmuted watchers; one notification per user per event, idempotent on redelivery (D500-D502). Mentions are a seam filled by PR 3.
- `GET/POST /api/me/notifications*`, `GET/PUT /api/me/notification-preferences`, `GET /api/projects/:slug/tickets/:ref/watchers`, `PUT/DELETE .../watch` (users only).
- `GET /api/me/events`: per-user SSE (content-free), sharing the per-user stream cap with project streams (D509).
- Nightly purge of read notifications after `NOTIFICATION_RETENTION_DAYS` (default 90, D511).
- CLI: `koda notifications [list|read]`, `koda ticket watch|unwatch`.
- `ticket_event` `assigned` data gains `assigneeType`.
- Spec + plan: `docs/superpowers/specs/2026-10-08-fleet-s4a-notifications-core-design.md`, `docs/superpowers/plans/2026-10-08-fleet-s4a-notifications-core.md` (Part A).

## Test plan
- [ ] api unit + lint + type-check
- [ ] api integration: notifications (backfill migration, repositories, end-to-end API), outbox-envelope, live
- [ ] cli unit + lint + type-check
- [ ] openapi.json / CLI client regenerated, no diff
BODY
)"
```

---

---

## Part B — PR 2: Inbox web

Implements spec §5 (web) and the web half of §4 (the `/me/events` proxy). Consumes Part A's HTTP contract only; no
API, Prisma or CLI change. Branch `feat/fleet-s4a-2-inbox-web` cut from `main` after PR 1 merged.

Ground truth this part builds on (verified on `main` `d9a23c16`):

- `useApi()` exposes `$api.get/post/patch/delete/download`; there is **no `put`** (`composables/useApi.ts:254-276`).
  The contract's `PUT /me/notification-preferences` and `PUT .../watch` need it (Task B1).
- `@nathapp` `Page<T>` serialises as `{ records, total, size, current, hasNext, hasPrev }` and lists take `current` /
  `size` query params (`KodaPageQuery`, `apps/api/src/common/dto/koda-page.query.ts`). The web types below follow that
  real shape, not the contract table's shorthand `{ items, meta }` (see the deviation note at the end of Part C).
- The project live stream is `lib/project-event-stream.ts` (EventSource client with auth-refresh recovery) behind a
  per-URL shared hub (`lib/project-event-hub.ts`); the API emits each SSE frame with `event: <LiveEvent.type>`
  (`apps/api/src/live/live-stream.ts:35`), so the user stream's frames arrive as `event: notification`.
- The Nitro live proxy core is `server/utils/live-proxy.ts` (`openLiveUpstream`, slug-only).
- Component tests mount real SFCs with `tests/helpers/mount-sfc.ts`; only the names in `VUE_HELPERS` and
  `NUXT_AUTO_IMPORTS` are injected, so new composables are imported explicitly in SFCs and replaced in tests with
  `alias`.
- E2E `webLogin` waits for `networkidle` on `/` (`tests/e2e/fixtures/page-helpers.ts:63-71`), which only works
  "while the dashboard opens no live stream". The bell opens `/api/me/events` on **every** page, so Task B4 switches
  it (and `auth.spec.ts`'s two `reload({ waitUntil: 'networkidle' })`) to `waitForHydration`.

### File Structure (Part B)

Web (`apps/web`):
- Modify `composables/useApi.ts` — `$api.put`.
- Modify `tests/composables/useApi.spec.ts` — PUT test.
- Create `lib/notification-types.ts` — DTOs (`NotificationDto`, `NotificationPage`, `NotificationCategory`,
  `NotificationPreferenceDto`, `WatchStateDto`) and route constants.
- Create `lib/notifications.ts` — pure helpers: `notificationText`, `isInAppPath`.
- Create `tests/lib/notifications.spec.ts`.
- Modify `i18n/locales/en.json`, `i18n/locales/zh.json` — `notifications.*`.
- Create `tests/i18n/notifications-locale-parity.spec.ts`.
- Modify `server/utils/live-proxy.ts` — `openLiveUpstreamUrl`, `buildUserLiveUpstreamUrl`.
- Modify `tests/server/live-proxy.spec.ts`.
- Create `server/api/me/events.get.ts` — the `/api/me/events` proxy.
- Modify `lib/project-event-stream.ts` — `LiveNotificationEvent`, `parseNotificationEvent`, `onNotification`.
- Modify `lib/project-event-hub.ts` — fan out `onNotification`.
- Create `tests/lib/project-event-stream-notification.spec.ts`.
- Create `composables/useUserEvents.ts` + `tests/composables/useUserEvents.spec.ts`.
- Create `composables/useNotifications.ts` + `tests/composables/useNotifications.spec.ts`.
- Create `composables/useNotificationPreferences.ts` + `tests/composables/useNotificationPreferences.spec.ts`.
- Create `composables/useTicketWatch.ts` + `tests/composables/useTicketWatch.spec.ts`.
- Create `components/NotificationBell.vue` + `tests/components/notification-bell.spec.ts`.
- Modify `layouts/default.vue` — mount the bell; `tests/layouts/default-notification-bell.spec.ts`.
- Modify `tests/e2e/fixtures/page-helpers.ts`, `tests/e2e/auth.spec.ts` — no `networkidle`.
- Create `pages/notifications.vue` + `tests/pages/notifications-page.spec.ts`.
- Create `pages/settings/notifications.vue` + `tests/pages/notification-settings-page.spec.ts`.
- Create `components/TicketWatchButton.vue` + `tests/components/ticket-watch-button.spec.ts`.
- Modify `pages/[project]/tickets/[ref].vue` — mount the watch button.
- Modify `tests/e2e/fixtures/api-client.ts` — `assignTicket`.
- Create `tests/e2e/notifications.e2e.spec.ts`.

Docs:
- Modify `.nax/mono/apps/web/context.md` (+ regenerated agent files).

---

### Task B0: Cut the PR 2 branch

**Files:** none.

- [ ] **Step 1: Branch from the merged main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git fetch origin
git switch main && git merge --ff-only origin/main
git log --oneline -1   # expect the PR 1 squash commit "feat(fleet): S4a PR 1 ..."
git switch -c feat/fleet-s4a-2-inbox-web
```

Expected: `main` contains Part A (`apps/api/src/notifications/` exists, `openapi.json` lists `/api/me/notifications`).
If it does not, stop: Part B needs the PR 1 routes.

- [ ] **Step 2: Confirm the HTTP contract Part A shipped**

```bash
grep -n '"/api/me/notifications\|"/api/me/notification-preferences\|/watch"\|/watchers"' openapi.json
```

Expected: `/api/me/notifications`, `/api/me/notifications/unread-count`, `/api/me/notifications/{id}/read`,
`/api/me/notifications/read-all`, `/api/me/notification-preferences`, `/api/projects/{slug}/tickets/{ref}/watch` and
`/api/projects/{slug}/tickets/{ref}/watchers`. Read the `NotificationDto` schema in `openapi.json` and the list
query parameters: if the list takes `page`/`limit` instead of `current`/`size`, or returns `items` instead of
`records`, change `NOTIFICATION_PAGE_SIZE_PARAM`/`NOTIFICATION_PAGE_PARAM` and `NotificationPage` in Task B1 to match
before writing anything else.

---

### Task B1: `$api.put`, notification types, text helpers and locale keys

**Files:**
- Modify: `apps/web/composables/useApi.ts:254-276`
- Modify: `apps/web/tests/composables/useApi.spec.ts`
- Create: `apps/web/lib/notification-types.ts`
- Create: `apps/web/lib/notifications.ts`
- Create: `apps/web/tests/lib/notifications.spec.ts`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Create: `apps/web/tests/i18n/notifications-locale-parity.spec.ts`

**Interfaces:**
- Consumes: Part A HTTP contract (`NotificationDto` fields, `{ count }`, `{ items: { category, inApp }[] }`,
  `{ watching, count }`).
- Produces:
  - `$api.put<T>(path: string, body?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>`
  - `lib/notification-types.ts`: `NOTIFICATION_CATEGORIES`, `NotificationCategory`, `NotificationDto`,
    `NotificationPage`, `NotificationPreferenceDto`, `WatchStateDto`, `NOTIFICATIONS_PATH`, `UNREAD_COUNT_PATH`,
    `READ_ALL_PATH`, `PREFERENCES_PATH`, `NOTIFICATION_PAGE_PARAM`, `NOTIFICATION_PAGE_SIZE_PARAM`
  - `lib/notifications.ts`: `notificationText(n: NotificationDto, i18n: NotificationI18n): string`,
    `isInAppPath(link: unknown): link is string`, `type NotificationI18n`
  - Locale tree `notifications.*` (en + zh), used by every later task.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/composables/useApi.spec.ts`, inside the `describe('AC1b: ...')` block, after the DELETE
test:

```ts
  test('PUT sends the body with method PUT and no Authorization header (S4a)', async () => {
    const fetchMock = makeFetchMock()
    const { fakeUseAuth, fakeRuntimeConfig } = makeAuthEnv()

    ;(globalThis as Record<string, unknown>).useRuntimeConfig = fakeRuntimeConfig
    ;(globalThis as Record<string, unknown>).useAuth = fakeUseAuth
    ;(globalThis as Record<string, unknown>).useI18n = fakeUseI18n
    ;(globalThis as Record<string, unknown>).$fetch = fetchMock

    const mod = await import(`${composablePath}`)
    const { $api } = mod.useApi()

    await $api.put('/me/notification-preferences', { items: [{ category: 'ASSIGNED', inApp: false }] })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, calledOpts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:3100/me/notification-preferences')
    expect(calledOpts?.method).toBe('PUT')
    expect(calledOpts?.body).toEqual({ items: [{ category: 'ASSIGNED', inApp: false }] })
    const headers = (calledOpts?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
```

Create `apps/web/tests/lib/notifications.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { enI18n } from '../helpers/fleet-harness'
import { isInAppPath, notificationText } from '~/lib/notifications'
import { NOTIFICATION_CATEGORIES } from '~/lib/notification-types'
import type { NotificationDto } from '~/lib/notification-types'

const base: NotificationDto = {
  id: 'n1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 'Ann assigned you KODA-1: Fix login',
  body: null, link: '/koda/tickets/KODA-1', params: { ref: 'KODA-1', ticketTitle: 'Fix login', actorName: 'Ann' },
  projectId: 'p1', actorId: 'u2', readAt: null, createdAt: '2026-10-08T00:00:00.000Z',
}

describe('notificationText (S4a §5: web renders from kind + params)', () => {
  test('renders a known kind from the locale with its params', () => {
    expect(notificationText(base, enI18n())).toBe('Ann assigned you KODA-1: Fix login')
  })

  test.each([
    ['ticket_mentioned', { ref: 'KODA-2', ticketTitle: 'x', actorName: 'Bo' }, 'Bo mentioned you on KODA-2'],
    ['ticket_commented', { ref: 'KODA-3', ticketTitle: 'x', actorName: 'Cy' }, 'Cy commented on KODA-3'],
    ['ticket_status_changed', { ref: 'KODA-4', ticketTitle: 'x', actorName: 'Di', fromStatus: 'CREATED', newStatus: 'VERIFIED' }, 'KODA-4 moved CREATED → VERIFIED'],
    ['job_escalated', { repo: 'acme/app', feature: 'f', state: 'ESCALATED' }, 'Fleet job on acme/app escalated'],
    ['job_pr_opened', { repo: 'acme/app', feature: 'f', prUrl: 'https://x' }, 'Fleet job on acme/app opened a PR'],
    ['approval_requested', { repo: 'acme/app', kind: 'bash' }, 'Approval needed: bash on acme/app'],
    ['budget_hard_stop', { scope: 'acme/app', spentUsd: '12.00', amountUsd: '10.00' }, 'Budget acme/app stopped at 12.00 of 10.00 USD'],
    ['runner_offline', { runner: 'wk-mac' }, 'Runner wk-mac is offline'],
    ['credential_expiring', { runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11' }, 'openai-codex credential on wk-mac expires 2026-10-11'],
  ])('%s', (kind, params, expected) => {
    expect(notificationText({ ...base, kind, params }, enI18n())).toBe(expected)
  })

  test('an unknown kind falls back to the API title', () => {
    expect(notificationText({ ...base, kind: 'from_the_future', title: 'Server text' }, enI18n())).toBe('Server text')
  })
})

describe('isInAppPath', () => {
  test.each([
    ['/koda/tickets/KODA-1', true],
    ['/admin/fleet/approvals', true],
    ['//evil.example/x', false],
    ['https://evil.example', false],
    ['javascript:alert(1)', false],
    ['', false],
    [null, false],
  ])('%s -> %s', (link, expected) => {
    expect(isInAppPath(link)).toBe(expected)
  })
})

describe('categories', () => {
  test('exactly the five spec categories, in display order', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'])
  })
})
```

Create `apps/web/tests/i18n/notifications-locale-parity.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'

type Tree = { [key: string]: string | Tree }
const en = require('../../i18n/locales/en.json') as { notifications?: Tree }
const zh = require('../../i18n/locales/zh.json') as { notifications?: Tree }

const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`))

describe('S4a locale parity (notifications)', () => {
  test('en and zh define the same non-empty keys', () => {
    expect(en.notifications).toBeDefined()
    const enKeys = leaves(en.notifications ?? {}).map(([k]) => k).sort()
    const zhLeaves = leaves(zh.notifications ?? {})
    expect(zhLeaves.map(([k]) => k).sort()).toEqual(enKeys)
    for (const [, value] of zhLeaves) expect(value.trim()).not.toBe('')
  })

  test('every category has a label and a description', () => {
    for (const c of ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH']) {
      expect((en.notifications?.categories as Tree)[c]).toEqual(expect.objectContaining({ label: expect.any(String), description: expect.any(String) }))
    }
  })

  test('no message uses vue-i18n special characters @ $ | outside placeholders', () => {
    for (const [key, value] of [...leaves(en.notifications ?? {}), ...leaves(zh.notifications ?? {})]) {
      expect([key, /[@$|]/.test(value)]).toEqual([key, false])
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/composables/useApi.spec.ts tests/lib/notifications.spec.ts tests/i18n/notifications-locale-parity.spec.ts`
Expected: FAIL — `$api.put is not a function`, `Cannot find module '~/lib/notifications'`, `en.notifications` undefined.

- [ ] **Step 3: Add `put` to `useApi`**

In `apps/web/composables/useApi.ts`, after the `patch` helper:

```ts
  const put = <T = unknown>(path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, { ...options, method: 'PUT', body })
```

and return it:

```ts
  return {
    $api: {
      get,
      post,
      put,
      patch,
      delete: delete_,
      download,
    },
  }
```

- [ ] **Step 4: Create `apps/web/lib/notification-types.ts`**

```ts
/** S4a §1/§3: the five notification categories, in the order the settings page lists them. */
export const NOTIFICATION_CATEGORIES = ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** GET /me/notifications rows (S4a §3). Times are ISO strings. */
export interface NotificationDto {
  id: string
  category: NotificationCategory
  /** e.g. ticket_assigned, job_escalated; the web words it from `notifications.kinds.<kind>`. */
  kind: string
  /** English fallback text for kinds this build does not know. */
  title: string
  body: string | null
  /** In-app path, e.g. /koda/tickets/KODA-12. */
  link: string
  params: Record<string, string | number>
  projectId: string | null
  actorId: string | null
  readAt: string | null
  createdAt: string
}

/** The `@nathapp` Page<T> envelope every koda list returns (KodaPageQuery: `current`, `size`). */
export interface NotificationPage {
  records: NotificationDto[]
  total: number
  size: number
  current: number
  hasNext: boolean
  hasPrev?: boolean
}

export interface NotificationPreferenceDto {
  category: NotificationCategory
  inApp: boolean
}

/** PUT/DELETE .../watch and GET .../watchers; `count` = unmuted watchers. */
export interface WatchStateDto {
  watching: boolean
  count: number
}

export const NOTIFICATIONS_PATH = '/me/notifications'
export const UNREAD_COUNT_PATH = '/me/notifications/unread-count'
export const READ_ALL_PATH = '/me/notifications/read-all'
export const PREFERENCES_PATH = '/me/notification-preferences'
export const NOTIFICATION_PAGE_PARAM = 'current'
export const NOTIFICATION_PAGE_SIZE_PARAM = 'size'
```

- [ ] **Step 5: Create `apps/web/lib/notifications.ts`**

```ts
import type { NotificationDto } from '~/lib/notification-types'

export interface NotificationI18n {
  t: (key: string, named?: Record<string, unknown>) => string
  te: (key: string) => boolean
}

/** S4a §1: the web words a notification from `kind` + `params`; an unknown kind shows the API's English title. */
export function notificationText(n: NotificationDto, i18n: NotificationI18n): string {
  const key = `notifications.kinds.${n.kind}`
  return i18n.te(key) ? i18n.t(key, { ...n.params }) : n.title
}

/** A notification link is followed only when it is a same-origin path (never `//host` or a scheme). */
export function isInAppPath(link: unknown): link is string {
  return typeof link === 'string' && /^\/(?!\/)/.test(link)
}
```

- [ ] **Step 6: Add the locale keys**

Add a top-level `"notifications"` object to `apps/web/i18n/locales/en.json` (after `"fleet"`; keep the file's
2-space JSON formatting):

```json
  "notifications": {
    "title": "Notifications",
    "subtitle": "Tickets you follow and fleet work that needs you.",
    "empty": "You're all caught up.",
    "emptyUnread": "No unread notifications.",
    "markAllRead": "Mark all read",
    "viewAll": "View all",
    "settings": "Notification settings",
    "prev": "Previous",
    "next": "Next",
    "filter": { "all": "All", "unread": "Unread" },
    "bell": { "label": "Notifications, {count} unread", "title": "Notifications" },
    "kinds": {
      "ticket_assigned": "{actorName} assigned you {ref}: {ticketTitle}",
      "ticket_mentioned": "{actorName} mentioned you on {ref}",
      "ticket_commented": "{actorName} commented on {ref}",
      "ticket_status_changed": "{ref} moved {fromStatus} → {newStatus}",
      "job_escalated": "Fleet job on {repo} escalated",
      "job_failed": "Fleet job on {repo} failed",
      "job_crashed": "Fleet job on {repo} crashed",
      "job_pr_opened": "Fleet job on {repo} opened a PR",
      "approval_requested": "Approval needed: {kind} on {repo}",
      "budget_warn": "Budget {scope} reached {spentUsd} of {amountUsd} USD",
      "budget_hard_stop": "Budget {scope} stopped at {spentUsd} of {amountUsd} USD",
      "runner_offline": "Runner {runner} is offline",
      "credential_expiring": "{provider} credential on {runner} expires {expiresAt}"
    },
    "categories": {
      "ASSIGNED": { "label": "Assigned to me", "description": "A ticket is assigned to you." },
      "MENTIONED": { "label": "Mentions", "description": "Someone mentions you in a ticket or comment." },
      "WATCHED_ACTIVITY": { "label": "Watched tickets", "description": "Comments and status changes on tickets you watch." },
      "FLEET_NEEDS_YOU": { "label": "Fleet needs you", "description": "Your fleet jobs finish badly or open a PR; approval asks (admins)." },
      "FLEET_HEALTH": { "label": "Fleet health", "description": "Budget alerts, offline runners and expiring credentials (admins)." }
    },
    "preferences": {
      "title": "Notification settings",
      "subtitle": "Choose which notifications reach your inbox.",
      "inApp": "In-app",
      "saved": "Notification settings saved"
    },
    "watch": {
      "watch": "Watch",
      "unwatch": "Unwatch",
      "count": "{count} watching",
      "failed": "Could not update watching"
    }
  }
```

Add the same tree to `apps/web/i18n/locales/zh.json`:

```json
  "notifications": {
    "title": "通知",
    "subtitle": "你关注的工单以及需要你处理的 fleet 任务。",
    "empty": "没有新通知。",
    "emptyUnread": "没有未读通知。",
    "markAllRead": "全部标为已读",
    "viewAll": "查看全部",
    "settings": "通知设置",
    "prev": "上一页",
    "next": "下一页",
    "filter": { "all": "全部", "unread": "未读" },
    "bell": { "label": "通知，{count} 条未读", "title": "通知" },
    "kinds": {
      "ticket_assigned": "{actorName} 将 {ref} 分配给你：{ticketTitle}",
      "ticket_mentioned": "{actorName} 在 {ref} 中提到了你",
      "ticket_commented": "{actorName} 评论了 {ref}",
      "ticket_status_changed": "{ref} 从 {fromStatus} 变为 {newStatus}",
      "job_escalated": "{repo} 上的 fleet 任务已升级处理",
      "job_failed": "{repo} 上的 fleet 任务失败",
      "job_crashed": "{repo} 上的 fleet 任务崩溃",
      "job_pr_opened": "{repo} 上的 fleet 任务创建了 PR",
      "approval_requested": "需要审批：{repo} 上的 {kind}",
      "budget_warn": "预算 {scope} 已用 {spentUsd} / {amountUsd} USD",
      "budget_hard_stop": "预算 {scope} 在 {spentUsd} / {amountUsd} USD 处停止",
      "runner_offline": "Runner {runner} 已离线",
      "credential_expiring": "{runner} 上的 {provider} 凭据将于 {expiresAt} 过期"
    },
    "categories": {
      "ASSIGNED": { "label": "分配给我", "description": "有工单分配给你。" },
      "MENTIONED": { "label": "提及", "description": "有人在工单或评论中提到你。" },
      "WATCHED_ACTIVITY": { "label": "关注的工单", "description": "你关注的工单有新评论或状态变化。" },
      "FLEET_NEEDS_YOU": { "label": "Fleet 需要你", "description": "你发起的 fleet 任务异常结束或创建了 PR；审批请求（管理员）。" },
      "FLEET_HEALTH": { "label": "Fleet 健康", "description": "预算告警、Runner 离线和凭据即将过期（管理员）。" }
    },
    "preferences": {
      "title": "通知设置",
      "subtitle": "选择哪些通知进入你的收件箱。",
      "inApp": "站内",
      "saved": "通知设置已保存"
    },
    "watch": {
      "watch": "关注",
      "unwatch": "取消关注",
      "count": "{count} 人关注",
      "failed": "无法更新关注状态"
    }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/composables/useApi.spec.ts tests/lib/notifications.spec.ts tests/i18n/`
Expected: PASS (the whole `tests/i18n/` folder, so `used-keys-exist` and the other parity specs stay green).

- [ ] **Step 8: Commit**

```bash
git add apps/web/composables/useApi.ts apps/web/tests/composables/useApi.spec.ts apps/web/lib/notification-types.ts \
  apps/web/lib/notifications.ts apps/web/tests/lib/notifications.spec.ts apps/web/i18n/locales/en.json \
  apps/web/i18n/locales/zh.json apps/web/tests/i18n/notifications-locale-parity.spec.ts
git commit -m "feat(web): notification types, text helpers, locale keys and \$api.put (S4a §5)"
```

---

### Task B2: `/api/me/events` proxy and the `notification` stream event

**Files:**
- Modify: `apps/web/server/utils/live-proxy.ts`
- Modify: `apps/web/tests/server/live-proxy.spec.ts`
- Create: `apps/web/server/api/me/events.get.ts`
- Modify: `apps/web/lib/project-event-stream.ts`
- Modify: `apps/web/lib/project-event-hub.ts`
- Create: `apps/web/tests/lib/project-event-stream-notification.spec.ts`

**Interfaces:**
- Consumes: API `GET /api/me/events` (Part A), frames `event: notification`, `data: { type: 'notification', userId, id, at }`.
- Produces:
  - `buildUserLiveUpstreamUrl(apiInternalUrl: string): string`
  - `openLiveUpstreamUrl(url: string, req: { cookie: string | undefined; onClientClose: (cb: () => void) => void; fetchImpl?: typeof fetch }): Promise<LiveProxyResult>`
  - `LiveNotificationEvent`, `parseNotificationEvent(raw: string): LiveNotificationEvent | null`,
    `ProjectEventHandlers.onNotification?: (event: LiveNotificationEvent) => void`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/server/live-proxy.spec.ts` (and add `buildUserLiveUpstreamUrl, openLiveUpstreamUrl` to its
import from `~/server/utils/live-proxy`):

```ts
describe('user stream (S4a §4)', () => {
  test('targets the API /me/events endpoint', () => {
    expect(buildUserLiveUpstreamUrl(API)).toBe('http://api:3100/api/me/events')
    expect(buildUserLiveUpstreamUrl('http://api:3100/api/')).toBe('http://api:3100/api/me/events')
  })

  test('openLiveUpstreamUrl forwards the cookie and aborts with the client', async () => {
    let signal: AbortSignal | undefined
    let clientClosed: () => void = () => undefined
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return streamResponse()
    })
    const result = await openLiveUpstreamUrl(buildUserLiveUpstreamUrl(API), {
      cookie: 'koda_token=abc',
      onClientClose: (cb) => { clientClosed = cb },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.kind).toBe('stream')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api:3100/api/me/events')
    expect(init?.headers).toEqual({ accept: 'text/event-stream', cookie: 'koda_token=abc' })
    clientClosed()
    expect(signal?.aborted).toBe(true)
  })

  test('a refused upstream (429 stream cap) passes its status through', async () => {
    const fetchImpl = jest.fn(async () => new Response('too many', { status: 429 }))
    const result = await openLiveUpstreamUrl(buildUserLiveUpstreamUrl(API), {
      cookie: undefined, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ kind: 'error', status: 429, body: 'too many' })
  })

  test('the Nitro route uses the shared helpers and the stream headers', () => {
    const source = readFileSync(path.join(__dirname, '../../server/api/me/events.get.ts'), 'utf-8')
    expect(source).toContain('buildUserLiveUpstreamUrl(')
    expect(source).toContain('openLiveUpstreamUrl(')
    expect(source).toContain('LIVE_STREAM_HEADERS')
    expect(source).toContain("event.node.res.on('close', cb)")
  })
})
```

Create `apps/web/tests/lib/project-event-stream-notification.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import { createProjectEventHub } from '~/lib/project-event-hub'
import { createProjectEventStream, parseNotificationEvent, type EventSourceLike } from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }
  close(): void { this.readyState = 2 }
  listenerTypes(): string[] { return Object.keys(this.listeners).sort() }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }
}

const deps = (sources: FakeEventSource[]) => ({
  createEventSource: () => { const es = new FakeEventSource(); sources.push(es); return es },
  refreshAuth: async () => true,
  setTimer: () => null,
  clearTimer: () => undefined,
})

const notice = (id: string) => ({ type: 'notification', userId: 'u1', id, at: '2026-10-08T00:00:00.000Z' })

describe('parseNotificationEvent (S4a §4)', () => {
  test('accepts a content-free notice', () => {
    expect(parseNotificationEvent(JSON.stringify(notice('n1')))).toEqual(notice('n1'))
  })
  test.each([
    ['another type', JSON.stringify({ ...notice('n1'), type: 'ticket' })],
    ['no id', JSON.stringify({ type: 'notification', userId: 'u1', at: 'x' })],
    ['not JSON', '{oops'],
    ['null', 'null'],
  ])('rejects %s', (_label, raw) => {
    expect(parseNotificationEvent(raw)).toBeNull()
  })
})

describe('createProjectEventStream notification listener', () => {
  test('listens for notification only when the subscriber handles it, and dedupes by id', () => {
    const sources: FakeEventSource[] = []
    const onNotification = jest.fn()
    createProjectEventStream('/api/me/events', { onNotification, onResync: () => undefined }, deps(sources))
    expect(sources[0].listenerTypes()).toEqual(['notification', 'ticket'])
    sources[0].emit('notification', notice('n1'))
    sources[0].emit('notification', notice('n1'))
    sources[0].emit('notification', notice('n2'))
    expect(onNotification).toHaveBeenCalledTimes(2)

    const silent: FakeEventSource[] = []
    createProjectEventStream('/api/projects/p/events', { onResync: () => undefined }, deps(silent))
    expect(silent[0].listenerTypes()).not.toContain('notification')
  })

  test('the hub fans a notice out to every subscriber of the URL', () => {
    const sources: FakeEventSource[] = []
    const hub = createProjectEventHub(deps(sources))
    const a = jest.fn()
    const b = jest.fn()
    hub.subscribe('/api/me/events', { onNotification: a, onResync: () => undefined })
    hub.subscribe('/api/me/events', { onNotification: b, onResync: () => undefined })
    expect(sources).toHaveLength(1)
    sources[0].emit('notification', notice('n9'))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/server/live-proxy.spec.ts tests/lib/project-event-stream-notification.spec.ts`
Expected: FAIL — `buildUserLiveUpstreamUrl is not a function`, `parseNotificationEvent is not a function`.

- [ ] **Step 3: Generalise the proxy core**

In `apps/web/server/utils/live-proxy.ts`, replace `openLiveUpstream` with:

```ts
export function buildUserLiveUpstreamUrl(apiInternalUrl: string): string {
  return resolveProxyTarget('/me/events', { apiInternalUrl })
}

export type LiveUpstreamRequest = Omit<LiveProxyRequest, 'slug' | 'apiInternalUrl'>

export async function openLiveUpstream(req: LiveProxyRequest): Promise<LiveProxyResult> {
  const url = buildLiveUpstreamUrl(req.slug, req.apiInternalUrl)
  if (!url) return { kind: 'error', status: 400, body: 'invalid project slug' }
  return openLiveUpstreamUrl(url, req)
}

/** S4a §4: the shared core for the project and the user (`/me/events`) streams. */
export async function openLiveUpstreamUrl(url: string, req: LiveUpstreamRequest): Promise<LiveProxyResult> {
  const controller = new AbortController()
  req.onClientClose(() => controller.abort())
  const headers: Record<string, string> = req.cookie
    ? { accept: 'text/event-stream', cookie: req.cookie }
    : { accept: 'text/event-stream' }

  let upstream: Response
  try {
    upstream = await (req.fetchImpl ?? fetch)(url, { headers, signal: controller.signal })
  }
  catch {
    return { kind: 'error', status: 502, body: 'live upstream unavailable' }
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '')
    return { kind: 'error', status: upstream.ok ? 502 : upstream.status, body }
  }
  return { kind: 'stream', body: upstream.body }
}
```

- [ ] **Step 4: Create `apps/web/server/api/me/events.get.ts`**

```ts
/**
 * Fleet S4a §4: the signed-in user's notification stream. More specific than server/api/[...].ts, so Nitro routes
 * it here instead of proxyRequest. A refused upstream (401, 429 stream cap) passes its status through, which makes the
 * browser EventSource stop instead of retrying blindly; the bell then relies on its 60 s poll.
 */
import { buildUserLiveUpstreamUrl, LIVE_STREAM_HEADERS, openLiveUpstreamUrl } from '../../utils/live-proxy'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const result = await openLiveUpstreamUrl(buildUserLiveUpstreamUrl(String(config.apiInternalUrl ?? '')), {
    cookie: getRequestHeader(event, 'cookie'),
    // Response 'close' = the browser connection went away (see the project events route).
    onClientClose: cb => event.node.res.on('close', cb),
  })
  if (result.kind === 'error') {
    setResponseStatus(event, result.status)
    setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    return result.body
  }
  setResponseHeaders(event, { ...LIVE_STREAM_HEADERS })
  return sendStream(event, result.body).catch(() => undefined)
})
```

- [ ] **Step 5: Teach the stream client the `notification` event**

In `apps/web/lib/project-event-stream.ts`, after `LiveFleetLogEvent`:

```ts
/** S4a §4: content-free notice that the signed-in user has a new notification (GET /api/me/events); the bell refetches. */
export interface LiveNotificationEvent {
  id: string
  type: 'notification'
  userId: string
  at: string
}
```

Extend `ProjectEventHandlers` (keep the existing members):

```ts
  /** S4a: only the user stream (/api/me/events) sends these. */
  onNotification?: (event: LiveNotificationEvent) => void
```

Add the parser after `parseFleetLogEvent`:

```ts
export function parseNotificationEvent(raw: string): LiveNotificationEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveNotificationEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'notification' || typeof value.id !== 'string' || value.id.length === 0) return null
    return value as LiveNotificationEvent
  }
  catch {
    return null
  }
}
```

In `open()`, after the `onFleetLog` block:

```ts
    const onNotification = handlers.onNotification
    if (onNotification) {
      es.addEventListener('notification', (ev) => {
        const event = parseNotificationEvent(ev.data)
        if (event && isNew(event.id)) onNotification(event)
      })
    }
```

In `apps/web/lib/project-event-hub.ts`, add to the `fanOut` object:

```ts
    onNotification: (event) => { for (const e of current(url)) e.handlers.onNotification?.(event) },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/server tests/lib/project-event-stream tests/lib/project-event-hub`
Expected: PASS (the existing stream/hub specs too: a project subscriber that sets no `onNotification` gets no
`notification` listener, and `project-event-stream-fleet.spec.ts:109` still sees only `['ticket']`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/server/utils/live-proxy.ts apps/web/tests/server/live-proxy.spec.ts apps/web/server/api/me/events.get.ts \
  apps/web/lib/project-event-stream.ts apps/web/lib/project-event-hub.ts apps/web/tests/lib/project-event-stream-notification.spec.ts
git commit -m "feat(web): /api/me/events proxy and notification stream events (S4a §4)"
```

---

### Task B3: `useUserEvents`, `useNotifications`, `useNotificationPreferences`, `useTicketWatch`

**Files:**
- Create: `apps/web/composables/useUserEvents.ts`
- Create: `apps/web/composables/useNotifications.ts`
- Create: `apps/web/composables/useNotificationPreferences.ts`
- Create: `apps/web/composables/useTicketWatch.ts`
- Create: `apps/web/tests/composables/useUserEvents.spec.ts`
- Create: `apps/web/tests/composables/useNotifications.spec.ts`
- Create: `apps/web/tests/composables/useNotificationPreferences.spec.ts`
- Create: `apps/web/tests/composables/useTicketWatch.spec.ts`

**Interfaces:**
- Consumes: Task B1 types/paths and `$api.put`; Task B2 `onNotification`, `createProjectEventHub`.
- Produces:
  - `useUserEvents(onEvent: () => void): void`; `USER_EVENTS_URL = '/api/me/events'`; `USER_EVENTS_POLL_MS = 60_000`
  - `useNotifications(): { unreadCount: Ref<number>; latest: Ref<NotificationDto[]>; refresh(): Promise<void>; markRead(id: string): Promise<void>; markAllRead(): Promise<void>; list(opts: { current: number; unreadOnly: boolean }): Promise<NotificationPage> }`; `LATEST_SIZE = 10`; `LIST_SIZE = 20`
  - `useNotificationPreferences(): { items: Ref<NotificationPreferenceDto[]>; pending: Ref<boolean>; load(): Promise<void>; setInApp(category: NotificationCategory, inApp: boolean): Promise<void> }`
  - `useTicketWatch(slug: string, ticketRef: string): { state: Ref<WatchStateDto | null>; busy: Ref<boolean>; load(): Promise<void>; toggle(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/composables/useUserEvents.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(__dirname, '../../composables/useUserEvents.ts'), 'utf-8')

describe('useUserEvents (S4a §5)', () => {
  test('subscribes only on mount (never during SSR) and unsubscribes on unmount', () => {
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*\.subscribe\(USER_EVENTS_URL/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*unsubscribe\?\.\(\)/)
  })

  test('targets the proxied user stream and handles notices and resyncs', () => {
    expect(source).toContain("export const USER_EVENTS_URL = '/api/me/events'")
    expect(source).toContain('onNotification: () => onEvent()')
    expect(source).toContain('onResync: () => onEvent()')
  })

  test('keeps a 60 s visible-tab poll as the backstop when the stream is down or refused', () => {
    expect(source).toContain('export const USER_EVENTS_POLL_MS = 60_000')
    expect(source).toMatch(/useVisiblePolling\([\s\S]*USER_EVENTS_POLL_MS/)
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*polling\.start\(\)/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*polling\.stop\(\)/)
  })

  test('guards environments without EventSource and refreshes auth through useAuth', () => {
    expect(source).toContain("typeof EventSource === 'undefined'")
    expect(source).toContain('const { refresh } = useAuth()')
  })
})
```

Create `apps/web/tests/composables/useNotifications.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

const g = globalThis as Record<string, unknown>
const row = (id: string, readAt: string | null = null): NotificationDto => ({
  id, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', body: null, link: '/k/tickets/K-1', params: {},
  projectId: 'p1', actorId: 'u2', readAt, createdAt: '2026-10-08T00:00:00.000Z',
})
const page = (records: NotificationDto[], over: Partial<NotificationPage> = {}): NotificationPage =>
  ({ records, total: records.length, size: 10, current: 1, hasNext: false, ...over })

async function load(api: { get: jest.Mock; post?: jest.Mock }) {
  const state = new Map<string, Ref>()
  g.useApi = () => ({ $api: { post: jest.fn(async () => undefined), ...api } })
  g.useState = (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) }
  return (await import('~/composables/useNotifications')).useNotifications()
}

describe('useNotifications (S4a §5)', () => {
  afterEach(() => { delete g.useApi; delete g.useState })

  test('refresh loads the unread count and the latest 10', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 3 } : page([row('a'), row('b')])))
    const n = await load({ get })
    await n.refresh()
    expect(get).toHaveBeenCalledWith('/me/notifications/unread-count')
    expect(get).toHaveBeenCalledWith('/me/notifications', { query: { current: '1', size: '10' } })
    expect(n.unreadCount.value).toBe(3)
    expect(n.latest.value.map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('markRead posts to the encoded id route, then refreshes', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 0 } : page([])))
    const post = jest.fn(async () => undefined)
    const n = await load({ get, post })
    await n.markRead('c1/../x')
    expect(post).toHaveBeenCalledWith('/me/notifications/c1%2F..%2Fx/read')
    expect(get).toHaveBeenCalledWith('/me/notifications/unread-count')
  })

  test('markAllRead posts read-all, then refreshes', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 0 } : page([])))
    const post = jest.fn(async () => undefined)
    const n = await load({ get, post })
    await n.markAllRead()
    expect(post).toHaveBeenCalledWith('/me/notifications/read-all')
    expect(n.unreadCount.value).toBe(0)
  })

  test('list passes the page, a page size of 20 and the unread filter only when set', async () => {
    const get = jest.fn(async () => page([], { current: 2 }))
    const n = await load({ get })
    await n.list({ current: 2, unreadOnly: false })
    await n.list({ current: 1, unreadOnly: true })
    expect(get).toHaveBeenNthCalledWith(1, '/me/notifications', { query: { current: '2', size: '20' } })
    expect(get).toHaveBeenNthCalledWith(2, '/me/notifications', { query: { current: '1', size: '20', unread: 'true' } })
  })

  test('state is shared between callers in one tab (bell and page)', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/unread-count') ? { count: 7 } : page([])))
    const state = new Map<string, Ref>()
    g.useApi = () => ({ $api: { get, post: jest.fn() } })
    g.useState = (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) }
    const mod = await import('~/composables/useNotifications')
    await mod.useNotifications().refresh()
    expect(mod.useNotifications().unreadCount.value).toBe(7)
  })
})
```

Create `apps/web/tests/composables/useNotificationPreferences.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'

const g = globalThis as Record<string, unknown>
const ITEMS = [
  { category: 'ASSIGNED', inApp: true }, { category: 'MENTIONED', inApp: true }, { category: 'WATCHED_ACTIVITY', inApp: false },
  { category: 'FLEET_NEEDS_YOU', inApp: true }, { category: 'FLEET_HEALTH', inApp: true },
]

async function load(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
  return (await import('~/composables/useNotificationPreferences')).useNotificationPreferences()
}

describe('useNotificationPreferences (S4a §3)', () => {
  afterEach(() => { delete g.useApi })

  test('load reads the five categories', async () => {
    const get = jest.fn(async () => ({ items: ITEMS }))
    const prefs = await load({ get })
    await prefs.load()
    expect(get).toHaveBeenCalledWith('/me/notification-preferences')
    expect(prefs.items.value).toEqual(ITEMS)
  })

  test('setInApp PUTs one change and keeps the returned list', async () => {
    const next = ITEMS.map((i) => (i.category === 'ASSIGNED' ? { ...i, inApp: false } : i))
    const put = jest.fn(async () => ({ items: next }))
    const prefs = await load({ get: jest.fn(async () => ({ items: ITEMS })), put })
    await prefs.load()
    await prefs.setInApp('ASSIGNED', false)
    expect(put).toHaveBeenCalledWith('/me/notification-preferences', { items: [{ category: 'ASSIGNED', inApp: false }] })
    expect(prefs.items.value).toEqual(next)
  })

  test('a failed PUT rethrows and keeps the previous list', async () => {
    const prefs = await load({ get: jest.fn(async () => ({ items: ITEMS })), put: jest.fn(async () => { throw new Error('down') }) })
    await prefs.load()
    await expect(prefs.setInApp('ASSIGNED', false)).rejects.toThrow('down')
    expect(prefs.items.value).toEqual(ITEMS)
  })
})
```

Create `apps/web/tests/composables/useTicketWatch.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'

const g = globalThis as Record<string, unknown>

async function load(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
  return (await import('~/composables/useTicketWatch')).useTicketWatch('koda', 'KODA-1')
}

describe('useTicketWatch (S4a §3)', () => {
  afterEach(() => { delete g.useApi })

  test('load reads the caller watch state', async () => {
    const get = jest.fn(async () => ({ watching: false, count: 2 }))
    const w = await load({ get })
    await w.load()
    expect(get).toHaveBeenCalledWith('/projects/koda/tickets/KODA-1/watchers')
    expect(w.state.value).toEqual({ watching: false, count: 2 })
  })

  test('toggle watches with PUT when not watching, unwatches with DELETE when watching', async () => {
    const put = jest.fn(async () => ({ watching: true, count: 3 }))
    const del = jest.fn(async () => ({ watching: false, count: 2 }))
    const w = await load({ get: jest.fn(async () => ({ watching: false, count: 2 })), put, delete: del })
    await w.load()
    await w.toggle()
    expect(put).toHaveBeenCalledWith('/projects/koda/tickets/KODA-1/watch')
    expect(w.state.value).toEqual({ watching: true, count: 3 })
    await w.toggle()
    expect(del).toHaveBeenCalledWith('/projects/koda/tickets/KODA-1/watch')
    expect(w.state.value).toEqual({ watching: false, count: 2 })
    expect(w.busy.value).toBe(false)
  })

  test('toggle before load does nothing', async () => {
    const put = jest.fn()
    const w = await load({ get: jest.fn(), put, delete: jest.fn() })
    await w.toggle()
    expect(put).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/composables/useUserEvents.spec.ts tests/composables/useNotifications.spec.ts tests/composables/useNotificationPreferences.spec.ts tests/composables/useTicketWatch.spec.ts`
Expected: FAIL — the four composable files do not exist.

- [ ] **Step 3: Create `apps/web/composables/useUserEvents.ts`**

```ts
import { onBeforeUnmount, onMounted } from 'vue'
import { useVisiblePolling } from '~/composables/useVisiblePolling'
import { createProjectEventHub } from '~/lib/project-event-hub'
import type { ProjectEventHub } from '~/lib/project-event-hub'
import type { EventSourceLike } from '~/lib/project-event-stream'

export const USER_EVENTS_URL = '/api/me/events'
/** S4a §5: backstop poll; the stream is refused past the per-user stream cap (D509) or when the API is down. */
export const USER_EVENTS_POLL_MS = 60_000

let hub: ProjectEventHub | null = null
let latestRefresh: () => Promise<boolean> = async () => false

/** Created on first client mount only, so it never exists during SSR. */
function sharedHub(): ProjectEventHub {
  hub ??= createProjectEventHub({
    createEventSource: url => new EventSource(url) as unknown as EventSourceLike,
    refreshAuth: () => latestRefresh(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  return hub
}

/**
 * Fleet S4a §5: the signed-in user's notification notices. Every subscriber in the tab shares one EventSource
 * (the bell and the inbox page); `onEvent` also runs on resync and every 60 s while the tab is visible.
 * Client-only: subscribes on mount and unsubscribes on unmount.
 */
export function useUserEvents(onEvent: () => void): void {
  const { refresh } = useAuth()
  const polling = useVisiblePolling(async () => { onEvent() }, USER_EVENTS_POLL_MS)
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    polling.start()
    if (typeof EventSource === 'undefined') return
    latestRefresh = refresh
    unsubscribe = sharedHub().subscribe(USER_EVENTS_URL, {
      onNotification: () => onEvent(),
      onResync: () => onEvent(),
    })
  })

  onBeforeUnmount(() => {
    polling.stop()
    unsubscribe?.()
    unsubscribe = null
  })
}
```

- [ ] **Step 4: Create `apps/web/composables/useNotifications.ts`**

```ts
import type { Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { NOTIFICATIONS_PATH, READ_ALL_PATH, UNREAD_COUNT_PATH } from '~/lib/notification-types'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

/** The bell dropdown shows the newest 10 (S4a §5). */
export const LATEST_SIZE = 10
/** The inbox page size. */
export const LIST_SIZE = 20

/**
 * Fleet S4a §5: the signed-in user's inbox. `unreadCount` and `latest` live in tab state so the bell and the
 * inbox page show the same numbers; the API is the authority (every call is scoped to the caller).
 */
export function useNotifications() {
  const { $api } = useApi()
  const unreadCount = useState<number>('notifications-unread', () => 0) as Ref<number>
  const latest = useState<NotificationDto[]>('notifications-latest', () => []) as Ref<NotificationDto[]>

  async function refresh(): Promise<void> {
    const [count, page] = await Promise.all([
      $api.get<{ count: number }>(UNREAD_COUNT_PATH),
      $api.get<NotificationPage>(NOTIFICATIONS_PATH, { query: { current: '1', size: String(LATEST_SIZE) } }),
    ])
    unreadCount.value = count.count
    latest.value = page.records ?? []
  }

  async function markRead(id: string): Promise<void> {
    await $api.post(apiPath`/me/notifications/${id}/read`)
    await refresh()
  }

  async function markAllRead(): Promise<void> {
    await $api.post(READ_ALL_PATH)
    await refresh()
  }

  async function list(opts: { current: number; unreadOnly: boolean }): Promise<NotificationPage> {
    const query: Record<string, string> = { current: String(opts.current), size: String(LIST_SIZE) }
    return $api.get<NotificationPage>(NOTIFICATIONS_PATH, { query: opts.unreadOnly ? { ...query, unread: 'true' } : query })
  }

  return { unreadCount, latest, refresh, markRead, markAllRead, list }
}
```

- [ ] **Step 5: Create `apps/web/composables/useNotificationPreferences.ts`**

```ts
import { ref } from 'vue'
import { PREFERENCES_PATH } from '~/lib/notification-types'
import type { NotificationCategory, NotificationPreferenceDto } from '~/lib/notification-types'

interface PreferenceList {
  items?: NotificationPreferenceDto[]
}

/** Fleet S4a §3: the caller's per-category in-app toggles. */
export function useNotificationPreferences() {
  const { $api } = useApi()
  const items = ref<NotificationPreferenceDto[]>([])
  const pending = ref(false)

  async function load(): Promise<void> {
    pending.value = true
    try {
      items.value = (await $api.get<PreferenceList>(PREFERENCES_PATH)).items ?? []
    } finally {
      pending.value = false
    }
  }

  /** Rethrows on failure; the page reports it and keeps the previous list. */
  async function setInApp(category: NotificationCategory, inApp: boolean): Promise<void> {
    const res = await $api.put<PreferenceList>(PREFERENCES_PATH, { items: [{ category, inApp }] })
    items.value = res.items ?? items.value
  }

  return { items, pending, load, setInApp }
}
```

- [ ] **Step 6: Create `apps/web/composables/useTicketWatch.ts`**

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { WatchStateDto } from '~/lib/notification-types'

/** Fleet S4a §3: the caller's watch state on one ticket. Unwatch is a sticky mute on the API side (D502). */
export function useTicketWatch(slug: string, ticketRef: string) {
  const { $api } = useApi()
  const state = ref<WatchStateDto | null>(null)
  const busy = ref(false)

  async function load(): Promise<void> {
    state.value = await $api.get<WatchStateDto>(apiPath`/projects/${slug}/tickets/${ticketRef}/watchers`)
  }

  async function toggle(): Promise<void> {
    if (!state.value || busy.value) return
    busy.value = true
    try {
      const path = apiPath`/projects/${slug}/tickets/${ticketRef}/watch`
      state.value = state.value.watching
        ? await $api.delete<WatchStateDto>(path)
        : await $api.put<WatchStateDto>(path)
    } finally {
      busy.value = false
    }
  }

  return { state, busy, load, toggle }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/composables/useUserEvents.spec.ts tests/composables/useNotifications.spec.ts tests/composables/useNotificationPreferences.spec.ts tests/composables/useTicketWatch.spec.ts tests/lib/api-path-guard.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/composables/useUserEvents.ts apps/web/composables/useNotifications.ts \
  apps/web/composables/useNotificationPreferences.ts apps/web/composables/useTicketWatch.ts \
  apps/web/tests/composables/useUserEvents.spec.ts apps/web/tests/composables/useNotifications.spec.ts \
  apps/web/tests/composables/useNotificationPreferences.spec.ts apps/web/tests/composables/useTicketWatch.spec.ts
git commit -m "feat(web): notification, preference, watch and user-stream composables (S4a §5)"
```

---

### Task B4: `NotificationBell` in the header

**Files:**
- Create: `apps/web/components/NotificationBell.vue`
- Create: `apps/web/tests/components/notification-bell.spec.ts`
- Modify: `apps/web/layouts/default.vue:319-320`
- Create: `apps/web/tests/layouts/default-notification-bell.spec.ts`
- Modify: `apps/web/tests/e2e/fixtures/page-helpers.ts:62-72`
- Modify: `apps/web/tests/e2e/auth.spec.ts:26,60`

**Interfaces:**
- Consumes: `useNotifications()`, `useUserEvents(onEvent)` (Task B3); `notificationText`, `isInAppPath` (Task B1);
  `badgeText` from `~/lib/fleet-approvals` (99+ cap); `createDebouncer` from `~/lib/debounce`.
- Produces: `<NotificationBell />` (no props); test ids `notification-bell` (`data-count`), `notification-bell-count`,
  `notification-panel`, `notification-item` (`data-id`), `notification-mark-all`, `notification-view-all`,
  `notification-empty`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/components/notification-bell.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationDto } from '~/lib/notification-types'

const bell = webFile('components', 'NotificationBell.vue')
const row = (id: string, readAt: string | null = null, link = `/koda/tickets/KODA-${id}`): NotificationDto => ({
  id, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'fallback', body: null, link,
  params: { ref: `KODA-${id}`, ticketTitle: 'Fix', actorName: 'Ann' }, projectId: 'p1', actorId: 'u2', readAt,
  createdAt: '2026-10-08T00:00:00.000Z',
})

afterEach(() => { jest.useRealTimers() })

function mount(opts: { count?: number; latest?: NotificationDto[]; refresh?: jest.Mock; markRead?: jest.Mock; markAllRead?: jest.Mock } = {}) {
  const unreadCount = ref(opts.count ?? 0)
  const latest = ref<NotificationDto[]>(opts.latest ?? [])
  const fake = {
    unreadCount, latest,
    refresh: opts.refresh ?? jest.fn(async () => undefined),
    markRead: opts.markRead ?? jest.fn(async () => undefined),
    markAllRead: opts.markAllRead ?? jest.fn(async () => undefined),
    list: jest.fn(),
  }
  let live: (() => void) | null = null
  const navigate = jest.fn(async () => undefined)
  const toast = toastRecorder()
  const app = mountSfc(bell, {
    components: uiStubs,
    alias: {
      '~/composables/useNotifications': { useNotifications: () => fake },
      '~/composables/useUserEvents': { useUserEvents: (fn: () => void) => { live = fn } },
    },
    globals: {
      useI18n: () => enI18n(),
      navigateTo: navigate,
      useAppToast: () => toast,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, fake, navigate, toast, settle, byId, live: () => live, unreadCount, latest }
}

describe('NotificationBell (S4a §5)', () => {
  test('loads on mount and shows the unread count, capped at 99+', async () => {
    const m = mount({ count: 3 })
    await m.settle()
    expect(m.fake.refresh).toHaveBeenCalledTimes(1)
    expect(m.byId('notification-bell')[0].props['data-count']).toBe(3)
    expect(m.app.textOf(m.byId('notification-bell-count')[0])).toBe('3')
    m.unreadCount.value = 150
    await m.settle()
    expect(m.app.textOf(m.byId('notification-bell-count')[0])).toBe('99+')
    m.app.unmount()
  })

  test('no count badge when nothing is unread', async () => {
    const m = mount({ count: 0 })
    await m.settle()
    expect(m.byId('notification-bell-count')).toHaveLength(0)
    expect(String(m.byId('notification-bell')[0].props['aria-label'])).toBe('Notifications, 0 unread')
    m.app.unmount()
  })

  test('a live notice refreshes after the 300 ms debounce', async () => {
    jest.useFakeTimers()
    const m = mount()
    m.live()?.()
    m.live()?.()
    jest.advanceTimersByTime(300)
    jest.useRealTimers()
    await m.settle()
    // once on mount + once for the two debounced notices
    expect(m.fake.refresh).toHaveBeenCalledTimes(2)
    m.app.unmount()
  })

  test('opening the panel lists the latest items, worded from kind + params', async () => {
    const m = mount({ count: 1, latest: [row('1'), row('2', '2026-10-08T01:00:00.000Z')] })
    await m.settle()
    expect(m.byId('notification-panel')).toHaveLength(0)
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    const items = m.byId('notification-item')
    expect(items).toHaveLength(2)
    expect(m.app.textOf(items[0])).toContain('Ann assigned you KODA-1: Fix')
    expect(String(items[0].props.class)).toContain('font-medium')
    expect(String(items[1].props.class)).toContain('text-muted-foreground')
    m.app.unmount()
  })

  test('clicking an unread item marks it read, closes the panel and navigates to its link', async () => {
    const m = mount({ count: 1, latest: [row('7')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('notification-item')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.markRead).toHaveBeenCalledWith('7')
    expect(m.navigate).toHaveBeenCalledWith('/koda/tickets/KODA-7')
    expect(m.byId('notification-panel')).toHaveLength(0)
    m.app.unmount()
  })

  test('a read item is not marked again; an off-site link is never followed', async () => {
    const m = mount({ latest: [row('8', '2026-10-08T01:00:00.000Z', '//evil.example/x')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('notification-item')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.markRead).not.toHaveBeenCalled()
    expect(m.navigate).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('a failed mark-read still navigates', async () => {
    const m = mount({ count: 1, latest: [row('9')], markRead: jest.fn(async () => { throw new Error('down') }) })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    ;(m.byId('notification-item')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.navigate).toHaveBeenCalledWith('/koda/tickets/KODA-9')
    m.app.unmount()
  })

  test('Mark all read calls the composable and is disabled with nothing unread', async () => {
    const m = mount({ count: 2, latest: [row('1')] })
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.byId('notification-mark-all')[0].props.disabled).toBe(false)
    ;(m.byId('notification-mark-all')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.markAllRead).toHaveBeenCalledTimes(1)
    m.unreadCount.value = 0
    await m.settle()
    expect(m.byId('notification-mark-all')[0].props.disabled).toBe(true)
    m.app.unmount()
  })

  test('an empty inbox says so; View all links to /notifications', async () => {
    const m = mount()
    await m.settle()
    ;(m.byId('notification-bell')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.app.textOf(m.byId('notification-empty')[0])).toBe("You're all caught up.")
    expect(m.byId('notification-view-all')[0].props.to).toBe('/notifications')
    m.app.unmount()
  })

  test('a failed first load leaves the bell at 0 without throwing', async () => {
    const m = mount({ refresh: jest.fn(async () => { throw new Error('down') }) })
    await m.settle()
    expect(m.byId('notification-bell')[0].props['data-count']).toBe(0)
    m.app.unmount()
  })
})
```

Create `apps/web/tests/layouts/default-notification-bell.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, '../../layouts/default.vue'), 'utf-8')

describe('S4a §5: the header carries the notification bell', () => {
  test('signed-in users get the bell, before the fleet approval badge', () => {
    const bell = source.indexOf('<NotificationBell v-if="auth.user.value" />')
    const badge = source.indexOf('<FleetApprovalBadge')
    expect(bell).toBeGreaterThan(-1)
    expect(bell).toBeLessThan(badge)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/components/notification-bell.spec.ts tests/layouts/default-notification-bell.spec.ts`
Expected: FAIL — `NotificationBell.vue` missing; layout has no bell.

- [ ] **Step 3: Create `apps/web/components/NotificationBell.vue`**

```vue
<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="relative rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      :aria-label="t('notifications.bell.label', { count: unreadCount })"
      :title="t('notifications.bell.label', { count: unreadCount })"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="dialog"
      data-testid="notification-bell"
      :data-count="unreadCount"
      @click="toggle"
    >
      <BellDot v-if="unreadCount > 0" class="h-5 w-5" />
      <Bell v-else class="h-5 w-5" />
      <span
        v-if="unreadCount > 0"
        aria-live="polite"
        class="absolute -right-1 -top-1 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
        data-testid="notification-bell-count"
      >{{ badgeText(unreadCount) }}</span>
    </button>

    <div
      v-if="open"
      role="dialog"
      :aria-label="t('notifications.bell.title')"
      class="absolute right-0 z-40 mt-2 w-80 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
      data-testid="notification-panel"
      @keydown.esc="open = false"
    >
      <div class="flex items-center justify-between px-2 pb-2">
        <span class="text-sm font-semibold">{{ t('notifications.bell.title') }}</span>
        <button
          type="button"
          class="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="unreadCount === 0"
          data-testid="notification-mark-all"
          @click="onMarkAll"
        >
          {{ t('notifications.markAllRead') }}
        </button>
      </div>
      <p v-if="latest.length === 0" class="px-2 py-4 text-sm text-muted-foreground" data-testid="notification-empty">
        {{ t('notifications.empty') }}
      </p>
      <ul v-else class="max-h-96 space-y-1 overflow-y-auto">
        <li v-for="item in latest" :key="item.id">
          <button
            type="button"
            class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            :class="item.readAt ? 'text-muted-foreground' : 'font-medium text-foreground'"
            data-testid="notification-item"
            :data-id="item.id"
            @click="onOpen(item)"
          >
            <span class="block truncate">{{ notificationText(item, i18n) }}</span>
            <span v-if="item.body" class="block truncate text-xs text-muted-foreground">{{ item.body }}</span>
          </button>
        </li>
      </ul>
      <div class="mt-2 flex items-center justify-between border-t border-border px-2 pt-2 text-xs">
        <NuxtLink to="/notifications" class="text-primary hover:underline" data-testid="notification-view-all" @click="open = false">
          {{ t('notifications.viewAll') }}
        </NuxtLink>
        <NuxtLink to="/settings/notifications" class="text-muted-foreground hover:underline" @click="open = false">
          {{ t('notifications.settings') }}
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Bell, BellDot } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'
import { useNotifications } from '~/composables/useNotifications'
import { useUserEvents } from '~/composables/useUserEvents'
import { createDebouncer } from '~/lib/debounce'
import { badgeText } from '~/lib/fleet-approvals'
import { isInAppPath, notificationText } from '~/lib/notifications'
import type { NotificationDto } from '~/lib/notification-types'

/** Fleet S4a §5: header bell. Live notices and the 60 s poll refresh it; the API owns read state. */
const i18n = useI18n()
const { t } = i18n
const toast = useAppToast()
const { unreadCount, latest, refresh, markRead, markAllRead } = useNotifications()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

async function reload(): Promise<void> {
  try {
    await refresh()
  } catch {
    // Cosmetic: keep the last count; the next notice or poll retries.
  }
}

const liveReload = createDebouncer(() => { void reload() }, 300)
useUserEvents(() => liveReload.trigger())

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  void reload()
  if (typeof document !== 'undefined') document.addEventListener('click', onDocumentClick)
})
onBeforeUnmount(() => {
  liveReload.cancel()
  if (typeof document !== 'undefined') document.removeEventListener('click', onDocumentClick)
})

function toggle(): void {
  open.value = !open.value
  if (open.value) void reload()
}

async function onOpen(item: NotificationDto): Promise<void> {
  open.value = false
  if (!item.readAt) {
    try {
      await markRead(item.id)
    } catch {
      // Navigation still happens; the item stays unread until the next refresh.
    }
  }
  if (isInAppPath(item.link)) await navigateTo(item.link)
}

async function onMarkAll(): Promise<void> {
  try {
    await markAllRead()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}
</script>
```

- [ ] **Step 4: Mount the bell in `apps/web/layouts/default.vue`**

Replace the header line

```vue
          <FleetApprovalBadge v-if="auth.user.value" :key="projectSlug ?? ''" :slug="projectSlug ?? null" />
```

with

```vue
          <NotificationBell v-if="auth.user.value" />
          <FleetApprovalBadge v-if="auth.user.value" :key="projectSlug ?? ''" :slug="projectSlug ?? null" />
```

(`components/NotificationBell.vue` is auto-imported by Nuxt under `NotificationBell`.)

- [ ] **Step 5: Stop E2E from waiting for `networkidle`**

Every page now holds `/api/me/events` open, so `networkidle` never settles. In
`apps/web/tests/e2e/fixtures/page-helpers.ts`, replace steps 3 and 4 of `webLogin` with:

```ts
  // 3. Navigate to the app and wait for full hydration. Every page holds the
  // notification stream (/api/me/events) open, so 'networkidle' never settles.
  await page.goto(webUrl);
  await waitForHydration(page);

  // 4. Retry a few times if middleware still routes to /login while hydrating
  for (let attempt = 0; attempt < 3 && page.url().endsWith('/login'); attempt += 1) {
    await page.waitForTimeout(300 * (attempt + 1));
    await page.goto(webUrl);
    await waitForHydration(page);
  }
```

In `apps/web/tests/e2e/auth.spec.ts`, add `waitForHydration` to the `page-helpers` import and replace both

```ts
    await page.reload({ waitUntil: 'networkidle' });
```

with

```ts
    await page.reload();
    await waitForHydration(page);
```

Then confirm no other spec waits for it: `grep -rn "waitUntil: 'networkidle'\|waitForLoadState('networkidle')" apps/web/tests/e2e`
must print nothing (comments mentioning the word are fine).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/notification-bell.spec.ts tests/layouts/ tests/i18n/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/NotificationBell.vue apps/web/tests/components/notification-bell.spec.ts \
  apps/web/layouts/default.vue apps/web/tests/layouts/default-notification-bell.spec.ts \
  apps/web/tests/e2e/fixtures/page-helpers.ts apps/web/tests/e2e/auth.spec.ts
git commit -m "feat(web): header notification bell with live count and dropdown (S4a §5)"
```

---

### Task B5: `/notifications` inbox page

**Files:**
- Create: `apps/web/pages/notifications.vue`
- Create: `apps/web/tests/pages/notifications-page.spec.ts`

**Interfaces:**
- Consumes: `useNotifications().list/markRead/markAllRead/unreadCount`, `useUserEvents`, `notificationText`,
  `isInAppPath`.
- Produces: route `/notifications`; test ids `notifications-filter-all`, `notifications-filter-unread`,
  `notifications-row` (`data-id`), `notifications-mark-all`, `notifications-prev`, `notifications-next`,
  `notifications-empty`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/pages/notifications-page.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

const page = webFile('pages', 'notifications.vue')
const row = (id: string, readAt: string | null = null): NotificationDto => ({
  id, category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: 'nice fix', link: `/koda/tickets/KODA-${id}`,
  params: { ref: `KODA-${id}`, ticketTitle: 'x', actorName: 'Bo' }, projectId: 'p1', actorId: 'u2', readAt,
  createdAt: '2026-10-08T00:00:00.000Z',
})
const pageOf = (records: NotificationDto[], over: Partial<NotificationPage> = {}): NotificationPage =>
  ({ records, total: records.length, size: 20, current: 1, hasNext: false, ...over })

function mountPage(list: jest.Mock, opts: { markRead?: jest.Mock; markAllRead?: jest.Mock } = {}) {
  const fake = {
    unreadCount: ref(1), latest: ref([]), refresh: jest.fn(async () => undefined), list,
    markRead: opts.markRead ?? jest.fn(async () => undefined),
    markAllRead: opts.markAllRead ?? jest.fn(async () => undefined),
  }
  let live: (() => void) | null = null
  const navigate = jest.fn(async () => undefined)
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: {
      '~/composables/useNotifications': { useNotifications: () => fake },
      '~/composables/useUserEvents': { useUserEvents: (fn: () => void) => { live = fn } },
    },
    globals: { useI18n: () => enI18n(), navigateTo: navigate, useAppToast: () => toast, definePageMeta: () => undefined },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  const click = (id: string, index = 0) => (byId(id)[index].props.onClick as () => void)()
  return { app, fake, navigate, toast, settle, byId, click, live: () => live }
}

describe('/notifications (S4a §5)', () => {
  test('loads page 1 of everything on mount', async () => {
    const list = jest.fn(async () => pageOf([row('1'), row('2', '2026-10-08T01:00:00.000Z')]))
    const p = mountPage(list)
    await p.settle()
    expect(list).toHaveBeenCalledWith({ current: 1, unreadOnly: false })
    expect(p.byId('notifications-row')).toHaveLength(2)
    expect(p.app.textOf(p.byId('notifications-row')[0])).toContain('Bo commented on KODA-1')
    expect(p.app.textOf(p.byId('notifications-row')[0])).toContain('nice fix')
  })

  test('the Unread filter reloads page 1 with unreadOnly', async () => {
    const list = jest.fn(async () => pageOf([]))
    const p = mountPage(list)
    await p.settle()
    p.click('notifications-filter-unread')
    await p.settle()
    expect(list).toHaveBeenLastCalledWith({ current: 1, unreadOnly: true })
    expect(p.app.textOf(p.byId('notifications-empty')[0])).toBe('No unread notifications.')
    expect(p.byId('notifications-filter-unread')[0].props['aria-pressed']).toBe('true')
  })

  test('Next and Previous page through the list', async () => {
    const list = jest.fn(async (opts: { current: number }) => pageOf([row(String(opts.current))], { current: opts.current, hasNext: opts.current === 1 }))
    const p = mountPage(list as jest.Mock)
    await p.settle()
    expect(p.byId('notifications-prev')[0].props.disabled).toBe(true)
    p.click('notifications-next')
    await p.settle()
    expect(list).toHaveBeenLastCalledWith({ current: 2, unreadOnly: false })
    expect(p.byId('notifications-next')[0].props.disabled).toBe(true)
    p.click('notifications-prev')
    await p.settle()
    expect(list).toHaveBeenLastCalledWith({ current: 1, unreadOnly: false })
  })

  test('opening an unread row marks it read and navigates', async () => {
    const p = mountPage(jest.fn(async () => pageOf([row('5')])))
    await p.settle()
    p.click('notifications-row')
    await p.settle()
    expect(p.fake.markRead).toHaveBeenCalledWith('5')
    expect(p.navigate).toHaveBeenCalledWith('/koda/tickets/KODA-5')
  })

  test('Mark all read reloads the current page; a failure is reported', async () => {
    const list = jest.fn(async () => pageOf([row('1')]))
    const p = mountPage(list, { markAllRead: jest.fn(async () => { throw new Error('nope') }) })
    await p.settle()
    p.click('notifications-mark-all')
    await p.settle()
    expect(p.toast.errors).toEqual(['nope'])
  })

  test('a live notice reloads the page shown', async () => {
    const list = jest.fn(async () => pageOf([]))
    const p = mountPage(list)
    await p.settle()
    p.live()?.()
    await new Promise((resolve) => { setTimeout(resolve, 320) })
    await p.settle()
    expect(list).toHaveBeenCalledTimes(2)
  })

  test('a failed load shows the error state with retry', async () => {
    const list = jest.fn<() => Promise<NotificationPage>>().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(pageOf([row('1')]))
    const p = mountPage(list as jest.Mock)
    await p.settle()
    const error = p.app.find('[data-stub="error-state"]')
    expect(error).toHaveLength(1)
    ;(error[0].props.onRetry as () => void)()
    await p.settle()
    expect(p.byId('notifications-row')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/notifications-page.spec.ts`
Expected: FAIL — `pages/notifications.vue` missing.

- [ ] **Step 3: Create `apps/web/pages/notifications.vue`**

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useNotifications } from '~/composables/useNotifications'
import { useUserEvents } from '~/composables/useUserEvents'
import { createDebouncer } from '~/lib/debounce'
import { isInAppPath, notificationText } from '~/lib/notifications'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

definePageMeta({ layout: 'default' })

/** Fleet S4a §5: the full inbox, newest first, with an unread filter. */
const i18n = useI18n()
const { t } = i18n
const toast = useAppToast()
const { list, markRead, markAllRead, unreadCount } = useNotifications()

const unreadOnly = ref(false)
const data = ref<NotificationPage | null>(null)
const failed = ref(false)

async function load(current = 1): Promise<void> {
  try {
    data.value = await list({ current, unreadOnly: unreadOnly.value })
    failed.value = false
  } catch {
    failed.value = true
  }
}

async function setFilter(value: boolean): Promise<void> {
  unreadOnly.value = value
  await load(1)
}

async function open(item: NotificationDto): Promise<void> {
  if (!item.readAt) {
    try {
      await markRead(item.id)
    } catch {
      // Navigation still happens.
    }
  }
  if (isInAppPath(item.link)) await navigateTo(item.link)
}

async function readAll(): Promise<void> {
  try {
    await markAllRead()
    await load(data.value?.current ?? 1)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

const liveReload = createDebouncer(() => { void load(data.value?.current ?? 1) }, 300)
useUserEvents(() => liveReload.trigger())
onMounted(() => { void load(1) })
onBeforeUnmount(() => liveReload.cancel())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('notifications.title')" :subtitle="t('notifications.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="unreadCount === 0" data-testid="notifications-mark-all" @click="readAll()">
          {{ t('notifications.markAllRead') }}
        </Button>
      </template>
    </PageHeader>

    <div class="flex gap-2">
      <Button
        size="sm"
        :variant="unreadOnly ? 'outline' : 'default'"
        :aria-pressed="unreadOnly ? 'false' : 'true'"
        data-testid="notifications-filter-all"
        @click="setFilter(false)"
      >
        {{ t('notifications.filter.all') }}
      </Button>
      <Button
        size="sm"
        :variant="unreadOnly ? 'default' : 'outline'"
        :aria-pressed="unreadOnly ? 'true' : 'false'"
        data-testid="notifications-filter-unread"
        @click="setFilter(true)"
      >
        {{ t('notifications.filter.unread') }}
      </Button>
    </div>

    <ErrorState v-if="failed && !data" @retry="load(1)" />
    <LoadingState v-else-if="!data" />
    <p v-else-if="data.records.length === 0" class="text-sm text-muted-foreground" data-testid="notifications-empty">
      {{ unreadOnly ? t('notifications.emptyUnread') : t('notifications.empty') }}
    </p>
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li v-for="item in data.records" :key="item.id">
        <button
          type="button"
          class="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent"
          :class="item.readAt ? 'text-muted-foreground' : 'text-foreground'"
          data-testid="notifications-row"
          :data-id="item.id"
          @click="open(item)"
        >
          <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="item.readAt ? 'bg-transparent' : 'bg-primary'" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm" :class="item.readAt ? '' : 'font-medium'">{{ notificationText(item, i18n) }}</span>
            <span v-if="item.body" class="block truncate text-xs text-muted-foreground">{{ item.body }}</span>
          </span>
          <time class="shrink-0 text-xs text-muted-foreground" :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time>
        </button>
      </li>
    </ul>

    <div v-if="data" class="flex gap-2">
      <Button variant="outline" size="sm" :disabled="data.current <= 1" data-testid="notifications-prev" @click="load(data.current - 1)">
        {{ t('notifications.prev') }}
      </Button>
      <Button variant="outline" size="sm" :disabled="!data.hasNext" data-testid="notifications-next" @click="load(data.current + 1)">
        {{ t('notifications.next') }}
      </Button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bunx jest tests/pages/notifications-page.spec.ts tests/i18n/used-keys-exist.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/pages/notifications.vue apps/web/tests/pages/notifications-page.spec.ts
git commit -m "feat(web): /notifications inbox page (S4a §5)"
```

---

### Task B6: `/settings/notifications` preferences page

**Files:**
- Create: `apps/web/pages/settings/notifications.vue`
- Create: `apps/web/tests/pages/notification-settings-page.spec.ts`

**Interfaces:**
- Consumes: `useNotificationPreferences()` (Task B3), `NOTIFICATION_CATEGORIES` (Task B1).
- Produces: route `/settings/notifications`; test ids `notification-pref-<CATEGORY>` (the checkbox).

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/pages/notification-settings-page.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { NotificationPreferenceDto } from '~/lib/notification-types'

const page = webFile('pages', 'settings', 'notifications.vue')
const ALL: NotificationPreferenceDto[] = [
  { category: 'ASSIGNED', inApp: true }, { category: 'MENTIONED', inApp: true }, { category: 'WATCHED_ACTIVITY', inApp: false },
  { category: 'FLEET_NEEDS_YOU', inApp: true }, { category: 'FLEET_HEALTH', inApp: true },
]

function mountPage(setInApp: jest.Mock, load: jest.Mock = jest.fn(async () => undefined)) {
  const items = ref<NotificationPreferenceDto[]>([])
  const fake = {
    items, pending: ref(false), setInApp,
    load: jest.fn(async () => { await load(); items.value = ALL }),
  }
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '~/composables/useNotificationPreferences': { useNotificationPreferences: () => fake } },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast, definePageMeta: () => undefined },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const box = (c: string) => app.find(`[data-testid="notification-pref-${c}"]`)[0]
  return { app, fake, toast, settle, box }
}

describe('/settings/notifications (S4a §5)', () => {
  test('lists the five categories with their labels and current state', async () => {
    const p = mountPage(jest.fn())
    await p.settle()
    expect(p.app.text()).toContain('Assigned to me')
    expect(p.app.text()).toContain('Fleet health')
    expect(p.box('ASSIGNED').props.checked).toBe(true)
    expect(p.box('WATCHED_ACTIVITY').props.checked).toBe(false)
  })

  test('toggling saves that one category and confirms', async () => {
    const setInApp = jest.fn(async () => undefined)
    const p = mountPage(setInApp)
    await p.settle()
    ;(p.box('ASSIGNED').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await p.settle()
    expect(setInApp).toHaveBeenCalledWith('ASSIGNED', false)
    expect(p.toast.successes).toEqual(['Notification settings saved'])
  })

  test('a failed save reports the error and reloads the stored state', async () => {
    const p = mountPage(jest.fn(async () => { throw new Error('nope') }))
    await p.settle()
    ;(p.box('MENTIONED').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await p.settle()
    expect(p.toast.errors).toEqual(['nope'])
    expect(p.fake.load).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/notification-settings-page.spec.ts`
Expected: FAIL — `pages/settings/notifications.vue` missing.

- [ ] **Step 3: Create `apps/web/pages/settings/notifications.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useNotificationPreferences } from '~/composables/useNotificationPreferences'
import { NOTIFICATION_CATEGORIES } from '~/lib/notification-types'
import type { NotificationCategory } from '~/lib/notification-types'

definePageMeta({ layout: 'default' })

/** Fleet S4a §5: per-category in-app toggles (a missing row means on; the API resolves defaults). */
const { t } = useI18n()
const toast = useAppToast()
const { items, pending, load, setInApp } = useNotificationPreferences()

const rows = computed(() => NOTIFICATION_CATEGORIES.map((category) => ({
  category,
  inApp: items.value.find((i) => i.category === category)?.inApp ?? true,
})))

async function reload(): Promise<void> {
  try {
    await load()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

async function onToggle(category: NotificationCategory, event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  try {
    await setInApp(category, checked)
    toast.success(t('notifications.preferences.saved'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    await reload()
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <PageHeader :title="t('notifications.preferences.title')" :subtitle="t('notifications.preferences.subtitle')" />
    <LoadingState v-if="pending && items.length === 0" />
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li v-for="row in rows" :key="row.category" class="flex items-center justify-between gap-4 px-4 py-3">
        <label :for="`notification-pref-${row.category}`" class="min-w-0">
          <span class="block text-sm font-medium">{{ t(`notifications.categories.${row.category}.label`) }}</span>
          <span class="block text-xs text-muted-foreground">{{ t(`notifications.categories.${row.category}.description`) }}</span>
        </label>
        <span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {{ t('notifications.preferences.inApp') }}
          <input
            :id="`notification-pref-${row.category}`"
            type="checkbox"
            class="h-4 w-4 accent-primary"
            :checked="row.inApp"
            :data-testid="`notification-pref-${row.category}`"
            @change="onToggle(row.category, $event)"
          >
        </span>
      </li>
    </ul>
  </div>
</template>
```

`tests/i18n/used-keys-exist.spec.ts` only checks literal keys; the two template-literal keys resolve to the
`notifications.categories.<C>.label/description` entries that `notifications-locale-parity.spec.ts` pins.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bunx jest tests/pages/notification-settings-page.spec.ts tests/i18n/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/pages/settings/notifications.vue apps/web/tests/pages/notification-settings-page.spec.ts
git commit -m "feat(web): notification preferences page (S4a §5)"
```

---

### Task B7: Watch/Unwatch on ticket detail

**Files:**
- Create: `apps/web/components/TicketWatchButton.vue`
- Create: `apps/web/tests/components/ticket-watch-button.spec.ts`
- Modify: `apps/web/pages/[project]/tickets/[ref].vue:1-9` (import) and `:286-298` (right column)

**Interfaces:**
- Consumes: `useTicketWatch(slug, ticketRef)` (Task B3).
- Produces: `<TicketWatchButton :project-slug :ticket-ref />`; test ids `ticket-watch-toggle` (`aria-pressed`),
  `ticket-watch-count`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/components/ticket-watch-button.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { WatchStateDto } from '~/lib/notification-types'

const component = webFile('components', 'TicketWatchButton.vue')

function mount(initial: WatchStateDto | null, opts: { load?: jest.Mock; toggle?: jest.Mock } = {}) {
  const state = ref<WatchStateDto | null>(null)
  const fake = {
    state, busy: ref(false),
    load: opts.load ?? jest.fn(async () => { state.value = initial }),
    toggle: opts.toggle ?? jest.fn(async () => {
      state.value = state.value ? { watching: !state.value.watching, count: state.value.count + (state.value.watching ? -1 : 1) } : null
    }),
  }
  const calls: unknown[][] = []
  const toast = toastRecorder()
  const app = mountSfc(component, {
    components: uiStubs,
    props: { projectSlug: 'koda', ticketRef: 'KODA-1' },
    alias: { '~/composables/useTicketWatch': { useTicketWatch: (...args: unknown[]) => { calls.push(args); return fake } } },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  return { app, fake, calls, toast, settle, byId }
}

describe('TicketWatchButton (S4a §5)', () => {
  test('loads the state for this ticket and shows Watch with the count', async () => {
    const m = mount({ watching: false, count: 2 })
    await m.settle()
    expect(m.calls).toEqual([['koda', 'KODA-1']])
    expect(m.app.textOf(m.byId('ticket-watch-toggle')[0])).toContain('Watch')
    expect(m.byId('ticket-watch-toggle')[0].props['aria-pressed']).toBe('false')
    expect(m.app.textOf(m.byId('ticket-watch-count')[0])).toBe('2 watching')
  })

  test('clicking toggles to Unwatch', async () => {
    const m = mount({ watching: false, count: 2 })
    await m.settle()
    ;(m.byId('ticket-watch-toggle')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.fake.toggle).toHaveBeenCalledTimes(1)
    expect(m.app.textOf(m.byId('ticket-watch-toggle')[0])).toContain('Unwatch')
    expect(m.app.textOf(m.byId('ticket-watch-count')[0])).toBe('3 watching')
  })

  test('a failed toggle tells the user', async () => {
    const m = mount({ watching: true, count: 1 }, { toggle: jest.fn(async () => { throw new Error('x') }) })
    await m.settle()
    ;(m.byId('ticket-watch-toggle')[0].props.onClick as () => void)()
    await m.settle()
    expect(m.toast.errors).toEqual(['Could not update watching'])
  })

  test('a failed load renders nothing (the ticket page stays usable)', async () => {
    const m = mount(null, { load: jest.fn(async () => { throw new Error('403') }) })
    await m.settle()
    expect(m.byId('ticket-watch-toggle')).toHaveLength(0)
  })

  test('the ticket page mounts it above the properties rail', () => {
    const source = readFileSync(join(__dirname, '../../pages/[project]/tickets/[ref].vue'), 'utf-8')
    expect(source).toContain("import TicketWatchButton from '~/components/TicketWatchButton.vue'")
    const button = source.indexOf('<TicketWatchButton :project-slug="slug" :ticket-ref="ref"')
    expect(button).toBeGreaterThan(-1)
    expect(button).toBeLessThan(source.indexOf('<TicketProperties'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/components/ticket-watch-button.spec.ts`
Expected: FAIL — `TicketWatchButton.vue` missing.

- [ ] **Step 3: Create `apps/web/components/TicketWatchButton.vue`**

```vue
<template>
  <div v-if="state" class="flex items-center gap-2">
    <Button
      size="sm"
      variant="outline"
      :disabled="busy"
      :aria-pressed="state.watching ? 'true' : 'false'"
      data-testid="ticket-watch-toggle"
      @click="onToggle"
    >
      <EyeOff v-if="state.watching" class="mr-1.5 h-4 w-4" />
      <Eye v-else class="mr-1.5 h-4 w-4" />
      {{ state.watching ? t('notifications.watch.unwatch') : t('notifications.watch.watch') }}
    </Button>
    <span class="text-xs text-muted-foreground" data-testid="ticket-watch-count">
      {{ t('notifications.watch.count', { count: state.count }) }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { Eye, EyeOff } from 'lucide-vue-next'
import { useTicketWatch } from '~/composables/useTicketWatch'

/** Fleet S4a §5: watch or mute one ticket. Unwatch is sticky; assignment and @mentions still notify (D502). */
const props = defineProps<{ projectSlug: string; ticketRef: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { state, busy, load, toggle } = useTicketWatch(props.projectSlug, props.ticketRef)

onMounted(async () => {
  try {
    await load()
  } catch {
    // No button: watching is optional and the ticket page must stay usable.
  }
})

async function onToggle(): Promise<void> {
  try {
    await toggle()
  } catch {
    toast.error(t('notifications.watch.failed'))
  }
}
</script>
```

- [ ] **Step 4: Mount it on ticket detail**

In `apps/web/pages/[project]/tickets/[ref].vue`, add after `import TicketFleetRuns from '~/components/TicketFleetRuns.vue'`:

```ts
import TicketWatchButton from '~/components/TicketWatchButton.vue'
```

and in the right-hand column replace

```vue
      <div class="min-w-0 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[72px] lg:self-start">
        <TicketProperties
```

with

```vue
      <div class="min-w-0 space-y-3 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[72px] lg:self-start">
        <TicketWatchButton :project-slug="slug" :ticket-ref="ref" />
        <TicketProperties
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/ticket-watch-button.spec.ts tests/pages/ticket-detail tests/components/ticket-detail-redesign.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/TicketWatchButton.vue apps/web/tests/components/ticket-watch-button.spec.ts \
  "apps/web/pages/[project]/tickets/[ref].vue"
git commit -m "feat(web): watch and unwatch a ticket from its detail page (S4a §5)"
```

---

### Task B8: E2E, gates and PR 2

**Files:**
- Modify: `apps/web/tests/e2e/fixtures/api-client.ts`
- Create: `apps/web/tests/e2e/notifications.e2e.spec.ts`
- Modify: `.nax/mono/apps/web/context.md`

**Interfaces:**
- Consumes: API `POST /api/projects/:slug/tickets/:ref/assign` (`{ userId }`), Part A's outbox-driven
  `ticket_assigned` producer (outbox poll 1 s, `apps/api/src/config/outbox.config.ts:63`).
- Produces: `assignTicket(token: string, projectSlug: string, ticketRef: string, userId: string): Promise<void>`.

- [ ] **Step 1: Add the fixture**

Append to `apps/web/tests/e2e/fixtures/api-client.ts` (before `E2E_ADMIN`):

```ts
export async function assignTicket(
  token: string,
  projectSlug: string,
  ticketRef: string,
  userId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/tickets/${ticketRef}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(`Assign ticket failed: ${res.status} ${await res.text()}`);
}
```

- [ ] **Step 2: Write the E2E**

Create `apps/web/tests/e2e/notifications.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import {
  addProjectMember, assignTicket, createProject, createTicket, createUser, deleteProject, login, E2E_ADMIN,
} from './fixtures/api-client';
import { generateUniqueProjectKey, waitForHydration, webLogin } from './fixtures/page-helpers';

/**
 * Fleet S4a §8: A (the admin) assigns a ticket to B over the API; B's header bell rises live without a reload;
 * clicking the notification marks it read and opens the ticket.
 */
const MEMBER = { email: 'notify-member@koda-e2e.test', name: 'Notify Member', password: 'E2ePassword1!' };

test.describe('Notifications (S4a)', () => {
  let token: string;
  let slug: string;
  let memberId: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    slug = (await createProject(token, { name: 'E2E Notify', slug: `e2entf${suffix}`, key: generateUniqueProjectKey('NT') })).slug;
    await createUser(token, MEMBER);
    await addProjectMember(token, slug, MEMBER.email, 'DEVELOPER');
    // Same cached session webLogin uses below: no extra /auth/login hit.
    ({ userId: memberId } = await login(MEMBER.email, MEMBER.password));
  });

  test.afterAll(async () => {
    if (slug) await deleteProject(token, slug);
  });

  test('an assignment reaches B\'s bell live; clicking it reads it and opens the ticket', async ({ page }) => {
    const title = `Notify me ${Date.now()}`;
    const ticket = await createTicket(token, slug, { title, type: 'BUG' });
    await webLogin(page, MEMBER.email, MEMBER.password);

    const streamOpen = page.waitForResponse(
      (res) => res.url().includes('/api/me/events') && res.status() === 200,
      { timeout: 10000 },
    );
    await page.goto(`/${slug}`);
    await streamOpen;
    await waitForHydration(page);
    const bell = page.getByTestId('notification-bell');
    const before = Number(await bell.getAttribute('data-count'));
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    await assignTicket(token, slug, ticket.ref, memberId);

    await expect(bell).toHaveAttribute('data-count', String(before + 1), { timeout: 10000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    await bell.click();
    const item = page.getByTestId('notification-item').filter({ hasText: ticket.ref }).first();
    await expect(item).toContainText(`assigned you ${ticket.ref}: ${title}`);
    await item.click();

    await expect(page).toHaveURL(new RegExp(`/${slug}/tickets/${ticket.ref}$`));
    await expect(page.getByTestId('notification-bell')).toHaveAttribute('data-count', String(before), { timeout: 5000 });
    // The assignee is auto-watching (spec §2.2): the detail page says so.
    await expect(page.getByTestId('ticket-watch-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the inbox page lists it as read and the preferences page shows five toggles', async ({ page }) => {
    await webLogin(page, MEMBER.email, MEMBER.password);
    await page.goto('/notifications');
    await waitForHydration(page);
    await expect(page.getByTestId('notifications-row').first()).toBeVisible();

    await page.goto('/settings/notifications');
    await waitForHydration(page);
    for (const c of ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH']) {
      await expect(page.getByTestId(`notification-pref-${c}`)).toBeVisible();
    }
  });
});
```

- [ ] **Step 3: Run the E2E**

```bash
cd apps/api && bun run test:db:up
cd ../web && bunx playwright test tests/e2e/notifications.e2e.spec.ts tests/e2e/auth.spec.ts tests/e2e/live-board.spec.ts
```

Expected: PASS. If the bell assertion times out, check the API log for the `ticket_event` fan-out
(`Registered N handlers` must include Part A's subscriber) before touching the web.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/fixtures/api-client.ts apps/web/tests/e2e/notifications.e2e.spec.ts
git commit -m "test(web): e2e for live notification bell and inbox (S4a §8)"
```

- [ ] **Step 5: Full gates** (all must pass; fix and amend into the owning task's commit if anything fails)

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
cd apps/web && bun run lint && bun run type-check && bun run test
E2E_WEB_MODE=build bunx turbo run build --filter=@nathapp/koda-web && E2E_WEB_MODE=build bunx playwright test
```

Expected: every command exits 0. The full Playwright run matters here: Task B4 changed `webLogin`, which every
spec uses.

- [ ] **Step 6: Docs** — in `.nax/mono/apps/web/context.md` add a section:

```markdown
## Notifications (S4a)

- Header `components/NotificationBell.vue` (every signed-in page) reads `useNotifications()` (tab-shared
  `useState`), refreshed by `useUserEvents()`: one EventSource to `/api/me/events` per tab (shared hub,
  `server/api/me/events.get.ts`) plus a 60 s visible-tab poll backstop. Pages `/notifications` and
  `/settings/notifications`; `components/TicketWatchButton.vue` on ticket detail.
- Notification copy comes from `notifications.kinds.<kind>` with the row's `params`; an unknown kind falls back to the
  API `title`. A new kind needs both locales (pinned by `tests/i18n/notifications-locale-parity.spec.ts`).
- Every page holds a live stream open: E2E must never wait for `networkidle`; use `waitForHydration`.
```

then regenerate the agent files and commit:

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
nax generate --all-packages
git add .nax/mono/apps/web/context.md && git add -u   # -u picks up every regenerated agent file
git status --short   # expect only context.md and generated agent files
git commit -m "docs: web context for notifications"
```

- [ ] **Step 7: Push and open the PR** (only with the user's go-ahead to push)

```bash
git push -u origin feat/fleet-s4a-2-inbox-web
gh pr create --base main --title "feat(fleet): S4a PR 2 — notification inbox web" --body "$(cat <<'BODY'
## Summary
- Header notification bell on every signed-in page: unread count (99+), dropdown of the latest 10, click = mark read + open, Mark all read (S4a spec §5).
- Live via `GET /api/me/events` (new Nitro proxy, shared per-tab EventSource) with a 60 s poll backstop.
- `/notifications` inbox (unread filter, pagination) and `/settings/notifications` (five per-category toggles).
- Watch / Unwatch button on ticket detail.
- E2E `webLogin` no longer waits for `networkidle` (every page now holds a live stream).
- Plan: `docs/superpowers/plans/2026-10-08-fleet-s4a-notifications-core.md` (Part B).

## Test plan
- [ ] web unit + lint + type-check
- [ ] e2e: notifications, auth, live-board, then the full suite (webLogin changed)
BODY
)"
```

---

## Part C — PR 3: @mentions

Implements spec §2.3 (mentions), the `MENTIONED` rows of §2.2, and the mention UI of §5. Branch
`feat/fleet-s4a-3-mentions` cut from `main` after PR 1 merged (independent of PR 2; if PR 2 merged first, rebase is
trivial — the only shared files are the locale JSONs).

Ground truth this part builds on (verified on `main` `d9a23c16`):

- `TICKET_UPDATED` data is exactly the changed fields (`tickets.service.ts:267`, `{ ...updateData }`); the previous
  description is not recorded. `applyUpdate` already loads the ticket (`findByRef`) before the write.
- `COMMENT_ADDED` data is `{ commentId }` only, from user comments (`comments.service.ts:100`), transition comments
  (`ticket-transitions.service.ts:126`) and fleet system comments (`fleet-job-ticket.effects.ts:99`). `Comment` has no
  soft delete.
- No other consumer reads `TICKET_UPDATED` `data` fields (only `live-event.ts` maps the action), so adding
  `previousDescription` is additive.
- Web comments render as plain text (`CommentThread.vue:150`, `{{ comment.body }}`); descriptions render through
  `renderMarkdownOrEscape` + DOMPurify, whose `uponSanitizeAttribute` hook keeps `class` only on `<code
  class="language-*">` (`lib/markdown.ts:24-33`). A chip class therefore needs an explicit allowance.
- `useProjectMemberNames(slug)` loads one page of 100 members and exposes `nameOf(userId)`; it is a mount-sfc auto-import.

### File Structure (Part C)

API (`apps/api`):
- Create `src/notifications/mentions.ts` — `parseMentions`, `MENTION_LIMIT`.
- Create `src/notifications/mentions.spec.ts`.
- Modify `src/tickets/tickets.service.ts:239-270` — `previousDescription` on description changes.
- Modify `src/tickets/tickets.service.spec.ts` — event data tests.
- Modify `src/notifications/ticket-mention.resolver.ts` — Part A seam body (parse + visibility filter).
- Create `src/notifications/ticket-mention.resolver.spec.ts`.
- Modify `src/notifications/ticket-notification.rules.ts` (+ spec) — `TICKET_UPDATED`.
- Modify `src/notifications/ticket-notification.subscriber.ts` (+ spec) — `TICKET_UPDATED` context (newly added mentions).
- Create `test/integration/notifications/mentions.integration.spec.ts`.

Web (`apps/web`):
- Create `lib/mentions.ts` — `MENTION_TOKEN`, `mentionToken`, `splitMentions`, `mentionQuery`, `insertMention`,
  `filterMentionCandidates`, `withMentionChips`.
- Create `tests/lib/mentions.spec.ts`.
- Modify `lib/markdown.ts` — keep `class="mention-chip"` on `<span>`.
- Modify `tests/lib/markdown.spec.ts`.
- Modify `assets/css/globals.css` — `.mention-chip`.
- Modify `components/MarkdownEditor.vue` — `mentionSlug` prop + member picker + chip preview.
- Create `tests/components/markdown-editor-mentions.spec.ts`.
- Modify `components/CommentThread.vue`, `components/TicketActivity.vue`, `components/CreateTicketDialog.vue` —
  pass `mention-slug`, render chips.
- Modify `i18n/locales/en.json`, `i18n/locales/zh.json` — `notifications.mentions.*`.

---

### Task C0: Cut the PR 3 branch

**Files:** none.

- [ ] **Step 1: Branch from the merged main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git fetch origin
git switch main && git merge --ff-only origin/main
git switch -c feat/fleet-s4a-3-mentions
```

- [ ] **Step 2: Confirm the Part A mention seam**

```bash
grep -n "mentionedUserIds" apps/api/src/notifications/ticket-mention.resolver.ts apps/api/src/notifications/ticket-notification.subscriber.ts
grep -n "HandledTicketAction\|HANDLED_TICKET_ACTIONS" apps/api/src/notifications/ticket-notification.rules.ts
```

Expected: `TicketMentionResolver.mentionedUserIds(projectId: string, text: string | null)` returning `[]`, called by
the subscriber for `TICKET_CREATED` and `COMMENT_ADDED`; `HandledTicketAction` without `TICKET_UPDATED`. Task C3
fills the body and adds `TICKET_UPDATED`.

---

### Task C1: `parseMentions` (API)

**Files:**
- Create: `apps/api/src/notifications/mentions.ts`
- Create: `apps/api/src/notifications/mentions.spec.ts`

**Interfaces:**
- Consumes: Global Constraints mention grammar.
- Produces: `parseMentions(text: string | null | undefined): readonly string[]`, `MENTION_LIMIT = 20`,
  `MENTION_TOKEN: RegExp` (global flag; used only through `matchAll`/`replace`).

- [ ] **Step 1: Write the failing test** (Review Focus 3: malformed and hostile tokens)

Create `apps/api/src/notifications/mentions.spec.ts`:

```ts
import { MENTION_LIMIT, parseMentions } from './mentions';

const id = (n: number): string => `c${String(n).padStart(24, '0')}`;
const token = (label: string, userId: string): string => `@[${label}](user:${userId})`;

describe('parseMentions (S4a §2.3, D504)', () => {
  it('returns distinct ids in first-seen order', () => {
    const text = `hi ${token('Ann', id(1))} and ${token('Bo', id(2))}, again ${token('Ann L.', id(1))}`;
    expect(parseMentions(text)).toEqual([id(1), id(2)]);
  });

  it('returns [] for empty, null and undefined', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
    expect(parseMentions(undefined)).toEqual([]);
  });

  it('never parses plain @name text', () => {
    expect(parseMentions('ping @alice and @bob@example.com')).toEqual([]);
  });

  it.each([
    ['an empty id', '@[x](user:)'],
    ['an empty label', `@[](user:${id(1)})`],
    ['a label containing ]', `@[a]b](user:${id(1)})`],
    ['an id that is not a cuid', '@[x](user:not-a-cuid)'],
    ['an uppercase id', `@[x](user:${id(1).toUpperCase()})`],
    ['an id that is too short', '@[x](user:c123)'],
    ['an id that is too long', `@[x](user:c${'a'.repeat(40)})`],
    ['another scheme', `@[x](agent:${id(1)})`],
    ['a missing closing paren', `@[x](user:${id(1)}`],
    ['a space before the paren', `@[x] (user:${id(1)})`],
  ])('ignores %s', (_label, text) => {
    expect(parseMentions(text)).toEqual([]);
  });

  it(`caps at ${MENTION_LIMIT} distinct ids, even for 500 tokens`, () => {
    const text = Array.from({ length: 500 }, (_, i) => token(`u${i}`, id(i))).join(' ');
    const ids = parseMentions(text);
    expect(ids).toHaveLength(MENTION_LIMIT);
    expect(ids[0]).toBe(id(0));
    expect(ids[MENTION_LIMIT - 1]).toBe(id(MENTION_LIMIT - 1));
  });

  it('is linear on a long run of unterminated labels', () => {
    const text = `@[${'['.repeat(50_000)}`;
    const started = Date.now();
    expect(parseMentions(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bunx jest src/notifications/mentions.spec.ts`
Expected: FAIL — `Cannot find module './mentions'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/notifications/mentions.ts`:

```ts
/** S4a §2.3: at most this many distinct users are mentioned per text; later tokens are plain text. */
export const MENTION_LIMIT = 20;

/**
 * D504: `@[<label>](user:<cuid>)`. The label is display-only (never `]`); the id is a lowercase cuid. Plain `@name`
 * is never parsed. Global: use only through `matchAll` / `replace`, which do not share `lastIndex` state.
 * The web copy in apps/web/lib/mentions.ts must stay identical.
 */
export const MENTION_TOKEN = /@\[([^\]]+)\]\(user:(c[a-z0-9]{20,32})\)/g;

/** Distinct mentioned user ids in first-seen order, capped at MENTION_LIMIT. */
export function parseMentions(text: string | null | undefined): readonly string[] {
  if (!text) return [];
  return [...text.matchAll(MENTION_TOKEN)].reduce<readonly string[]>((ids, match) => {
    const userId = match[2];
    if (ids.length >= MENTION_LIMIT || ids.includes(userId)) return ids;
    return [...ids, userId];
  }, []);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bunx jest src/notifications/mentions.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/mentions.ts apps/api/src/notifications/mentions.spec.ts
git commit -m "feat(api): parse @mention tokens (S4a §2.3, D504)"
```

---

### Task C2: `TICKET_UPDATED` records `previousDescription`

**Files:**
- Modify: `apps/api/src/tickets/tickets.service.ts:239-270`
- Modify: `apps/api/src/tickets/tickets.service.spec.ts` (the `describe` block that holds
  `it('emits TicketEvent after update'`, around line 805)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ticket_event` payload `data.previousDescription: string | null` on `TICKET_UPDATED` whenever the update
  includes `description` (spec §2.2 "newly mentioned").

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/tickets/tickets.service.spec.ts`, inside the same `describe` as `it('emits TicketEvent after
update'`, add:

```ts
    it('S4a §2.2: a description change records the previous description', async () => {
      const before = { ...fakeTicket, description: 'old body' };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(before);
      mockTicketRepo.updateTicket.mockResolvedValue({ ...before, description: 'new body' });

      await service.update('test-project', 'TST-1', { description: 'new body' }, fakeUserPrincipal as any);

      expect(mockTicketEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'TICKET_UPDATED', data: { description: 'new body', previousDescription: 'old body' } }),
      );
      expect(mockOutbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ data: { description: 'new body', previousDescription: 'old body' } }),
        }),
      );
      // The ticket row itself never receives the extra field.
      expect(mockTicketRepo.updateTicket).toHaveBeenCalledWith(before.id, { description: 'new body' });
    });

    it('S4a §2.2: a first description records previousDescription null', async () => {
      const before = { ...fakeTicket, description: null };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(before);
      mockTicketRepo.updateTicket.mockResolvedValue({ ...before, description: 'first' });

      await service.update('test-project', 'TST-1', { description: 'first' }, fakeUserPrincipal as any);

      expect(mockTicketEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { description: 'first', previousDescription: null } }),
      );
    });

    it('S4a §2.2: an update without description adds no previousDescription', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(fakeTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({ ...fakeTicket, title: 'Renamed' });

      await service.update('test-project', 'TST-1', { title: 'Renamed' }, fakeUserPrincipal as any);

      expect(mockTicketEventService.create).toHaveBeenCalledWith(expect.objectContaining({ data: { title: 'Renamed' } }));
    });
```

If `findTicketScoped` is not the repo call `findByRef` uses, read `tickets.service.ts:169` and mock the call it makes
(the existing `'emits TicketEvent after update'` test shows the working combination).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/tickets/tickets.service.spec.ts -t "S4a"`
Expected: FAIL — `data` lacks `previousDescription`.

- [ ] **Step 3: Implement**

In `apps/api/src/tickets/tickets.service.ts` `applyUpdate`, replace

```ts
        await this.recordTicketEvent(ticket.id, project.id, 'TICKET_UPDATED', principal, { ...updateData });
```

with

```ts
        // S4a §2.2: mention notifications diff the new description against the previous one.
        const eventData = updateData.description !== undefined
          ? { ...updateData, previousDescription: ticket.description ?? null }
          : { ...updateData };
        await this.recordTicketEvent(ticket.id, project.id, 'TICKET_UPDATED', principal, eventData);
```

(`ticket` is the row `findByRef` loaded before the transaction; read its type at `tickets.service.ts:169` — if the
returned object names the field differently, use that name.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/tickets/tickets.service.spec.ts`
Expected: PASS (the whole file: existing `TICKET_UPDATED` assertions use `objectContaining` and still hold).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tickets/tickets.service.ts apps/api/src/tickets/tickets.service.spec.ts
git commit -m "feat(api): record previousDescription on description updates (S4a §2.2)"
```

---

### Task C3: `TicketMentionResolver` body and `TICKET_UPDATED` mentions

**Files:**
- Modify: `apps/api/src/notifications/ticket-mention.resolver.ts` (Part A seam: body only, signature unchanged)
- Create: `apps/api/src/notifications/ticket-mention.resolver.spec.ts`
- Modify: `apps/api/src/notifications/ticket-notification.rules.ts` and its spec (`TICKET_UPDATED`)
- Modify: `apps/api/src/notifications/ticket-notification.subscriber.ts` and its spec (`TICKET_UPDATED` context)

**Interfaces:**
- Consumes: Part A `TicketMentionResolver.mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]>`
  (returns `[]` in Part A; already called by `TicketNotificationSubscriber.contextFor` for `TICKET_CREATED` with the
  ticket description and `COMMENT_ADDED` with the comment body); Part A `HandledTicketAction`, `HANDLED_TICKET_ACTIONS`,
  `TicketEventFacts`, `watchEntries`, `ticketRecipients` (`ticket-notification.rules.ts`), which already auto-watch
  `MENTIONED`, emit `ticket_mentioned` and give mentions priority over watched activity; `parseMentions` (Task C1);
  `data.previousDescription` (Task C2).
- Produces: `TicketMentionResolver.mentionedUserIds` returns, in token order, the mentioned ids that are enabled
  project members or enabled global ADMINs; `HandledTicketAction` gains `'TICKET_UPDATED'` (newly added mentions only).

- [ ] **Step 1: Write the failing resolver test** (Review Focus 3: a token for a non-member)

Create `apps/api/src/notifications/ticket-mention.resolver.spec.ts`:

```ts
import { TicketMentionResolver } from './ticket-mention.resolver';

const id = (n: number): string => `c${String(n).padStart(24, '0')}`;
const token = (userId: string): string => `@[x](user:${userId})`;

function resolver(visible: readonly string[]) {
  const db = {
    user: { findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((u) => visible.includes(u)).map((u) => ({ id: u }))) },
  };
  return { db, r: new TicketMentionResolver({ client: db } as never) };
}

describe('TicketMentionResolver (S4a §2.3)', () => {
  it('keeps visible ids in token order', async () => {
    const { r } = resolver([id(1), id(2)]);
    expect(await r.mentionedUserIds('p1', `${token(id(2))} then ${token(id(1))}`)).toEqual([id(2), id(1)]);
  });

  it('drops a token for a user who is neither a project member nor a global admin', async () => {
    const { r, db } = resolver([id(1)]);
    expect(await r.mentionedUserIds('p1', `${token(id(1))} ${token(id(3))}`)).toEqual([id(1)]);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [id(1), id(3)] },
        disabled: false,
        OR: [{ role: 'ADMIN' }, { projectMemberships: { some: { projectId: 'p1' } } }],
      },
      select: { id: true },
    });
  });

  it.each([null, '', 'plain @alice text', '@[x](user:)'])('no tokens (%p) → [] without a query', async (text) => {
    const { r, db } = resolver([id(1)]);
    expect(await r.mentionedUserIds('p1', text)).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/notifications/ticket-mention.resolver.spec.ts`
Expected: FAIL — the first two cases get `[]` (Part A stub).

- [ ] **Step 3: Implement the resolver body**

Replace `apps/api/src/notifications/ticket-mention.resolver.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { parseMentions } from './mentions';

/**
 * Fleet S4a §2.3 (slice 3): who a text mentions. Only enabled project members and enabled global admins count;
 * a token for anyone else is ignored (D504). Order follows the text.
 */
@Injectable()
export class TicketMentionResolver {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]> {
    const ids = parseMentions(text);
    if (ids.length === 0) return [];
    const users = await this.prisma.client.user.findMany({
      where: {
        id: { in: [...ids] },
        disabled: false,
        OR: [{ role: 'ADMIN' }, { projectMemberships: { some: { projectId } } }],
      },
      select: { id: true },
    });
    const allowed = new Set(users.map((u) => u.id));
    return ids.filter((userId) => allowed.has(userId));
  }
}
```

`TicketMentionResolver` is already in `NotificationsModule.providers` (Part A); `PrismaService` is global in this app
(the Part A repositories inject it the same way), so no module change is needed.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && bunx jest src/notifications/ticket-mention.resolver.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `TICKET_UPDATED` tests**

In `apps/api/src/notifications/ticket-notification.rules.spec.ts`, add to the watch-entries table:

```ts
    ['TICKET_UPDATED', facts({ action: 'TICKET_UPDATED', mentionedIds: ['m'] }), [{ userId: 'm', reason: 'MENTIONED' }]],
```

and a recipients case:

```ts
  it('TICKET_UPDATED notifies only the newly mentioned, never watchers', () => {
    expect(ticketRecipients(facts({ action: 'TICKET_UPDATED', mentionedIds: ['m'] }), ['w1', 'm']))
      .toEqual([{ userId: 'm', kind: 'ticket_mentioned' }]);
  });
```

In `apps/api/src/notifications/ticket-notification.subscriber.spec.ts` (its mocks are named as in Part A's spec:
`mentions = { mentionedUserIds: jest.fn().mockResolvedValue([]) }`; reuse that file's envelope and ticket fixtures),
add:

```ts
  it('TICKET_UPDATED notifies users newly mentioned in the description', async () => {
    const prev = '@[a](user:c000000000000000000000001)';
    const next = `${prev} @[b](user:c000000000000000000000002)`;
    mentions.mentionedUserIds.mockResolvedValueOnce(['c000000000000000000000001', 'c000000000000000000000002']);
    await subscriber.handle(envelope('TICKET_UPDATED', { description: next, previousDescription: prev }));
    expect(mentions.mentionedUserIds).toHaveBeenCalledWith(ticket.projectId, next);
    expect(writer.deliver).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'c000000000000000000000002', kind: 'ticket_mentioned', category: 'MENTIONED' }),
    ]);
  });

  it('TICKET_UPDATED without a description change or with no new mention does nothing', async () => {
    await subscriber.handle(envelope('TICKET_UPDATED', { title: 'renamed' }));
    const same = '@[a](user:c000000000000000000000001)';
    mentions.mentionedUserIds.mockResolvedValueOnce(['c000000000000000000000001']);
    await subscriber.handle(envelope('TICKET_UPDATED', { description: same, previousDescription: same }));
    expect(writer.deliver).not.toHaveBeenCalled();
  });
```

(If that spec names its helpers differently — `envelope`, `ticket`, `writer`, `subscriber` — use its names; the
assertions stay the same.)

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/api && bunx jest src/notifications/ticket-notification.rules.spec.ts src/notifications/ticket-notification.subscriber.spec.ts`
Expected: FAIL — type error `'TICKET_UPDATED'` is not assignable to `HandledTicketAction`, and the subscriber ignores
`TICKET_UPDATED`.

- [ ] **Step 7: Implement `TICKET_UPDATED`**

In `ticket-notification.rules.ts`:

```ts
export type HandledTicketAction = 'TICKET_CREATED' | 'assigned' | 'COMMENT_ADDED' | 'status_changed' | 'TICKET_UPDATED';

export const HANDLED_TICKET_ACTIONS: ReadonlySet<string> = new Set<HandledTicketAction>([
  'TICKET_CREATED', 'assigned', 'COMMENT_ADDED', 'status_changed', 'TICKET_UPDATED',
]);
```

and add to the `watchEntries` switch:

```ts
    case 'TICKET_UPDATED': return mentioned(f);
```

(`ticketRecipients` needs no change: non-`assigned` actions already map `mentionedIds` to `ticket_mentioned`, and
`TICKET_UPDATED` has no activity kind.)

In `ticket-notification.subscriber.ts`, add `import { parseMentions } from './mentions';` and a `contextFor` case
before `default`:

```ts
      case 'TICKET_UPDATED': {
        const next = event.data.description;
        if (typeof next !== 'string') return null; // description unchanged
        const previous = typeof event.data.previousDescription === 'string' ? event.data.previousDescription : null;
        const before = new Set(parseMentions(previous)); // events before Task C2 carry none: every token is new
        const added = (await this.mentions.mentionedUserIds(ticket.projectId, next)).filter((id) => !before.has(id));
        if (added.length === 0) return null;
        return { facts: { ...base, mentionedIds: added }, excerpt: next };
      }
```

- [ ] **Step 8: Run the notification unit tests**

Run: `cd apps/api && bunx jest src/notifications && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/notifications/ticket-mention.resolver.ts apps/api/src/notifications/ticket-mention.resolver.spec.ts \
  apps/api/src/notifications/ticket-notification.rules.ts apps/api/src/notifications/ticket-notification.rules.spec.ts \
  apps/api/src/notifications/ticket-notification.subscriber.ts apps/api/src/notifications/ticket-notification.subscriber.spec.ts
git commit -m "feat(api): resolve @mentions for ticket notifications, incl. newly added on edit (S4a §2.3)"
```

---

### Task C4: Mention notifications over the real outbox (integration)

**Files:**
- Create: `apps/api/test/integration/notifications/mentions.integration.spec.ts`

**Interfaces:**
- Consumes: the whole API (Part A + Tasks C1-C3), `OutboxRelay.dispatchPendingBatch()`, Prisma models
  `notification` and `ticketWatcher` (Part A), routes `POST /api/projects/:slug/tickets`, `PATCH .../tickets/:ref`,
  `POST .../tickets/:ref/comments`, `DELETE .../tickets/:ref/watch`.
- Produces: nothing.

- [ ] **Step 1: Write the integration spec**

Create `apps/api/test/integration/notifications/mentions.integration.spec.ts`:

```ts
/**
 * S4a slice 3 — @mentions end to end on Postgres: token -> outbox -> MENTIONED notification + MENTIONED watcher.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/notifications/mentions
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const mention = (label: string, userId: string): string => `@[${label}](user:${userId})`;

describeIntegration('@mention notifications (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let relay: OutboxRelay;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const drain = async (): Promise<void> => { await relay.dispatchPendingBatch(); await relay.dispatchPendingBatch(); };
  const mentionsFor = (who: string, ticketId: string) =>
    prisma.notification.findMany({ where: { userId: ids[who], kind: 'ticket_mentioned', sourceType: 'ticket_event' } })
      .then((rows) => rows.filter((r) => (r.link as string).endsWith(`/tickets/${ticketId}`)));

  let seq = 0;
  async function newTicket(description?: string): Promise<{ ref: string; id: string }> {
    seq += 1;
    const res = await request(server).post('/api/projects/men/tickets').set(auth('author'))
      .send({ type: 'BUG', title: `Mention ${seq}`, ...(description ? { description } : {}) }).expect(201);
    const body = data<{ id: string; ref?: string; number?: number }>(res);
    return { id: body.id, ref: body.ref ?? `MEN-${body.number}` };
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    relay = app.get(OutboxRelay);
    prisma = app.get(PrismaService).client as PrismaClient;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Mentions', slug: 'men', key: 'MEN' }).expect(201);

    for (const who of ['author', 'member', 'muted', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    for (const who of ['author', 'member', 'muted']) {
      await request(server).post('/api/projects/men/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' }).expect(201);
    }
    await drain();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a comment mention notifies the member once, makes them a MENTIONED watcher, and ignores a non-member', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `cc ${mention('Member', ids.member)} and ${mention('Out', ids.outsider)}` }).expect(201);
    await drain();
    await drain(); // a redelivery must not duplicate

    const rows = await mentionsFor('member', ticket.ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ category: 'MENTIONED', actorId: ids.author }));
    const watcher = await prisma.ticketWatcher.findUnique({ where: { ticketId_userId: { ticketId: ticket.id, userId: ids.member } } });
    expect(watcher).toEqual(expect.objectContaining({ reason: 'MENTIONED', muted: false }));

    expect(await prisma.notification.count({ where: { userId: ids.outsider } })).toBe(0);
    expect(await prisma.ticketWatcher.count({ where: { ticketId: ticket.id, userId: ids.outsider } })).toBe(0);
  });

  it('a mentioned watcher gets MENTIONED only, not also WATCHED_ACTIVITY, for the same comment', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('member'))
      .send({ type: 'GENERAL', body: 'I am watching now' }).expect(201);
    await drain();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `ping ${mention('Member', ids.member)}` }).expect(201);
    await drain();

    const event = await prisma.ticketEvent.findFirst({ where: { ticketId: ticket.id, action: 'COMMENT_ADDED', actorId: ids.author } });
    const forEvent = await prisma.notification.findMany({ where: { userId: ids.member, sourceId: event?.id } });
    expect(forEvent.map((r) => r.category)).toEqual(['MENTIONED']);
  });

  it('a muted watcher still receives a direct mention (D502)', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('muted'))
      .send({ type: 'GENERAL', body: 'joining' }).expect(201);
    await drain();
    await request(server).delete(`/api/projects/men/tickets/${ticket.ref}/watch`).set(auth('muted')).expect(200);
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `need you ${mention('Muted', ids.muted)}` }).expect(201);
    await drain();

    expect(await mentionsFor('muted', ticket.ref)).toHaveLength(1);
    const watcher = await prisma.ticketWatcher.findUnique({ where: { ticketId_userId: { ticketId: ticket.id, userId: ids.muted } } });
    expect(watcher?.muted).toBe(true); // auto-watch never un-mutes
  });

  it('a description mention on create notifies; editing adds only newly mentioned users', async () => {
    const ticket = await newTicket(`spec by ${mention('Member', ids.member)}`);
    await drain();
    expect(await mentionsFor('member', ticket.ref)).toHaveLength(1);

    await request(server).patch(`/api/projects/men/tickets/${ticket.ref}`).set(auth('author'))
      .send({ description: `spec by ${mention('Member', ids.member)}, reviewed by ${mention('Muted', ids.muted)}` }).expect(200);
    await drain();
    expect(await mentionsFor('member', ticket.ref)).toHaveLength(1);
    expect(await mentionsFor('muted', ticket.ref)).toHaveLength(1);

    await request(server).patch(`/api/projects/men/tickets/${ticket.ref}`).set(auth('author'))
      .send({ description: `spec by ${mention('Member', ids.member)}, reviewed by ${mention('Muted', ids.muted)}.` }).expect(200);
    await drain();
    expect(await mentionsFor('member', ticket.ref)).toHaveLength(1);
    expect(await mentionsFor('muted', ticket.ref)).toHaveLength(1);
  });

  it('mentioning yourself creates nothing', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `note to ${mention('Me', ids.author)}` }).expect(201);
    await drain();
    expect(await mentionsFor('author', ticket.ref)).toHaveLength(0);
  });
});
```

Before running, check three facts against the code and adjust the spec (not the product) if they differ: the create
response's ref field (`TicketResponseDto.from`), the status code of `DELETE .../watch` in Part A's controller
(200 with `{ watching, count }` per the contract), and the composite key name Prisma generated for `TicketWatcher`
(`ticketId_userId` from `@@id([ticketId, userId])`). `mentionsFor` filters by `link` suffix because `link` is
`/{slug}/tickets/{ref}` (contract "Kinds" table).

- [ ] **Step 2: Run it**

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/notifications/mentions.integration.spec.ts`
Expected: PASS. A failure in the "MENTIONED only" or "muted watcher" cases means Part A's subscriber does not apply
the Global Constraints priority / mute rules to the seam's result: fix it in `ticket-notification.subscriber.ts`
(Task C3 Step 6), not here.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/notifications/mentions.integration.spec.ts
git commit -m "test(api): @mention notifications over the real outbox (S4a §8)"
```

---

### Task C5: Web mention helpers and the chip sanitizer allowance

**Files:**
- Create: `apps/web/lib/mentions.ts`
- Create: `apps/web/tests/lib/mentions.spec.ts`
- Modify: `apps/web/lib/markdown.ts:24-28`
- Modify: `apps/web/tests/lib/markdown.spec.ts:192-202`
- Modify: `apps/web/assets/css/globals.css`

**Interfaces:**
- Consumes: `escapeHtml` from `~/lib/markdown`; `ProjectMember` from `~/composables/useProjectMembers`.
- Produces (`lib/mentions.ts`):
  - `MENTION_TOKEN: RegExp` (identical to the API's)
  - `type MentionSegment = { readonly text: string } | { readonly userId: string; readonly label: string }`
  - `mentionToken(label: string, userId: string): string`
  - `splitMentions(text: string): readonly MentionSegment[]`
  - `mentionQuery(text: string, caret: number): { start: number; query: string } | null`
  - `insertMention(text: string, start: number, caret: number, label: string, userId: string): { text: string; caret: number }`
  - `filterMentionCandidates(members: readonly ProjectMember[], query: string, limit?: number): readonly ProjectMember[]`
  - `withMentionChips(markdown: string, nameOf: (userId: string) => string | null): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/lib/mentions.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  filterMentionCandidates, insertMention, mentionQuery, mentionToken, splitMentions, withMentionChips,
} from '~/lib/mentions'
import type { ProjectMember } from '~/composables/useProjectMembers'

const ID = 'c000000000000000000000001'
const ID2 = 'c000000000000000000000002'
const member = (userId: string, name: string | null, email: string): ProjectMember =>
  ({ userId, name, email, role: 'DEVELOPER', joinedAt: '2026-10-01T00:00:00.000Z' })

describe('mentionToken (D504)', () => {
  test('builds the API grammar', () => {
    expect(mentionToken('Ann Lee', ID)).toBe(`@[Ann Lee](user:${ID})`)
  })
  test('strips ] and newlines from the label so the token stays parseable', () => {
    expect(mentionToken('A]n\nn', ID)).toBe(`@[Ann](user:${ID})`)
    expect(mentionToken(']]', ID)).toBe(`@[user](user:${ID})`)
  })
})

describe('splitMentions', () => {
  test('splits text and tokens in order', () => {
    expect(splitMentions(`hi @[Ann](user:${ID}), see @[Bo](user:${ID2})!`)).toEqual([
      { text: 'hi ' }, { userId: ID, label: 'Ann' }, { text: ', see ' }, { userId: ID2, label: 'Bo' }, { text: '!' },
    ])
  })
  test('plain text and malformed tokens stay text', () => {
    expect(splitMentions('ping @alice')).toEqual([{ text: 'ping @alice' }])
    expect(splitMentions('@[x](user:)')).toEqual([{ text: '@[x](user:)' }])
    expect(splitMentions('')).toEqual([])
  })
})

describe('mentionQuery', () => {
  test.each([
    ['@', 1, { start: 0, query: '' }],
    ['hi @an', 6, { start: 3, query: 'an' }],
    ['hi @an more', 6, { start: 3, query: 'an' }],
    ['line\n@bo', 8, { start: 5, query: 'bo' }],
  ])('%j at %d -> %j', (text, caret, expected) => {
    expect(mentionQuery(text, caret)).toEqual(expected)
  })
  test.each([
    ['email@example', 13],
    ['hi @an ', 7],
    ['no at', 5],
    [`@[Ann](user:${ID})`, 32],
  ])('%j at %d -> null', (text, caret) => {
    expect(mentionQuery(text, caret)).toBeNull()
  })
})

describe('insertMention', () => {
  test('replaces @query with the token plus a space and moves the caret after it', () => {
    const token = `@[Ann](user:${ID}) `
    expect(insertMention('hi @an and', 3, 6, 'Ann', ID)).toEqual({ text: `hi ${token} and`, caret: 3 + token.length })
  })
})

describe('filterMentionCandidates', () => {
  const members = [member(ID, 'Ann Lee', 'ann@x.io'), member(ID2, null, 'bob@x.io'), member('c000000000000000000000003', 'Cy', 'cy@x.io')]
  test('matches name or email, case-insensitive', () => {
    expect(filterMentionCandidates(members, 'LEE').map((m) => m.userId)).toEqual([ID])
    expect(filterMentionCandidates(members, 'bob').map((m) => m.userId)).toEqual([ID2])
  })
  test('an empty query lists everyone up to the limit', () => {
    expect(filterMentionCandidates(members, '', 2)).toHaveLength(2)
  })
})

describe('withMentionChips', () => {
  test('replaces tokens with an escaped chip using the current name, falling back to the label', () => {
    const md = `by @[Old](user:${ID}) and @[<b>x</b>](user:${ID2})`
    const nameOf = (id: string) => (id === ID ? 'Ann & Co' : null)
    expect(withMentionChips(md, nameOf)).toBe(
      'by <span class="mention-chip">@Ann &amp; Co</span> and <span class="mention-chip">@&lt;b&gt;x&lt;/b&gt;</span>',
    )
  })
})
```

In `apps/web/tests/lib/markdown.spec.ts`, extend the `keepClassAttribute` table with:

```ts
    ['span', 'mention-chip', true],
    ['span', ' mention-chip ', true],
    ['span', 'mention-chip fixed', false],
    ['div', 'mention-chip', false],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/mentions.spec.ts tests/lib/markdown.spec.ts`
Expected: FAIL — `~/lib/mentions` missing; `keepClassAttribute('span', 'mention-chip')` is false.

- [ ] **Step 3: Create `apps/web/lib/mentions.ts`**

```ts
import { escapeHtml } from '~/lib/markdown'
import type { ProjectMember } from '~/composables/useProjectMembers'

/**
 * S4a D504: `@[<label>](user:<cuid>)`, identical to apps/api/src/notifications/mentions.ts. Global: use only through
 * `matchAll` / `replace`.
 */
export const MENTION_TOKEN = /@\[([^\]]+)\]\(user:(c[a-z0-9]{20,32})\)/g

export type MentionSegment = { readonly text: string } | { readonly userId: string; readonly label: string }

/** The token for one member; `]` and newlines would end the label early, so they are dropped. */
export function mentionToken(label: string, userId: string): string {
  const clean = label.replace(/[\]\r\n]/g, '').trim()
  return `@[${clean || 'user'}](user:${userId})`
}

/** Plain-text rendering (comments): text and mention segments in order. */
export function splitMentions(text: string): readonly MentionSegment[] {
  const { parts, cursor } = [...text.matchAll(MENTION_TOKEN)].reduce<{ parts: readonly MentionSegment[]; cursor: number }>(
    (acc, match) => {
      const start = match.index ?? 0
      const before: readonly MentionSegment[] = start > acc.cursor ? [{ text: text.slice(acc.cursor, start) }] : []
      return { parts: [...acc.parts, ...before, { label: match[1], userId: match[2] }], cursor: start + match[0].length }
    },
    { parts: [], cursor: 0 },
  )
  return cursor < text.length ? [...parts, { text: text.slice(cursor) }] : parts
}

/** `@` at the start of the text or after whitespace, then up to 30 non-space characters, ending at the caret. */
const QUERY = /(^|\s)@([^\s@[\]()]{0,30})$/

export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = QUERY.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[2]
  return { start: caret - query.length - 1, query }
}

export function insertMention(text: string, start: number, caret: number, label: string, userId: string): { text: string; caret: number } {
  const token = `${mentionToken(label, userId)} `
  return { text: `${text.slice(0, start)}${token}${text.slice(caret)}`, caret: start + token.length }
}

export function filterMentionCandidates(members: readonly ProjectMember[], query: string, limit = 6): readonly ProjectMember[] {
  const q = query.toLowerCase()
  return members
    .filter((m) => q === '' || (m.name ?? '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
    .slice(0, limit)
}

/** Markdown rendering (descriptions): tokens become escaped chips before marked + DOMPurify run. */
export function withMentionChips(markdown: string, nameOf: (userId: string) => string | null): string {
  return markdown.replace(MENTION_TOKEN, (_match, label: string, userId: string) =>
    `<span class="mention-chip">@${escapeHtml(nameOf(userId) ?? label)}</span>`)
}
```

- [ ] **Step 4: Allow the chip class in the sanitizer**

In `apps/web/lib/markdown.ts`, replace `keepClassAttribute` with:

```ts
/**
 * `class` is kept only on <code> with a single `language-*` token (syntax
 * highlighting), and on <span> as exactly `mention-chip` (S4a @mention chips).
 * Anything else, e.g. `fixed inset-0`, could restyle page chrome from user content.
 */
export function keepClassAttribute(tagName: string, value: string): boolean {
  const tag = tagName.toLowerCase()
  const trimmed = value.trim()
  if (tag === 'code') return LANGUAGE_CLASS.test(trimmed)
  return tag === 'span' && trimmed === 'mention-chip'
}
```

- [ ] **Step 5: Style the chip**

Append to `apps/web/assets/css/globals.css`:

```css
@layer components {
  /* S4a @mention chip (comments, descriptions, editor preview). The sanitizer keeps only this exact class. */
  .mention-chip {
    @apply rounded bg-primary/10 px-1 font-medium text-primary;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/mentions.spec.ts tests/lib/markdown.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/mentions.ts apps/web/tests/lib/mentions.spec.ts apps/web/lib/markdown.ts \
  apps/web/tests/lib/markdown.spec.ts apps/web/assets/css/globals.css
git commit -m "feat(web): mention token helpers and sanitizer-safe chips (S4a §2.3)"
```

---

### Task C6: Member picker in `MarkdownEditor`, chips in comments and descriptions

**Files:**
- Modify: `apps/web/components/MarkdownEditor.vue`
- Create: `apps/web/tests/components/markdown-editor-mentions.spec.ts`
- Modify: `apps/web/components/CommentThread.vue` (both `MarkdownEditor` uses + the body `<p>`)
- Modify: `apps/web/components/TicketActivity.vue` (editor + `renderedDescription`)
- Modify: `apps/web/components/CreateTicketDialog.vue:55`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`notifications.mentions`)

**Interfaces:**
- Consumes: Task C5 helpers; `useProjectMemberNames(slug)` → `{ members: Ref<ProjectMember[]>; load(): Promise<void>; nameOf(id): string | null }`.
- Produces: `MarkdownEditor` prop `mentionSlug?: string` (no picker when absent); test ids `mention-picker`,
  `mention-option`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/components/markdown-editor-mentions.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { ProjectMember } from '~/composables/useProjectMembers'

const editor = webFile('components', 'MarkdownEditor.vue')
const ID = 'c000000000000000000000001'
const MEMBERS: ProjectMember[] = [
  { userId: ID, name: 'Ann Lee', email: 'ann@x.io', role: 'DEVELOPER', joinedAt: '' },
  { userId: 'c000000000000000000000002', name: 'Bo', email: 'bo@x.io', role: 'VIEWER', joinedAt: '' },
]

function mount(props: Record<string, unknown>) {
  const members = ref<ProjectMember[]>([])
  const load = jest.fn(async () => { members.value = MEMBERS })
  const namesCalls: string[] = []
  const app = mountSfc(editor, {
    components: uiStubs,
    props,
    alias: {
      '~/components/ui/tabs': { Tabs: uiStubs.Tabs, TabsList: uiStubs.TabsList, TabsTrigger: uiStubs.TabsTrigger, TabsContent: uiStubs.TabsContent },
      '~/components/ui/textarea': { Textarea: uiStubs.Textarea },
    },
    globals: {
      useI18n: () => enI18n(),
      useProjectMemberNames: (slug: string) => { namesCalls.push(slug); return { members, load, nameOf: () => null } },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const textarea = () => app.find('[data-stub="textarea"]')[0]
  const type = (value: string, caret = value.length) =>
    (textarea().props.onInput as (e: unknown) => void)({ target: { value, selectionStart: caret } })
  return { app, load, namesCalls, settle, textarea, type, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('MarkdownEditor @mentions (S4a §5)', () => {
  test('without mentionSlug there is no picker and no member lookup', async () => {
    const m = mount({ modelValue: '' })
    m.type('hi @a')
    await m.settle()
    expect(m.namesCalls).toEqual([])
    expect(m.byId('mention-picker')).toHaveLength(0)
    expect(m.app.emitted('update:modelValue')).toEqual([['hi @a']])
  })

  test('typing @ loads members once and lists matches', async () => {
    const m = mount({ modelValue: '', mentionSlug: 'koda' })
    m.type('hi @')
    await m.settle()
    m.type('hi @an')
    await m.settle()
    expect(m.namesCalls).toEqual(['koda'])
    expect(m.load).toHaveBeenCalledTimes(1)
    const options = m.byId('mention-option')
    expect(options).toHaveLength(1)
    expect(m.app.textOf(options[0])).toContain('Ann Lee')
  })

  test('choosing a member replaces @query with the token', async () => {
    const m = mount({ modelValue: 'hi @an', mentionSlug: 'koda' })
    m.type('hi @an')
    await m.settle()
    ;(m.byId('mention-option')[0].props.onMousedown as (e: unknown) => void)({ preventDefault: () => undefined })
    await m.settle()
    expect(m.app.emitted('update:modelValue').at(-1)).toEqual([`hi @[Ann Lee](user:${ID}) `])
    expect(m.byId('mention-picker')).toHaveLength(0)
  })

  test('a space after the query or Escape closes the picker', async () => {
    const m = mount({ modelValue: '', mentionSlug: 'koda' })
    m.type('hi @an')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(1)
    m.type('hi @an ')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(0)
    m.type('hi @b')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(1)
    ;(m.textarea().props.onKeydown as (e: unknown) => void)({ key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined })
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(0)
  })

  test('a failed member load shows no picker and retries on the next @', async () => {
    const m = mount({ modelValue: '', mentionSlug: 'koda' })
    m.load.mockRejectedValueOnce(new Error('403'))
    m.type('@')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(0)
    m.type('@a')
    await m.settle()
    expect(m.load).toHaveBeenCalledTimes(2)
  })
})

describe('mention-slug wiring and chip rendering', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '../..', ...parts), 'utf-8')

  test('comment box, comment edit, description editor and create dialog pass the project slug', () => {
    expect(read('components', 'CommentThread.vue').match(/:mention-slug="projectSlug"/g)).toHaveLength(2)
    expect(read('components', 'TicketActivity.vue')).toContain(':mention-slug="projectSlug"')
    expect(read('components', 'CreateTicketDialog.vue')).toContain(':mention-slug="props.projectSlug"')
  })

  test('comments render tokens as chips without v-html; descriptions run through withMentionChips', () => {
    const thread = read('components', 'CommentThread.vue')
    expect(thread).toContain('splitMentions(comment.body)')
    expect(thread).toContain('class="mention-chip"')
    expect(thread).not.toMatch(/v-html="[^"]*comment/)
    expect(read('components', 'TicketActivity.vue')).toContain('renderMarkdownOrEscape(withMentionChips(')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/components/markdown-editor-mentions.spec.ts`
Expected: FAIL — no picker, no `mentionSlug` prop.

- [ ] **Step 3: Rewrite `apps/web/components/MarkdownEditor.vue`**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import { renderMarkdownOrEscape } from '~/lib/markdown'
import { filterMentionCandidates, insertMention, mentionQuery, withMentionChips } from '~/lib/mentions'
import type { ProjectMember } from '~/composables/useProjectMembers'

interface Props {
  modelValue: string
  /** S4a: the project whose members `@` offers; no picker when absent. */
  mentionSlug?: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

// The root is a Tabs component, so fallthrough attributes (e.g. aria-label
// passed by callers for axe's `label` rule) would land in the void. Forward
// them explicitly onto the editable Textarea instead.
defineOptions({ inheritAttrs: false })

const { t } = useI18n()
const activeTab = ref<'write' | 'preview'>('write')
const memberNames = props.mentionSlug ? useProjectMemberNames(props.mentionSlug) : null
let membersRequested = false
const mention = ref<{ start: number; caret: number; query: string } | null>(null)

// M24: renderMarkdownOrEscape catches renderer errors and escapes the raw text,
// so the v-html below never receives unsanitized input.
const renderedHtml = computed(() =>
  renderMarkdownOrEscape(withMentionChips(props.modelValue || '', id => memberNames?.nameOf(id) ?? null)),
)

const candidates = computed<readonly ProjectMember[]>(() =>
  mention.value && memberNames ? filterMentionCandidates(memberNames.members.value, mention.value.query) : [],
)

function ensureMembers(): void {
  if (!memberNames || membersRequested) return
  membersRequested = true
  memberNames.load().catch(() => { membersRequested = false })
}

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
  if (!memberNames) return
  const caret = target.selectionStart ?? target.value.length
  const query = mentionQuery(target.value, caret)
  mention.value = query ? { ...query, caret } : null
  if (query) ensureMembers()
}

function pick(member: ProjectMember) {
  if (!mention.value) return
  const next = insertMention(props.modelValue || '', mention.value.start, mention.value.caret, member.name || member.email, member.userId)
  mention.value = null
  emit('update:modelValue', next.text)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && mention.value) {
    event.stopPropagation()
    mention.value = null
  }
}
</script>

<template>
  <Tabs v-model="activeTab" class="w-full">
    <TabsList class="w-full justify-start border-b rounded-none bg-muted/50">
      <TabsTrigger value="write">Write</TabsTrigger>
      <TabsTrigger value="preview">Preview</TabsTrigger>
    </TabsList>
    <TabsContent value="write" class="mt-2">
      <div class="relative">
        <Textarea
          :model-value="modelValue"
          class="min-h-[200px] font-mono text-sm"
          v-bind="$attrs"
          @input="handleInput"
          @keydown="handleKeydown"
        />
        <ul
          v-if="mention && candidates.length > 0"
          role="listbox"
          :aria-label="t('notifications.mentions.pickerLabel')"
          class="absolute left-2 top-full z-40 mt-1 w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          data-testid="mention-picker"
        >
          <li v-for="member in candidates" :key="member.userId" role="option" aria-selected="false">
            <button
              type="button"
              class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              data-testid="mention-option"
              @mousedown.prevent="pick(member)"
            >
              <span class="truncate">{{ member.name || member.email }}</span>
              <span class="truncate text-xs text-muted-foreground">{{ member.email }}</span>
            </button>
          </li>
        </ul>
      </div>
    </TabsContent>
    <TabsContent value="preview" class="mt-2">
      <!-- marked renders fenced code blocks as <pre><code> elements -->
      <div
        class="min-h-[200px] p-4 border rounded-md bg-background overflow-auto prose prose-sm dark:prose-invert max-w-none"
        v-html="renderedHtml"
      />
    </TabsContent>
  </Tabs>
</template>
```

The existing `tests/components/MarkdownEditor.spec.ts` source assertions (`modelValue`, `Textarea`, `TabsTrigger`,
`renderMarkdownOrEscape(`, `v-html`, `defineEmits`, `update:modelValue`, `@input`) all still hold.

- [ ] **Step 4: Wire the slug and render chips**

`apps/web/components/CommentThread.vue`:

1. Script — add the imports and the member names (after `const toast = useAppToast()`):

```ts
import { splitMentions } from '~/lib/mentions'
```

```ts
// S4a: chips show the member's current name; a former member keeps the token's label.
const memberNames = useProjectMemberNames(props.projectSlug)
onMounted(() => { void memberNames.load().catch(() => undefined) })
```

and add `onMounted` to the existing `import { computed, ref } from 'vue'`.

2. Both `<MarkdownEditor ...>` tags gain `:mention-slug="projectSlug"`:

```vue
          <MarkdownEditor v-model="editDraft" :mention-slug="projectSlug" :aria-label="t('comments.label')" />
```

```vue
            <MarkdownEditor v-bind="componentField" :mention-slug="projectSlug" :aria-label="t('comments.label')" />
```

3. Replace the body paragraph

```vue
          <p class="text-sm whitespace-pre-wrap">{{ comment.body }}</p>
```

with

```vue
          <p class="text-sm whitespace-pre-wrap"><template v-for="(part, index) in splitMentions(comment.body)" :key="index"><span v-if="'userId' in part" class="mention-chip">@{{ memberNames.nameOf(part.userId) ?? part.label }}</span><template v-else>{{ part.text }}</template></template></p>
```

(one line: `whitespace-pre-wrap` would render template indentation as spaces).

`apps/web/components/TicketActivity.vue`:

```ts
import { computed, onMounted } from 'vue'
import { withMentionChips } from '~/lib/mentions'
```

```ts
const memberNames = useProjectMemberNames(props.projectSlug)
onMounted(() => { void memberNames.load().catch(() => undefined) })

const renderedDescription = computed(() =>
  props.ticket.description
    ? renderMarkdownOrEscape(withMentionChips(props.ticket.description, id => memberNames.nameOf(id)))
    : '',
)
```

and the editor:

```vue
      <MarkdownEditor
        v-if="editing"
        :model-value="editDescription"
        :mention-slug="projectSlug"
        :aria-label="t('tickets.detail.description')"
        @update:model-value="emit('update:editDescription', $event)"
      />
```

`apps/web/components/CreateTicketDialog.vue:55`:

```vue
              <MarkdownEditor v-bind="componentField" :mention-slug="props.projectSlug" />
```

- [ ] **Step 5: Add the locale keys**

Inside `notifications` in `apps/web/i18n/locales/en.json` (created by PR 2; if PR 2 has not merged yet, create the
`notifications` object with only this key — PR 2's rebase then merges the two):

```json
    "mentions": { "pickerLabel": "Mention a project member" }
```

and in `zh.json`:

```json
    "mentions": { "pickerLabel": "提及项目成员" }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components tests/lib tests/i18n`
Expected: PASS (including the existing `CommentThread*.spec.ts` and `MarkdownEditor.spec.ts` source assertions).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/MarkdownEditor.vue apps/web/tests/components/markdown-editor-mentions.spec.ts \
  apps/web/components/CommentThread.vue apps/web/components/TicketActivity.vue apps/web/components/CreateTicketDialog.vue \
  apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json
git commit -m "feat(web): @mention member picker and chips in comments and descriptions (S4a §5)"
```

---

### Task C7: Gates and PR 3

**Files:** none new (docs only).

- [ ] **Step 1: Full gates** (all must pass; fix and amend into the owning task's commit if anything fails)

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run generate && git status --short openapi.json apps/cli/src/generated   # expect no diff (no contract change)
cd apps/api && bun run lint && bun run type-check && bun run test
bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/notifications/mentions.integration.spec.ts
cd ../web && bun run lint && bun run type-check && bun run test
bunx playwright test tests/e2e/ticket-detail-operations.e2e.spec.ts tests/e2e/ticket-lifecycle.spec.ts tests/e2e/live-board.spec.ts
```

Expected: every command exits 0 (the e2e subset covers the comment box, description editing and comment rendering
this part touched).

- [ ] **Step 2: Docs** — in `.nax/mono/apps/web/context.md` (Notifications section from PR 2, or a new one):

```markdown
- @mentions: `MarkdownEditor` takes `mention-slug`; `@` opens a member picker that inserts
  `@[Name](user:<id>)` (grammar shared with `apps/api/src/notifications/mentions.ts` — keep the two regexes
  identical). Comments render tokens via `splitMentions` (no v-html); markdown via `withMentionChips` before
  `renderMarkdownOrEscape`. The sanitizer keeps `class` only for `code.language-*` and `span.mention-chip`.
```

and in `.nax/mono/apps/api/context.md`:

```markdown
- Mentions (S4a slice 3): `notifications/ticket-mention.resolver.ts` resolves `ticket_event` mentions (create description,
  comment body, newly added on description update via `data.previousDescription`) to enabled project members or
  global admins. `TICKET_UPDATED` events that change the description carry `previousDescription`.
```

then `nax generate --all-packages` and commit (`docs: context for @mentions`).

- [ ] **Step 3: Push and open the PR** (only with the user's go-ahead to push)

```bash
git push -u origin feat/fleet-s4a-3-mentions
gh pr create --base main --title "feat(fleet): S4a PR 3 — @mentions" --body "$(cat <<'BODY'
## Summary
- `@[Name](user:<id>)` mention tokens (D504): API parser (max 20 per text), `TicketMentionResolver` limited to enabled project members and global admins, wired into the ticket notification subscriber (MENTIONED notification + MENTIONED watcher; muted watchers still get mentions).
- `TICKET_UPDATED` events that change the description now carry `previousDescription`, so only newly added mentions notify.
- Web: `@` member picker in the comment box, comment edit, description editor and create dialog; mention chips in comments (no v-html) and descriptions (sanitizer allows only `span.mention-chip`).
- Plan: `docs/superpowers/plans/2026-10-08-fleet-s4a-notifications-core.md` (Part C).

## Test plan
- [ ] api unit + lint + type-check
- [ ] api integration: notifications/mentions
- [ ] web unit + lint + type-check
- [ ] e2e: ticket-detail-operations, ticket-lifecycle, live-board
BODY
)"
```

---

## Part D — PR 4: Fleet producers

Implements spec §2.4 (fleet producers), the `FleetHealthAlert` half of §1, the fleet half of §8 and the koda-wk live
check. Branch `feat/fleet-s4a-4-fleet-producers`, cut from `main` after PR 2 (Part B) merged. Needs no Part C
code; Part B (merged before this PR) ships the web `notifications.kinds` copy and Task D8 guards it.

Ground truth this part builds on (verified on `main` `d9a23c16`):

- Every job state change goes through `JobTransitionsService.apply` (`apps/api/src/fleet/jobs/job-transitions.service.ts:31-64`),
  which is documented "Call inside txManager.run": runner reports run it inside `JobReportProcessor.process`'s
  transaction (`sync/job-report.processor.ts:66,127`), the sweeper inside its per-job `txManager.run`
  (`sync/fleet-sweeper.ts:51-57`), cancel/requeue inside `FleetJobsService` transactions. So terminal-state
  notifications are enqueued **inside `apply`**, in the caller's transaction (decision D513 below). The C9 after-commit
  hook (`FleetJobTicketEffects.onTerminal`, D451) stays as it is; it does forge and comment work that must not hold
  the job lock, which the outbox enqueue does not need to avoid.
- Ingest later corrects a job inside its own transaction (`ingest/bundle-ingest.service.ts:73-96`): a COMPLETED job can
  become ESCALATED (`correction.escalated`) and `resultPrUrl` can be filled (`'resultPrUrl' in correction.patch`).
  Both get an enqueue there, in the same transaction.
- A server terminal transition of a held job bumps `leaseEpoch` in the same update (`job-transitions.service.ts:46,55`);
  requeue bumps it again (`fleet-jobs.service.ts:247-261`). So `<jobId>:<leaseEpoch>` read **after** the update is
  unique per attempt, and a requeued attempt that fails again gets a new key.
- `ApprovalCloser.enqueueRequested` (`approvals/approval-closer.ts:158-166`) records `fleet_approval_requested` with
  payload `approvalWebhookPayload(approval, slug)` = `{ approvalId, type, status, decision, resolvedBy, projectId, jobId,
  policyId, expiresAt, path }` (`approvals/approval-payloads.ts:11-16`) for both `nax_bash_escalate` (`openBash`) and
  `budget_override_required` (`openBudget`). `PrismaOutboxStore.claimBatch` **holds** these rows until a handler for
  the type is registered (`outbox/prisma-outbox.store.ts:53-62`); registering ours releases the backlog, so the
  consumer drops asks that are no longer `pending` (decision D514).
- `BudgetEvaluator.warn` / `hardStop` insert incidents under the policy row lock inside `evaluate`'s transaction
  (`budgets/budget-evaluator.ts:72-117`); `insertIncident` returns `boolean` only (`prisma-budget.repository.ts:115-124`),
  deduplicated by the partial unique index `BudgetIncident_threshold_key (policyId, kind, windowStart, amountUsd)`.
  The incident key is therefore `<policyId>:<kind>:<windowStart ISO>:<amountUsd>`; no repository change.
- **`OutboxEvent.projectId` is `NOT NULL` with a FK to `Project`**, and `PrismaOutboxStore.save` rejects a record
  without `metadata.projectId` (`prisma-outbox.store.ts:27-31`). Global budget policies (`projectId` null) and fleet
  health alerts have no project, so Task D2 makes the column nullable and lets exactly two global types through
  (decision D512). Every other type keeps the requirement.
- Runner liveness is `isRunnerOnline(lastSeenAt, now, runnerOfflineSec)` (`fleet/common/runner-online.ts`); credential
  expiry is `isExpiring(cred, now, warnDays)` (`fleet/dashboard/credential-board.ts:23-28`); capabilities parse with
  `readCapabilities(raw)` (`fleet/dashboard/dashboard-view.ts:104-111`, null when unreadable). `FLEET_CFG` is global
  (`config/config-bridge.module.ts:11`); `sweepEnabled` is false under Jest (`config/fleet.config.ts:116`).
  The existing fleet sweeper uses an `onModuleInit` `setInterval` gated on `sweepEnabled` (`sync/fleet-sweeper.ts:36-43`);
  the health detector follows that pattern instead of `@Interval`.
- Partial unique indexes must be listed in `test/helpers/partial-indexes.ts` (replayed after `prisma db push` by
  `test/global-setup.ts`) and pinned by `test/unit/fleet/partial-indexes.spec.ts`.
- The outbox relay is off under Jest (`config/outbox.config.ts:52`); integration specs deliver by calling
  `FanOutPublisher.publish(outboxRecord(...))` (`test/helpers/outbox-record.ts`).

Decisions this part implements (already in the spec's Decisions table):

| # | Decision |
|---|---|
| D512 | `OutboxEvent.projectId` becomes nullable; `PrismaOutboxStore.save` accepts a missing `metadata.projectId` only for `GLOBAL_OUTBOX_TYPES` = `fleet_budget_incident`, `fleet_health_alert`. |
| D513 | `fleet_job_outcome` is enqueued by `FleetJobOutcomeRecorder` inside `JobTransitionsService.apply` (every terminal transition, caller's transaction) and inside the ingest correction transaction (late ESCALATED, late PR url). |
| D514 | The approval consumer notifies only asks still `pending` when the handler runs, so the backlog held since #236 does not flood admins. |
| D515 | The health detector runs every 60 s from `onModuleInit` when `FLEET_SWEEP_ENABLED`; a disabled runner never has an offline alert; unreadable capabilities hold (never close) that runner's credential alerts. |

### File Structure (Part D)

API (`apps/api`):
- Create `src/notifications/fleet/fleet-notification-events.ts` — outbox type names, payload types (contract), `jobOutcomeOf`, payload builders and parsers, `budgetIncidentId`, `budgetScopeLabel`.
- Create `src/notifications/fleet/fleet-notification-events.spec.ts`.
- Create `src/outbox/global-outbox-types.ts` — `GLOBAL_OUTBOX_TYPES`.
- Modify `src/outbox/prisma-outbox.store.ts:27-46` — nullable `projectId` for global types.
- Modify `prisma/schema.prisma` — `OutboxEvent.projectId String?` + optional relation; new `model FleetHealthAlert`.
- Create `prisma/migrations/20261009120000_fleet_health_alerts/migration.sql`.
- Modify `test/helpers/partial-indexes.ts` — the open-alert partial unique index.
- Create `src/notifications/fleet/fleet-health-alerts.repository.ts` — Prisma: runners, open alerts, open/close/purge.
- Create `test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts`.
- Modify `test/integration/outbox/prisma-outbox-store.integration.spec.ts` — global types.
- Create `src/fleet/jobs/job-outcome.recorder.ts` (+ `.spec.ts`) — enqueue side of `fleet_job_outcome`.
- Modify `src/fleet/jobs/job-transitions.service.ts` (+ `.spec.ts`), `src/fleet/jobs/fleet-jobs.module.ts`.
- Modify `src/fleet/ingest/bundle-ingest.service.ts`; Modify `src/fleet/ingest/bundle-ingest.service.spec.ts:14`, `src/fleet/ingest/bundle-ingest.pr-links.spec.ts:24-27`; Create `src/fleet/ingest/bundle-ingest.outcomes.spec.ts`.
- Create `src/fleet/budgets/budget-scope-labels.ts` (+ `.spec.ts`) — human scope labels (Prisma).
- Create `src/fleet/budgets/budget-incident.recorder.ts` (+ `.spec.ts`) — enqueue side of `fleet_budget_incident`.
- Modify `src/fleet/budgets/budget-evaluator.ts:40-117`, `src/fleet/budgets/budget-evaluator.spec.ts:10`, `src/fleet/budgets/budget-store.module.ts`, `src/fleet/budgets/budgets.module.ts`.
- Create `src/notifications/fleet/fleet-notification-drafts.ts` (+ `.spec.ts`) — pure draft builders.
- Create `src/notifications/fleet/fleet-notification.reader.ts` — project slug, approval context (Prisma).
- Create `src/notifications/fleet/fleet-job-outcome.subscriber.ts`, `fleet-approval-requested.subscriber.ts`, `fleet-budget-incident.subscriber.ts` (+ one `fleet-subscribers.spec.ts`).
- Create `src/notifications/fleet/fleet-health-plan.ts` (+ `.spec.ts`) — pure open/close planner.
- Create `src/notifications/fleet/fleet-health.detector.ts` (+ `.spec.ts`).
- Create `src/notifications/fleet/fleet-health-alert.subscriber.ts` (+ `.spec.ts`).
- Modify `src/notifications/notifications.module.ts` (Part A) — register Part D providers.
- Modify `src/notifications/notification-retention.processor.ts` (Part A) — purge closed alerts.
- Create `test/integration/notifications/fleet-job-outcome-notifications.integration.spec.ts`.
- Create `test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts`.
- Create `test/integration/notifications/fleet-health-notifications.integration.spec.ts`.

Web (`apps/web`):
- Create `tests/i18n/notifications-fleet-kinds-locale-parity.spec.ts`.

Docs: `.nax/mono/apps/api/context.md`, design doc §9.x (D10).

---

### Task D0: Cut the PR 4 branch

**Files:** none.

- [ ] **Step 1: Branch from the merged main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git switch main && git pull --ff-only
git log --oneline -1 -- apps/api/src/notifications/notification-writer.ts   # expect PR 1's commit: Part A is on main
git switch -c feat/fleet-s4a-4-fleet-producers
```

Expected: the `git log` line is non-empty. If it is empty, Part A has not merged; stop.

- [ ] **Step 2: Confirm the Part A names this part consumes**

```bash
grep -n "class NotificationWriter\|deliver(" apps/api/src/notifications/notification-writer.ts
grep -n "findGlobalAdminIds" apps/api/src/notifications/notification-eligibility.ts
grep -n "export function truncate\|TITLE_MAX\|BODY_MAX\|NotificationDraft" apps/api/src/notifications/notification.types.ts
grep -n "class NotificationsModule\|providers\|imports" apps/api/src/notifications/notifications.module.ts
grep -n "class NotificationRetentionProcessor\|@Cron\|async " apps/api/src/notifications/notification-retention.processor.ts
```

Expected: each grep prints at least one line. Note the retention processor's cron method name for Task D7 Step 3.

---

### Task D1: Fleet notification event types, builders and parsers

**Files:**
- Create: `apps/api/src/notifications/fleet/fleet-notification-events.ts`
- Test: `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts`

**Interfaces:**
- Consumes: `FleetJobState` (`apps/api/src/common/enums.ts`); `BudgetScopeType` (`apps/api/src/fleet/budgets/domain/budget.domain.ts`).
- Produces (all from `fleet-notification-events.ts`):
  - `FLEET_JOB_OUTCOME = 'fleet_job_outcome'`, `FLEET_BUDGET_INCIDENT = 'fleet_budget_incident'`, `FLEET_HEALTH_ALERT = 'fleet_health_alert'`, `FLEET_APPROVAL_REQUESTED = 'fleet_approval_requested'`.
  - `type JobOutcome = 'escalated' | 'failed' | 'crashed' | 'pr_opened'`; `type HealthAlertKind = 'runner_offline' | 'credential_expiring'`.
  - Contract payloads `FleetJobOutcomePayload`, `FleetBudgetIncidentPayload`, `FleetHealthAlertPayload`, plus `FleetApprovalRequestedPayload { approvalId: string; type: string; projectId: string | null; jobId: string | null; policyId: string | null }`.
  - `jobOutcomeOf(state: string, resultPrUrl: string | null): JobOutcome | null`
  - `buildJobOutcomePayload(job: { id; leaseEpoch; projectId; requestedById; feature; resultPrUrl }, repo: string, outcome: JobOutcome): FleetJobOutcomePayload`
  - `budgetIncidentId(policyId: string, kind: 'warn' | 'hard_stop', windowStart: Date, amountUsd: string): string`
  - `budgetScopeLabel(scopeType: BudgetScopeType, scopeId: string | null, name: string | null): string`
  - `parseJobOutcomePayload`, `parseBudgetIncidentPayload`, `parseHealthAlertPayload`, `parseApprovalRequestedPayload` — each `(raw: unknown) => T | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/notifications/fleet/fleet-notification-events.spec.ts`:

```ts
import {
  budgetIncidentId, budgetScopeLabel, buildJobOutcomePayload, jobOutcomeOf,
  parseApprovalRequestedPayload, parseBudgetIncidentPayload, parseHealthAlertPayload, parseJobOutcomePayload,
} from './fleet-notification-events';

describe('jobOutcomeOf (S4a §2.4)', () => {
  it.each([
    ['ESCALATED', null, 'escalated'],
    ['FAILED', null, 'failed'],
    ['CRASHED', null, 'crashed'],
    ['COMPLETED', 'https://github.com/acme/app/pull/3', 'pr_opened'],
    ['COMPLETED', null, null],
    ['CANCELLED', null, null],
    ['RUNNING', null, null],
  ] as const)('%s with pr %s -> %s', (state, pr, expected) => {
    expect(jobOutcomeOf(state, pr)).toBe(expected);
  });
});

describe('buildJobOutcomePayload', () => {
  it('carries the attempt epoch, requester and the PR url', () => {
    const job = { id: 'j1', leaseEpoch: 3, projectId: 'p1', requestedById: 'u1', feature: 'add', resultPrUrl: 'https://x/pull/1' };
    expect(buildJobOutcomePayload(job, 'acme/app', 'pr_opened')).toEqual({
      jobId: 'j1', leaseEpoch: 3, projectId: 'p1', requestedById: 'u1', outcome: 'pr_opened', repo: 'acme/app', feature: 'add',
      resultPrUrl: 'https://x/pull/1',
    });
  });
});

describe('budgetIncidentId', () => {
  it('is the incident dedupe key (policy, kind, window, amount)', () => {
    expect(budgetIncidentId('pol1', 'warn', new Date('2026-10-01T00:00:00.000Z'), '10'))
      .toBe('pol1:warn:2026-10-01T00:00:00.000Z:10');
  });
});

describe('budgetScopeLabel', () => {
  it.each([
    ['global', null, null, 'global'],
    ['project', 'p1', 'KODA', 'project KODA'],
    ['repo', 'r1', 'acme/app', 'acme/app'],
    ['runner', 'rn1', 'wk-mac', 'runner wk-mac'],
    ['repo', 'r9', null, 'repo r9'],
  ] as const)('%s %s (%s) -> %s', (type, id, name, expected) => {
    expect(budgetScopeLabel(type, id, name)).toBe(expected);
  });
});

describe('payload parsers', () => {
  const outcome = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', requestedById: 'u1', outcome: 'failed', repo: 'acme/app', feature: 'f', resultPrUrl: null };

  it('accepts a well-formed job outcome and rejects bad ones', () => {
    expect(parseJobOutcomePayload(outcome)).toEqual(outcome);
    expect(parseJobOutcomePayload({ ...outcome, outcome: 'cancelled' })).toBeNull();
    expect(parseJobOutcomePayload({ ...outcome, leaseEpoch: '1' })).toBeNull();
    expect(parseJobOutcomePayload({ ...outcome, requestedById: '' })).toBeNull();
    expect(parseJobOutcomePayload(null)).toBeNull();
    expect(parseJobOutcomePayload('x')).toBeNull();
  });

  it('accepts a budget incident and rejects an unknown kind', () => {
    const p = { incidentId: 'i', kind: 'hard_stop', scope: 'global', spentUsd: '12.5', amountUsd: '10' };
    expect(parseBudgetIncidentPayload(p)).toEqual(p);
    expect(parseBudgetIncidentPayload({ ...p, kind: 'resumed' })).toBeNull();
  });

  it('accepts a health alert with or without provider', () => {
    const offline = { alertId: 'a', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null };
    const cred = { alertId: 'b', kind: 'credential_expiring', runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11T00:00:00.000Z' };
    expect(parseHealthAlertPayload(offline)).toEqual(offline);
    expect(parseHealthAlertPayload(cred)).toEqual(cred);
    expect(parseHealthAlertPayload({ ...offline, kind: 'disk_full' })).toBeNull();
  });

  it('reads the #236 approval payload and ignores its other fields', () => {
    const raw = { approvalId: 'ap1', type: 'nax_bash_escalate', status: 'pending', decision: null, resolvedBy: null, projectId: 'p1', jobId: 'j1', policyId: null, expiresAt: null, path: '/web/fleet/approvals?id=ap1' };
    expect(parseApprovalRequestedPayload(raw)).toEqual({ approvalId: 'ap1', type: 'nax_bash_escalate', projectId: 'p1', jobId: 'j1', policyId: null });
    expect(parseApprovalRequestedPayload({ ...raw, approvalId: 7 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/notifications/fleet/fleet-notification-events.spec.ts`
Expected: FAIL — "Cannot find module './fleet-notification-events'".

- [ ] **Step 3: Implement**

Create `apps/api/src/notifications/fleet/fleet-notification-events.ts`:

```ts
import { FleetJobState } from '../../common/enums';
import type { BudgetScopeType } from '../../fleet/budgets/domain/budget.domain';

/**
 * Fleet S4a §2.4: outbox event types the fleet enqueues for notifications, their payloads and the pure helpers
 * shared by the enqueue side (fleet modules) and the consumers (notifications/fleet). No Nest imports here, so
 * fleet modules can import it without a module cycle.
 */
export const FLEET_JOB_OUTCOME = 'fleet_job_outcome';
export const FLEET_BUDGET_INCIDENT = 'fleet_budget_incident';
export const FLEET_HEALTH_ALERT = 'fleet_health_alert';
/** Enqueued by ApprovalCloser.enqueueRequested since #236. */
export const FLEET_APPROVAL_REQUESTED = 'fleet_approval_requested';

export const JOB_OUTCOMES = ['escalated', 'failed', 'crashed', 'pr_opened'] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export const HEALTH_ALERT_KINDS = ['runner_offline', 'credential_expiring'] as const;
export type HealthAlertKind = (typeof HEALTH_ALERT_KINDS)[number];
const BUDGET_INCIDENT_KINDS = ['warn', 'hard_stop'] as const;
export type BudgetIncidentNotifyKind = (typeof BUDGET_INCIDENT_KINDS)[number];

export interface FleetJobOutcomePayload { jobId: string; leaseEpoch: number; projectId: string; requestedById: string;
  outcome: JobOutcome; repo: string; feature: string; resultPrUrl: string | null }
export interface FleetBudgetIncidentPayload { incidentId: string; kind: BudgetIncidentNotifyKind; scope: string; spentUsd: string; amountUsd: string }
export interface FleetHealthAlertPayload { alertId: string; kind: HealthAlertKind; runner: string; provider: string | null; expiresAt: string | null }
/** The fields of approvalWebhookPayload (approvals/approval-payloads.ts) the consumer needs. */
export interface FleetApprovalRequestedPayload { approvalId: string; type: string; projectId: string | null; jobId: string | null; policyId: string | null }

const FAILURE_OUTCOME: Readonly<Record<string, JobOutcome>> = Object.freeze({
  [FleetJobState.ESCALATED]: 'escalated',
  [FleetJobState.FAILED]: 'failed',
  [FleetJobState.CRASHED]: 'crashed',
});

/** S4a §2.4: which terminal states notify the requester. CANCELLED and a COMPLETED job without a PR do not. */
export function jobOutcomeOf(state: string, resultPrUrl: string | null): JobOutcome | null {
  if (Object.prototype.hasOwnProperty.call(FAILURE_OUTCOME, state)) return FAILURE_OUTCOME[state];
  return state === FleetJobState.COMPLETED && resultPrUrl ? 'pr_opened' : null;
}

export function buildJobOutcomePayload(
  job: { id: string; leaseEpoch: number; projectId: string; requestedById: string; feature: string; resultPrUrl: string | null },
  repo: string,
  outcome: JobOutcome,
): FleetJobOutcomePayload {
  return {
    jobId: job.id, leaseEpoch: job.leaseEpoch, projectId: job.projectId, requestedById: job.requestedById,
    outcome, repo, feature: job.feature, resultPrUrl: job.resultPrUrl ?? null,
  };
}

/** The BudgetIncident_threshold_key columns: stable across re-evaluations, so it is the notification source id. */
export function budgetIncidentId(policyId: string, kind: BudgetIncidentNotifyKind, windowStart: Date, amountUsd: string): string {
  return `${policyId}:${kind}:${windowStart.toISOString()}:${amountUsd}`;
}

/** `name` is the project key, `owner/name` of the repo, or the runner name; null when the row is gone. */
export function budgetScopeLabel(scopeType: BudgetScopeType, scopeId: string | null, name: string | null): string {
  if (scopeType === 'global') return 'global';
  if (name === null) return `${scopeType} ${scopeId ?? ''}`.trim();
  return scopeType === 'repo' ? name : `${scopeType} ${name}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const textOrNull = (v: unknown): string | null => (isText(v) ? v : null);
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);

export function parseJobOutcomePayload(raw: unknown): FleetJobOutcomePayload | null {
  if (!isObject(raw)) return null;
  const { jobId, leaseEpoch, projectId, requestedById, outcome, repo, feature, resultPrUrl } = raw;
  if (!isText(jobId) || !isText(projectId) || !isText(requestedById) || !isText(repo) || typeof feature !== 'string') return null;
  if (typeof leaseEpoch !== 'number' || !Number.isInteger(leaseEpoch) || !oneOf(JOB_OUTCOMES, outcome)) return null;
  return { jobId, leaseEpoch, projectId, requestedById, outcome, repo, feature, resultPrUrl: textOrNull(resultPrUrl) };
}

export function parseBudgetIncidentPayload(raw: unknown): FleetBudgetIncidentPayload | null {
  if (!isObject(raw)) return null;
  const { incidentId, kind, scope, spentUsd, amountUsd } = raw;
  if (!isText(incidentId) || !oneOf(BUDGET_INCIDENT_KINDS, kind) || !isText(scope) || !isText(spentUsd) || !isText(amountUsd)) return null;
  return { incidentId, kind, scope, spentUsd, amountUsd };
}

export function parseHealthAlertPayload(raw: unknown): FleetHealthAlertPayload | null {
  if (!isObject(raw)) return null;
  const { alertId, kind, runner, provider, expiresAt } = raw;
  if (!isText(alertId) || !oneOf(HEALTH_ALERT_KINDS, kind) || !isText(runner)) return null;
  return { alertId, kind, runner, provider: textOrNull(provider), expiresAt: textOrNull(expiresAt) };
}

export function parseApprovalRequestedPayload(raw: unknown): FleetApprovalRequestedPayload | null {
  if (!isObject(raw)) return null;
  const { approvalId, type, projectId, jobId, policyId } = raw;
  if (!isText(approvalId) || !isText(type)) return null;
  return { approvalId, type, projectId: textOrNull(projectId), jobId: textOrNull(jobId), policyId: textOrNull(policyId) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && bun run test:scoped src/notifications/fleet/fleet-notification-events.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/fleet/fleet-notification-events.ts apps/api/src/notifications/fleet/fleet-notification-events.spec.ts
git commit -m "feat(notifications): fleet notification event types and payload parsers (S4a §2.4)"
```

---

### Task D2: Global outbox types, `FleetHealthAlert` schema and its repository

**Files:**
- Create: `apps/api/src/outbox/global-outbox-types.ts`
- Modify: `apps/api/src/outbox/prisma-outbox.store.ts:27-46` (`save`)
- Modify: `apps/api/prisma/schema.prisma` (model `OutboxEvent`; new model `FleetHealthAlert` after `model Runner`)
- Create: `apps/api/prisma/migrations/20261009120000_fleet_health_alerts/migration.sql`
- Modify: `apps/api/test/helpers/partial-indexes.ts`
- Create: `apps/api/src/notifications/fleet/fleet-health-alerts.repository.ts`
- Test: `apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts` (new case), `apps/api/test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts`

**Interfaces:**
- Consumes: `FLEET_BUDGET_INCIDENT`, `FLEET_HEALTH_ALERT`, `HealthAlertKind` (D1).
- Produces:
  - `GLOBAL_OUTBOX_TYPES: ReadonlySet<string>`.
  - Prisma model `FleetHealthAlert { id, kind, subjectKey, openedAt, closedAt? }`; `OutboxEvent.projectId: string | null`.
  - `FleetHealthAlertsRepository`:
    - `findRunners(): Promise<HealthRunnerRow[]>` where `HealthRunnerRow = { id: string; name: string; enabled: boolean; lastSeenAt: Date; capabilities: unknown }`
    - `findOpen(): Promise<OpenHealthAlert[]>` where `OpenHealthAlert = { id: string; kind: HealthAlertKind; subjectKey: string }`
    - `open(kind: HealthAlertKind, subjectKey: string, now: Date): Promise<string | null>` (null = an open alert already exists)
    - `close(ids: readonly string[], now: Date): Promise<number>`
    - `purgeClosed(before: Date): Promise<number>`

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts`, add inside `describe('save (via the package OutboxService.record)', ...)`, right after the case `'rejects a record without metadata.projectId'`:

```ts
    it('stores a global fleet type without projectId (S4a D512)', async () => {
      const record = await outbox.record({ type: 'fleet_health_alert', payload: { alertId: 'a1' }, metadata: { eventId: 'a1' } });
      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
      expect(row).toMatchObject({ projectId: null, eventId: 'a1', type: 'fleet_health_alert' });
      const [claimed] = await store.claimBatch(10, 30_000, new Date(Date.now() + 1000), 'w1');
      expect(claimed.metadata).toEqual({ projectId: null, eventId: 'a1' });
    });

    it('still rejects a non-global type without projectId', async () => {
      await expect(outbox.record({ type: 'fleet_job_outcome', payload: {} })).rejects.toBeInstanceOf(ValidationAppException);
    });
```

Create `apps/api/test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts`:

```ts
/**
 * Fleet S4a §1 — FleetHealthAlert and its repository (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { insertRunner } from '../../helpers/fleet-fixtures';
import { FleetHealthAlertsRepository } from '../../../src/notifications/fleet/fleet-health-alerts.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('FleetHealthAlert (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new FleetHealthAlertsRepository({ client: prisma } as never);
  const now = new Date('2026-10-09T12:00:00.000Z');

  beforeAll(async () => {
    await resetDb();
  });
  beforeEach(async () => {
    await prisma.fleetHealthAlert.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps at most one open alert per kind and subject; a closed one does not block a new episode', async () => {
    const first = await repo.open('runner_offline', 'rn1', now);
    expect(first).toEqual(expect.any(String));
    expect(await repo.open('runner_offline', 'rn1', now)).toBeNull();
    expect(await repo.open('credential_expiring', 'rn1', now)).toEqual(expect.any(String));
    expect(await repo.close([first as string], now)).toBe(1);
    expect(await repo.close([first as string], now)).toBe(0);
    const second = await repo.open('runner_offline', 'rn1', now);
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect((await repo.findOpen()).map((a) => a.kind).sort()).toEqual(['credential_expiring', 'runner_offline']);
  });

  it('purges only alerts closed before the cutoff', async () => {
    const old = await repo.open('runner_offline', 'old', now);
    const recent = await repo.open('runner_offline', 'recent', now);
    await repo.close([old as string], new Date('2026-08-01T00:00:00.000Z'));
    await repo.close([recent as string], now);
    expect(await repo.purgeClosed(new Date('2026-09-09T00:00:00.000Z'))).toBe(1);
    expect(await prisma.fleetHealthAlert.count()).toBe(1);
  });

  it('lists runners with what the detector needs', async () => {
    const r = await insertRunner(prisma, { name: 'health-r1' });
    const rows = await repo.findRunners();
    expect(rows.find((x) => x.id === r.id)).toMatchObject({ name: 'health-r1', enabled: true, lastSeenAt: expect.any(Date), capabilities: expect.any(Object) });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts test/integration/outbox/prisma-outbox-store.integration.spec.ts`
Expected: FAIL — "Cannot find module '../../../src/notifications/fleet/fleet-health-alerts.repository'" and the outbox case rejects with `ValidationAppException` (projectId required).

- [ ] **Step 3: Schema, migration, partial index**

In `apps/api/prisma/schema.prisma`, model `OutboxEvent`, replace the two lines

```prisma
  projectId     String
```
```prisma
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
```

with

```prisma
  projectId     String? // null only for GLOBAL_OUTBOX_TYPES (S4a D512)
```
```prisma
  project Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)
```

Add after `model Runner { ... }`:

```prisma
/// Fleet S4a §1 (D507): one runner-offline or credential-expiring episode. At most one open row per (kind, subjectKey)
/// (partial unique index in the migration). subjectKey = runnerId, or runnerId:providerId.
model FleetHealthAlert {
  id         String    @id @default(cuid())
  kind       String // runner_offline | credential_expiring
  subjectKey String
  openedAt   DateTime  @default(now())
  closedAt   DateTime?

  @@index([kind, subjectKey, closedAt])
  @@index([closedAt])
}
```

Create `apps/api/prisma/migrations/20261009120000_fleet_health_alerts/migration.sql` (the timestamp must sort after
Part A's `*_notifications_core` migration; check with `ls apps/api/prisma/migrations | tail -3` and bump the date if
needed):

```sql
-- Fleet S4a: global outbox events (D512) and fleet health alert episodes (§1, D507).
-- AlterTable
ALTER TABLE "OutboxEvent" ALTER COLUMN "projectId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "FleetHealthAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "FleetHealthAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FleetHealthAlert_kind_subjectKey_closedAt_idx" ON "FleetHealthAlert"("kind", "subjectKey", "closedAt");

-- CreateIndex
CREATE INDEX "FleetHealthAlert_closedAt_idx" ON "FleetHealthAlert"("closedAt");

-- One open episode per subject (not expressible in Prisma; replayed by test/global-setup.ts).
CREATE UNIQUE INDEX IF NOT EXISTS "FleetHealthAlert_open_subject_key" ON "FleetHealthAlert" ("kind", "subjectKey") WHERE "closedAt" IS NULL;
```

In `apps/api/test/helpers/partial-indexes.ts`, append to `PARTIAL_UNIQUE_INDEXES`:

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetHealthAlert_open_subject_key" ON "FleetHealthAlert" ("kind", "subjectKey") WHERE "closedAt" IS NULL`,
```

Run: `cd apps/api && bun run db:generate`
Expected: "Generated Prisma Client".

- [ ] **Step 4: Global outbox types in the store**

Create `apps/api/src/outbox/global-outbox-types.ts`:

```ts
import { FLEET_BUDGET_INCIDENT, FLEET_HEALTH_ALERT } from '../notifications/fleet/fleet-notification-events';

/**
 * Fleet S4a D512: outbox types that may have no project (a global budget policy, a fleet health alert).
 * Every other type still requires metadata.projectId.
 */
export const GLOBAL_OUTBOX_TYPES: ReadonlySet<string> = new Set([FLEET_BUDGET_INCIDENT, FLEET_HEALTH_ALERT]);
```

In `apps/api/src/outbox/prisma-outbox.store.ts`, add the import

```ts
import { GLOBAL_OUTBOX_TYPES } from './global-outbox-types';
```

and replace the start of `save` (the `projectId` check through `data: { id: record.id, projectId,`) with:

```ts
  async save(record: OutboxRecord, client: unknown): Promise<void> {
    const raw = record.metadata?.['projectId'];
    const projectId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (projectId === null && !GLOBAL_OUTBOX_TYPES.has(record.type)) {
      throw new ValidationAppException({ projectId: 'outbox record metadata.projectId is required' }, 'outbox');
    }
    const eventId = record.metadata?.['eventId'];
    const db = (client ?? this.prisma.client) as PrismaClient;
    await db.outboxEvent.create({
      data: {
        id: record.id,
        projectId,
```

(the remaining fields of `data` are unchanged). `toRecord` already returns `metadata: { projectId: row.projectId, ... }`,
which is now `null` for global rows.

- [ ] **Step 5: The repository**

Create `apps/api/src/notifications/fleet/fleet-health-alerts.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { randomUUID } from 'crypto';
import { HEALTH_ALERT_KINDS, HealthAlertKind } from './fleet-notification-events';

export interface HealthRunnerRow { id: string; name: string; enabled: boolean; lastSeenAt: Date; capabilities: unknown }
export interface OpenHealthAlert { id: string; kind: HealthAlertKind; subjectKey: string }

const isKind = (k: string): k is HealthAlertKind => (HEALTH_ALERT_KINDS as readonly string[]).includes(k);

/** Fleet S4a §2.4 (D507): health alert episodes. Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
@Injectable()
export class FleetHealthAlertsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findRunners(): Promise<HealthRunnerRow[]> {
    return this.db.runner.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, enabled: true, lastSeenAt: true, capabilities: true },
    });
  }

  async findOpen(): Promise<OpenHealthAlert[]> {
    const rows = await this.db.fleetHealthAlert.findMany({
      where: { closedAt: null }, orderBy: { openedAt: 'asc' }, select: { id: true, kind: true, subjectKey: true },
    });
    return rows.flatMap((r) => (isKind(r.kind) ? [{ id: r.id, kind: r.kind, subjectKey: r.subjectKey }] : []));
  }

  /** Null when an open alert for (kind, subjectKey) exists (FleetHealthAlert_open_subject_key). */
  async open(kind: HealthAlertKind, subjectKey: string, now: Date): Promise<string | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "FleetHealthAlert" ("id", "kind", "subjectKey", "openedAt")
      VALUES (${randomUUID()}, ${kind}, ${subjectKey}, CAST(${now.toISOString()} AS timestamp(3)))
      ON CONFLICT DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  async close(ids: readonly string[], now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.db.fleetHealthAlert.updateMany({ where: { id: { in: [...ids] }, closedAt: null }, data: { closedAt: now } });
    return count;
  }

  async purgeClosed(before: Date): Promise<number> {
    const { count } = await this.db.fleetHealthAlert.deleteMany({ where: { closedAt: { lt: before } } });
    return count;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts test/integration/outbox/prisma-outbox-store.integration.spec.ts test/unit/fleet/partial-indexes.spec.ts`
Expected: PASS, including the existing `'rejects a record without metadata.projectId'` case.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/outbox/global-outbox-types.ts apps/api/src/outbox/prisma-outbox.store.ts \
  apps/api/test/helpers/partial-indexes.ts apps/api/src/notifications/fleet/fleet-health-alerts.repository.ts \
  apps/api/test/integration/notifications/fleet-health-alerts-schema.integration.spec.ts \
  apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts
git commit -m "feat(notifications): FleetHealthAlert episodes and global outbox events (S4a D507, D512)"
```

---

### Task D3: Enqueue `fleet_job_outcome` from terminal transitions and ingest corrections

**Files:**
- Create: `apps/api/src/fleet/jobs/job-outcome.recorder.ts`
- Test: `apps/api/src/fleet/jobs/job-outcome.recorder.spec.ts`
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.ts:31-64` (constructor + `apply`)
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.spec.ts` (constructor call + new cases)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts` (provider + export)
- Modify: `apps/api/src/fleet/ingest/bundle-ingest.service.ts:27-36,73-96`
- Modify: `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts:14`, `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts:24-27`
- Test: `apps/api/src/fleet/ingest/bundle-ingest.outcomes.spec.ts`

**Interfaces:**
- Consumes: `FLEET_JOB_OUTCOME`, `jobOutcomeOf`, `buildJobOutcomePayload`, `JobOutcome` (D1); `OutboxService` (`@nathapp/nestjs-outbox`, global); `IFleetJobRepository.findRepo`.
- Produces: `FleetJobOutcomeRecorder` (exported by `FleetJobsModule`):
  - `onTerminal(job: FleetJobRecord): Promise<void>` — call inside the transaction that made `job` terminal.
  - `onIngestCorrection(job: FleetJobRecord, change: { escalated: boolean; prFilled: boolean }): Promise<void>` — call inside the ingest transaction with the updated job.
  - Outbox row: `type 'fleet_job_outcome'`, `metadata { projectId: job.projectId, eventId: '<jobId>:<leaseEpoch>' }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/fleet/jobs/job-outcome.recorder.spec.ts`:

```ts
import { FleetJobOutcomeRecorder } from './job-outcome.recorder';
import type { FleetJobRecord } from './domain/fleet-job.domain';

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', feature: 'add', leaseEpoch: 2, state: 'FAILED', requestedById: 'u1', resultPrUrl: null,
  ...over,
} as FleetJobRecord);

describe('FleetJobOutcomeRecorder (S4a §2.4, D513)', () => {
  const repo = { findRepo: jest.fn(async () => ({ owner: 'acme', name: 'app' })) };
  const outbox = { record: jest.fn(async () => undefined) };
  const recorder = new FleetJobOutcomeRecorder(repo as never, outbox as never);
  afterEach(() => jest.clearAllMocks());

  it.each([
    ['ESCALATED', null, 'escalated'],
    ['FAILED', null, 'failed'],
    ['CRASHED', null, 'crashed'],
    ['COMPLETED', 'https://github.com/acme/app/pull/4', 'pr_opened'],
  ] as const)('enqueues %s as %s', async (state, pr, outcome) => {
    await recorder.onTerminal(job({ state, resultPrUrl: pr }));
    expect(outbox.record).toHaveBeenCalledWith({
      type: 'fleet_job_outcome',
      payload: { jobId: 'j1', leaseEpoch: 2, projectId: 'p1', requestedById: 'u1', outcome, repo: 'acme/app', feature: 'add', resultPrUrl: pr },
      metadata: { projectId: 'p1', eventId: 'j1:2' },
    });
  });

  it.each(['CANCELLED', 'COMPLETED', 'RUNNING'] as const)('enqueues nothing for %s without a PR', async (state) => {
    await recorder.onTerminal(job({ state }));
    expect(outbox.record).not.toHaveBeenCalled();
    expect(repo.findRepo).not.toHaveBeenCalled();
  });

  it('falls back to the repo id when the repo row is gone', async () => {
    repo.findRepo.mockResolvedValueOnce(null);
    await recorder.onTerminal(job());
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ repo: 'r1' }) }));
  });

  it('ingest: a late escalation wins over a late PR url', async () => {
    await recorder.onIngestCorrection(job({ state: 'ESCALATED', resultPrUrl: 'https://x/pull/1' }), { escalated: true, prFilled: true });
    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ outcome: 'escalated' }) }));
  });

  it('ingest: a late PR url on a COMPLETED job is pr_opened; nothing else enqueues', async () => {
    await recorder.onIngestCorrection(job({ state: 'COMPLETED', resultPrUrl: 'https://x/pull/1' }), { escalated: false, prFilled: true });
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ outcome: 'pr_opened' }) }));
    outbox.record.mockClear();
    await recorder.onIngestCorrection(job({ state: 'COMPLETED', resultPrUrl: null }), { escalated: false, prFilled: false });
    expect(outbox.record).not.toHaveBeenCalled();
  });
});
```

In `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, replace

```ts
  const closer = { closeForJob: jest.fn().mockResolvedValue([APPROVAL_LIVE]) };
  const svc = new JobTransitionsService(repo as never, activity as never, live as never, schedules as never, closer as never);
```

with

```ts
  const closer = { closeForJob: jest.fn().mockResolvedValue([APPROVAL_LIVE]) };
  const outcomes = { onTerminal: jest.fn(async () => undefined) };
  const svc = new JobTransitionsService(repo as never, activity as never, live as never, schedules as never, closer as never, outcomes as never);
```

and add, before the closing `});` of the top-level `describe`:

```ts
  describe('notification outcome (S4a §2.4, D513)', () => {
    it('hands every terminal job to the outcome recorder, after the update', async () => {
      await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'ESCALATED', by: 'runner', now: NOW, actor: ACTOR });
      expect(outcomes.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1', state: 'ESCALATED' }));
      expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(outcomes.onTerminal.mock.invocationCallOrder[0]);
    });

    it('passes the bumped epoch of a server terminal transition', async () => {
      await svc.apply({ job: job({ state: 'RUNNING' }), to: 'CRASHED', by: 'server', now: NOW, actor: SYSTEM_ACTOR });
      expect(outcomes.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ state: 'CRASHED', leaseEpoch: 3 }));
    });

    it('does not call the recorder for a non-terminal move', async () => {
      await svc.apply({ job: job({ state: 'ASSIGNED' }), to: 'RUNNING', by: 'runner', now: NOW, actor: ACTOR });
      expect(outcomes.onTerminal).not.toHaveBeenCalled();
    });
  });
```

In `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts:14`, append one constructor argument:

```ts
  const svc = new BundleIngestService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, { run: (fn: () => unknown) => fn() } as never, { upsertPrLinks: jest.fn() } as never, { onIngestCorrection: jest.fn() } as never);
```

In `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts`, replace the constructor call in `make()` with:

```ts
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: jest.fn() } as never, { signal: jest.fn() } as never,
    { run: (fn: () => unknown) => fn() } as never, ticketEffects as never, { onIngestCorrection: jest.fn() } as never,
  );
```

Create `apps/api/src/fleet/ingest/bundle-ingest.outcomes.spec.ts`:

```ts
import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';
import { computeCorrection } from './ingest-corrections';

jest.mock('./bundle-reader', () => ({ readBundleFiles: jest.fn(async () => ({})) }));
jest.mock('./parse-bundle', () => ({
  parseBundle: jest.fn(() => ({ naxRunId: null, rows: [], ledgerCostUsd: '0', runStatus: 'completed', finish: null, partial: false, files: [] })),
}));
jest.mock('./ingest-corrections', () => ({ computeCorrection: jest.fn() }));

const now = new Date('2026-10-09T10:00:00Z');

function make(updated: Record<string, unknown>) {
  const job = { id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED', requestedById: 'u', resultPrUrl: null };
  const repo = {
    claimNext: jest.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: jest.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: jest.fn(), markOutcome: jest.fn(), markRetry: jest.fn(), markFailed: jest.fn(),
  };
  const store = { get: jest.fn(async () => Readable.from([])) };
  const jobs = { lockById: jest.fn(async () => job), update: jest.fn(async () => ({ ...job, ...updated })), appendEvent: jest.fn() };
  const live = { event: jest.fn(() => ({})), publish: jest.fn() };
  const order: string[] = [];
  const outcomes = { onIngestCorrection: jest.fn(async () => { order.push('outcome'); }) };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: jest.fn() } as never, { signal: jest.fn() } as never,
    { run: async (fn: () => unknown) => { order.push('tx:start'); const r = await fn(); order.push('tx:end'); return r; } } as never,
    { upsertPrLinks: jest.fn().mockResolvedValue(undefined) } as never, outcomes as never,
  );
  return { svc, outcomes, repo, order };
}

describe('BundleIngestService notification outcomes (S4a §2.4, D513)', () => {
  it('reports a verdict correction to the recorder inside the ingest transaction', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: { state: 'ESCALATED' }, costRaised: false, escalated: true, liveCostUsd: null });
    const { svc, outcomes, order, repo } = make({ state: 'ESCALATED' });
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(outcomes.onIngestCorrection).toHaveBeenCalledWith(expect.objectContaining({ state: 'ESCALATED' }), { escalated: true, prFilled: false });
    expect(order).toEqual(['tx:start', 'outcome', 'tx:end']);
  });

  it('reports a late PR url', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: { resultPrUrl: 'https://x/pull/2' }, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, outcomes } = make({ resultPrUrl: 'https://x/pull/2' });
    await svc.ingestOne(now);
    expect(outcomes.onIngestCorrection).toHaveBeenCalledWith(expect.objectContaining({ resultPrUrl: 'https://x/pull/2' }), { escalated: false, prFilled: true });
  });

  it('does not call the recorder when the correction changed neither', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, outcomes } = make({});
    await svc.ingestOne(now);
    expect(outcomes.onIngestCorrection).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/job-outcome.recorder.spec.ts src/fleet/jobs/job-transitions.service.spec.ts src/fleet/ingest/bundle-ingest.outcomes.spec.ts`
Expected: FAIL — "Cannot find module './job-outcome.recorder'"; the transitions and ingest cases fail because `onTerminal` / `onIngestCorrection` are never called.

- [ ] **Step 3: Implement the recorder**

Create `apps/api/src/fleet/jobs/job-outcome.recorder.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { FleetJobState } from '../../common/enums';
import {
  buildJobOutcomePayload, FLEET_JOB_OUTCOME, JobOutcome, jobOutcomeOf,
} from '../../notifications/fleet/fleet-notification-events';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';

/**
 * Fleet S4a §2.4 (D513): the enqueue side of `fleet_job_outcome`. Always called inside the caller's transaction,
 * so the outbox row commits or rolls back with the state change. The source id is `<jobId>:<leaseEpoch>` read
 * after the update: a requeued attempt that ends the same way notifies again; a retry of the same attempt does not.
 */
@Injectable()
export class FleetJobOutcomeRecorder {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'findRepo'>,
    private readonly outbox: OutboxService,
  ) {}

  async onTerminal(job: FleetJobRecord): Promise<void> {
    const outcome = jobOutcomeOf(job.state, job.resultPrUrl);
    if (outcome) await this.enqueue(job, outcome);
  }

  async onIngestCorrection(job: FleetJobRecord, change: { escalated: boolean; prFilled: boolean }): Promise<void> {
    if (change.escalated) {
      await this.enqueue(job, 'escalated');
      return;
    }
    if (change.prFilled && job.state === FleetJobState.COMPLETED && job.resultPrUrl) await this.enqueue(job, 'pr_opened');
  }

  private async enqueue(job: FleetJobRecord, outcome: JobOutcome): Promise<void> {
    const repo = await this.repo.findRepo(job.repoId);
    await this.outbox.record({
      type: FLEET_JOB_OUTCOME,
      payload: buildJobOutcomePayload(job, repo ? `${repo.owner}/${repo.name}` : job.repoId, outcome),
      metadata: { projectId: job.projectId, eventId: `${job.id}:${job.leaseEpoch}` },
    });
  }
}
```

- [ ] **Step 4: Wire it into `JobTransitionsService.apply`**

In `apps/api/src/fleet/jobs/job-transitions.service.ts`, add the import

```ts
import { FleetJobOutcomeRecorder } from './job-outcome.recorder';
```

add a sixth constructor parameter after `private readonly approvals: ApprovalCloser,`:

```ts
    private readonly outcomes: FleetJobOutcomeRecorder,
```

and in `apply`, right after the `copyConfigResult` line:

```ts
    // Fleet S4a §2.4 (D513): the requester's notification, in this same transaction.
    if (terminal) await this.outcomes.onTerminal(after);
```

In `apps/api/src/fleet/jobs/fleet-jobs.module.ts`, add `import { FleetJobOutcomeRecorder } from './job-outcome.recorder';`,
add `FleetJobOutcomeRecorder,` to `providers` (before `JobTransitionsService`) and to `exports`.

- [ ] **Step 5: Wire it into the ingest transaction**

In `apps/api/src/fleet/ingest/bundle-ingest.service.ts`, add the import

```ts
import { FleetJobOutcomeRecorder } from '../jobs/job-outcome.recorder';
```

add a ninth constructor parameter after `private readonly ticketEffects: FleetJobTicketEffects,`:

```ts
    private readonly outcomes: FleetJobOutcomeRecorder,
```

and in `write`, inside `txManager.run`, right after `const updated = changed ? ... : job;` add:

```ts
      const prFilled = 'resultPrUrl' in correction.patch;
      if (correction.escalated || prFilled) await this.outcomes.onIngestCorrection(updated, { escalated: correction.escalated, prFilled });
```

and change the transaction's return value to reuse it:

```ts
      return { event: this.live.event(updated), spendKeys: correction.costRaised ? jobSpendKeys(updated) : [], prFilled };
```

`IngestModule` already imports `FleetJobsModule`, which now exports the recorder; no module change.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs src/fleet/ingest src/fleet/sync src/fleet/budgets && bun run type-check`
Expected: PASS; type-check clean (every `new JobTransitionsService(` / `new BundleIngestService(` call site updated —
confirm with `grep -rn "new JobTransitionsService(\|new BundleIngestService(" src test`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/jobs apps/api/src/fleet/ingest
git commit -m "feat(fleet): enqueue fleet_job_outcome in terminal and ingest transactions (S4a §2.4, D513)"
```

---

### Task D4: Enqueue `fleet_budget_incident` inside the evaluator transaction

**Files:**
- Create: `apps/api/src/fleet/budgets/budget-scope-labels.ts`
- Test: `apps/api/src/fleet/budgets/budget-scope-labels.spec.ts`
- Create: `apps/api/src/fleet/budgets/budget-incident.recorder.ts`
- Test: `apps/api/src/fleet/budgets/budget-incident.recorder.spec.ts`
- Modify: `apps/api/src/fleet/budgets/budget-evaluator.ts:40-117`
- Modify: `apps/api/src/fleet/budgets/budget-evaluator.spec.ts:10`
- Modify: `apps/api/src/fleet/budgets/budget-store.module.ts`, `apps/api/src/fleet/budgets/budgets.module.ts`

**Interfaces:**
- Consumes: `budgetScopeLabel`, `budgetIncidentId`, `FLEET_BUDGET_INCIDENT`, `FleetBudgetIncidentPayload` (D1); `GLOBAL_OUTBOX_TYPES` behaviour (D2); `BudgetPolicyRecord`, `BudgetScope`, `BudgetScopeType`.
- Produces:
  - `BudgetScopeLabels` (exported by `BudgetStoreModule`): `forScope(scope: BudgetScope): Promise<string>`, `forPolicy(policyId: string): Promise<string | null>`.
  - `BudgetIncidentRecorder` (provided by `BudgetsModule`): `record(policy: BudgetPolicyRecord, kind: 'warn' | 'hard_stop', windowStart: Date, spentUsd: string): Promise<void>`.
  - Outbox row `type 'fleet_budget_incident'`, `metadata { projectId: policy.projectId (null for global), eventId: <incidentId> }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/fleet/budgets/budget-scope-labels.spec.ts`:

```ts
import { BudgetScopeLabels } from './budget-scope-labels';

describe('BudgetScopeLabels (S4a §2.4)', () => {
  const db = {
    project: { findUnique: jest.fn(async () => ({ key: 'KODA' })) },
    fleetRepo: { findUnique: jest.fn(async () => ({ owner: 'acme', name: 'app' })) },
    runner: { findUnique: jest.fn(async () => ({ name: 'wk-mac' })) },
    budgetPolicy: { findUnique: jest.fn(async () => ({ scopeType: 'runner', scopeId: 'rn1' })) },
  };
  const labels = new BudgetScopeLabels({ client: db } as never);
  afterEach(() => jest.clearAllMocks());

  it.each([
    [{ scopeType: 'global', scopeId: null }, 'global'],
    [{ scopeType: 'project', scopeId: 'p1' }, 'project KODA'],
    [{ scopeType: 'repo', scopeId: 'r1' }, 'acme/app'],
    [{ scopeType: 'runner', scopeId: 'rn1' }, 'runner wk-mac'],
  ] as const)('labels %j as %s', async (scope, expected) => {
    expect(await labels.forScope(scope)).toBe(expected);
  });

  it('labels a scope whose row is gone by type and id', async () => {
    db.fleetRepo.findUnique.mockResolvedValueOnce(null);
    expect(await labels.forScope({ scopeType: 'repo', scopeId: 'r9' })).toBe('repo r9');
  });

  it('labels a policy by its scope; null when the policy is gone', async () => {
    expect(await labels.forPolicy('pol1')).toBe('runner wk-mac');
    db.budgetPolicy.findUnique.mockResolvedValueOnce(null);
    expect(await labels.forPolicy('gone')).toBeNull();
  });
});
```

Create `apps/api/src/fleet/budgets/budget-incident.recorder.spec.ts`:

```ts
import { BudgetIncidentRecorder } from './budget-incident.recorder';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol1', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 50, hardStop: true, runningJobs: 'finish', pausedAt: null, pausedWindowStart: null,
  createdById: 'u1', updatedById: 'u1', createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('BudgetIncidentRecorder (S4a §2.4, D508)', () => {
  const labels = { forScope: jest.fn(async () => 'project KODA') };
  const outbox = { record: jest.fn(async () => undefined) };
  const recorder = new BudgetIncidentRecorder(labels as never, outbox as never);
  const start = new Date('2026-10-01T00:00:00.000Z');
  afterEach(() => jest.clearAllMocks());

  it('enqueues the incident keyed by its dedupe columns', async () => {
    await recorder.record(policy(), 'warn', start, '6.0000');
    expect(outbox.record).toHaveBeenCalledWith({
      type: 'fleet_budget_incident',
      payload: { incidentId: 'pol1:warn:2026-10-01T00:00:00.000Z:10', kind: 'warn', scope: 'project KODA', spentUsd: '6.0000', amountUsd: '10' },
      metadata: { projectId: 'p1', eventId: 'pol1:warn:2026-10-01T00:00:00.000Z:10' },
    });
  });

  it('a global policy enqueues without a project', async () => {
    labels.forScope.mockResolvedValueOnce('global');
    await recorder.record(policy({ scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null }), 'hard_stop', start, '12.0000');
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ kind: 'hard_stop', scope: 'global' }),
      metadata: { projectId: null, eventId: 'pol1:hard_stop:2026-10-01T00:00:00.000Z:10' },
    }));
  });
});
```

In `apps/api/src/fleet/budgets/budget-evaluator.spec.ts:10`, add a tenth constructor argument:

```ts
    evaluator = new BudgetEvaluator({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-scope-labels.spec.ts src/fleet/budgets/budget-incident.recorder.spec.ts`
Expected: FAIL — "Cannot find module './budget-scope-labels'" and "./budget-incident.recorder".

- [ ] **Step 3: Implement the labels and the recorder**

Create `apps/api/src/fleet/budgets/budget-scope-labels.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { budgetScopeLabel } from '../../notifications/fleet/fleet-notification-events';
import type { BudgetScope, BudgetScopeType } from './domain/budget.domain';

/** Fleet S4a §2.4: a human label for a budget scope (project key, owner/name, runner name). */
@Injectable()
export class BudgetScopeLabels {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async forScope(scope: BudgetScope): Promise<string> {
    return budgetScopeLabel(scope.scopeType, scope.scopeId, await this.nameOf(scope));
  }

  async forPolicy(policyId: string): Promise<string | null> {
    const p = await this.db.budgetPolicy.findUnique({ where: { id: policyId }, select: { scopeType: true, scopeId: true } });
    return p ? this.forScope({ scopeType: p.scopeType as BudgetScopeType, scopeId: p.scopeId }) : null;
  }

  private async nameOf(scope: BudgetScope): Promise<string | null> {
    const id = scope.scopeId ?? '';
    switch (scope.scopeType) {
      case 'global': return null;
      case 'project': return (await this.db.project.findUnique({ where: { id }, select: { key: true } }))?.key ?? null;
      case 'repo': {
        const r = await this.db.fleetRepo.findUnique({ where: { id }, select: { owner: true, name: true } });
        return r ? `${r.owner}/${r.name}` : null;
      }
      case 'runner': return (await this.db.runner.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    }
  }
}
```

Create `apps/api/src/fleet/budgets/budget-incident.recorder.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { OutboxService } from '@nathapp/nestjs-outbox';
import {
  budgetIncidentId, BudgetIncidentNotifyKind, FLEET_BUDGET_INCIDENT, FleetBudgetIncidentPayload,
} from '../../notifications/fleet/fleet-notification-events';
import { BudgetScopeLabels } from './budget-scope-labels';
import type { BudgetPolicyRecord } from './domain/budget.domain';

/**
 * Fleet S4a §2.4 (D508): the enqueue side of `fleet_budget_incident`. Called by BudgetEvaluator right after
 * insertIncident inserted a warn or hard_stop row, inside evaluate's transaction under the policy lock.
 * A global policy has no project (D512).
 */
@Injectable()
export class BudgetIncidentRecorder {
  constructor(
    private readonly labels: BudgetScopeLabels,
    private readonly outbox: OutboxService,
  ) {}

  async record(policy: BudgetPolicyRecord, kind: BudgetIncidentNotifyKind, windowStart: Date, spentUsd: string): Promise<void> {
    const incidentId = budgetIncidentId(policy.id, kind, windowStart, policy.amountUsd);
    const payload: FleetBudgetIncidentPayload = {
      incidentId, kind, scope: await this.labels.forScope(policy), spentUsd, amountUsd: policy.amountUsd,
    };
    await this.outbox.record({ type: FLEET_BUDGET_INCIDENT, payload, metadata: { projectId: policy.projectId, eventId: incidentId } });
  }
}
```

- [ ] **Step 4: Wire into the evaluator and the modules**

In `apps/api/src/fleet/budgets/budget-evaluator.ts`, add `import { BudgetIncidentRecorder } from './budget-incident.recorder';`,
add a tenth constructor parameter after `private readonly approvalLive: ApprovalLivePublisher,`:

```ts
    private readonly incidents: BudgetIncidentRecorder,
```

In `warn`, after `if (!inserted) return false;` add:

```ts
    await this.incidents.record(policy, 'warn', start, spent); // S4a §2.4: same transaction, under the policy lock
```

In `hardStop`, right after the `const inserted = await this.repo.insertIncident({ ... });` statement add:

```ts
    if (inserted) await this.incidents.record(policy, 'hard_stop', start, spent); // S4a §2.4: before the cancel set
```

In `apps/api/src/fleet/budgets/budget-store.module.ts`, import `BudgetScopeLabels` and add it to `providers` and
`exports`. In `apps/api/src/fleet/budgets/budgets.module.ts`, import `BudgetIncidentRecorder` and add it to `providers`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/budgets && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/budgets
git commit -m "feat(fleet): enqueue fleet_budget_incident inside the evaluator transaction (S4a §2.4, D508)"
```

---

### Task D5: Fleet notification drafts, reader and the job, approval and budget subscribers

**Files:**
- Create: `apps/api/src/notifications/fleet/fleet-notification-drafts.ts`
- Test: `apps/api/src/notifications/fleet/fleet-notification-drafts.spec.ts`
- Create: `apps/api/src/notifications/fleet/fleet-notification.reader.ts`
- Create: `apps/api/src/notifications/fleet/fleet-job-outcome.subscriber.ts`
- Create: `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts`
- Create: `apps/api/src/notifications/fleet/fleet-budget-incident.subscriber.ts`
- Test: `apps/api/src/notifications/fleet/fleet-subscribers.spec.ts`

**Interfaces:**
- Consumes: `NotificationDraft`, `truncate`, `TITLE_MAX` (Part A `notification.types.ts`); `NotificationWriter.deliver(drafts): Promise<number>`; `NotificationEligibility.findGlobalAdminIds(): Promise<readonly string[]>` (Part A); `FanOutPublisher.register` (`outbox/fan-out-publisher.ts`); D1 parsers and types; `BudgetScopeLabels.forPolicy` (D4).
- Produces:
  - `jobOutcomeDraft(p: FleetJobOutcomePayload, slug: string): NotificationDraft`
  - `approvalDrafts(adminIds: readonly string[], a: { approvalId: string; projectId: string | null; kindLabel: string; repo: string }): NotificationDraft[]`
  - `budgetDrafts(adminIds: readonly string[], p: FleetBudgetIncidentPayload): NotificationDraft[]`
  - `healthDrafts(adminIds: readonly string[], p: FleetHealthAlertPayload): NotificationDraft[]`
  - `FleetNotificationReader`: `projectSlug(projectId: string): Promise<string | null>`; `approvalContext(approvalId: string): Promise<{ status: string; repo: string | null } | null>`
  - Subscribers `FleetJobOutcomeSubscriber`, `FleetApprovalRequestedSubscriber`, `FleetBudgetIncidentSubscriber`, each with `onModuleInit()` and a public arrow `handle(payload: unknown): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/notifications/fleet/fleet-notification-drafts.spec.ts`:

```ts
import { approvalDrafts, budgetDrafts, healthDrafts, jobOutcomeDraft } from './fleet-notification-drafts';

describe('fleet notification drafts (S4a contract: kinds, links, params)', () => {
  const outcome = { jobId: 'j1', leaseEpoch: 2, projectId: 'p1', requestedById: 'u1', outcome: 'escalated' as const, repo: 'acme/app', feature: 'add', resultPrUrl: null };

  it('job escalation -> requester, FLEET_NEEDS_YOU, job page, keyed per attempt', () => {
    expect(jobOutcomeDraft(outcome, 'web')).toEqual({
      userId: 'u1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'job_escalated',
      title: 'Fleet job on acme/app escalated', body: null, link: '/web/fleet/jobs/j1',
      params: { repo: 'acme/app', feature: 'add', state: 'escalated' }, sourceType: 'fleet_job', sourceId: 'j1:2', actorId: null,
    });
  });

  it('job with a PR -> job_pr_opened with the PR url', () => {
    const d = jobOutcomeDraft({ ...outcome, outcome: 'pr_opened', resultPrUrl: 'https://github.com/acme/app/pull/7' }, 'web');
    expect(d).toMatchObject({ kind: 'job_pr_opened', title: 'Fleet job on acme/app opened a PR', params: { repo: 'acme/app', feature: 'add', prUrl: 'https://github.com/acme/app/pull/7' } });
  });

  it('truncates a title built from a very long repo name', () => {
    const d = jobOutcomeDraft({ ...outcome, repo: `acme/${'x'.repeat(400)}` }, 'web');
    expect(d.title.length).toBeLessThanOrEqual(200);
    expect(d.title.endsWith('…')).toBe(true);
  });

  it('approval ask -> one draft per admin', () => {
    const ds = approvalDrafts(['a1', 'a2'], { approvalId: 'ap1', projectId: 'p1', kindLabel: 'bash', repo: 'acme/app' });
    expect(ds.map((d) => d.userId)).toEqual(['a1', 'a2']);
    expect(ds[0]).toEqual({
      userId: 'a1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'approval_requested', title: 'Approval needed: bash on acme/app',
      body: null, link: '/admin/fleet/approvals', params: { repo: 'acme/app', kind: 'bash' }, sourceType: 'fleet_approval', sourceId: 'ap1', actorId: null,
    });
  });

  it('budget incidents -> FLEET_HEALTH for admins, money shown with 2 decimals', () => {
    const [d] = budgetDrafts(['a1'], { incidentId: 'i1', kind: 'hard_stop', scope: 'project KODA', spentUsd: '12.3456', amountUsd: '10' });
    expect(d).toEqual({
      userId: 'a1', projectId: null, category: 'FLEET_HEALTH', kind: 'budget_hard_stop', title: 'Budget project KODA: $12.35 of $10.00',
      body: null, link: '/admin/fleet/budgets', params: { scope: 'project KODA', spentUsd: '12.35', amountUsd: '10.00' },
      sourceType: 'fleet_budget_incident', sourceId: 'i1', actorId: null,
    });
    expect(budgetDrafts(['a1'], { incidentId: 'i2', kind: 'warn', scope: 'global', spentUsd: '5', amountUsd: '10' })[0].kind).toBe('budget_warn');
  });

  it('health alerts -> runner_offline and credential_expiring', () => {
    const [off] = healthDrafts(['a1'], { alertId: 'al1', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null });
    expect(off).toMatchObject({ kind: 'runner_offline', category: 'FLEET_HEALTH', title: 'Runner wk-mac is offline', link: '/admin/fleet/runners', params: { runner: 'wk-mac' }, sourceType: 'fleet_health_alert', sourceId: 'al1', projectId: null });
    const [cred] = healthDrafts(['a1'], { alertId: 'al2', kind: 'credential_expiring', runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11T08:00:00.000Z' });
    expect(cred).toMatchObject({
      kind: 'credential_expiring', title: 'openai-codex credential on wk-mac expires 2026-10-11', link: '/admin/fleet/credentials',
      params: { runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11' },
    });
  });

  it('no admins -> no drafts', () => {
    expect(budgetDrafts([], { incidentId: 'i', kind: 'warn', scope: 'global', spentUsd: '1', amountUsd: '2' })).toEqual([]);
  });
});
```

Create `apps/api/src/notifications/fleet/fleet-subscribers.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { FanOutPublisher, OutboxFanOutError } from '../../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../../test/helpers/outbox-record';
import { FleetApprovalRequestedSubscriber } from './fleet-approval-requested.subscriber';
import { FleetBudgetIncidentSubscriber } from './fleet-budget-incident.subscriber';
import { FleetJobOutcomeSubscriber } from './fleet-job-outcome.subscriber';

describe('fleet notification subscribers (S4a §2.4)', () => {
  let registry: FanOutPublisher;
  const writer = { deliver: jest.fn(async () => 1) };
  const eligibility = { findGlobalAdminIds: jest.fn(async () => ['a1', 'a2']) };
  const reader = {
    projectSlug: jest.fn(async () => 'web'),
    approvalContext: jest.fn(async () => ({ status: 'pending', repo: 'acme/app' })),
  };
  const labels = { forPolicy: jest.fn(async () => 'project KODA') };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    registry = new FanOutPublisher(noopLastErrors);
    new FleetJobOutcomeSubscriber(registry, reader as never, writer as never).onModuleInit();
    new FleetApprovalRequestedSubscriber(registry, reader as never, eligibility as never, labels as never, writer as never).onModuleInit();
    new FleetBudgetIncidentSubscriber(registry, eligibility as never, writer as never).onModuleInit();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllMocks();
    warn.mockRestore();
  });

  const outcome = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', requestedById: 'u1', outcome: 'failed', repo: 'acme/app', feature: 'f', resultPrUrl: null };

  it('job outcome -> one draft for the requester', async () => {
    await registry.publish(outboxRecord('fleet_job_outcome', outcome));
    expect(writer.deliver).toHaveBeenCalledWith([expect.objectContaining({ userId: 'u1', kind: 'job_failed', link: '/web/fleet/jobs/j1', sourceId: 'j1:1' })]);
  });

  it('job outcome of a deleted project -> nothing, no retry', async () => {
    reader.projectSlug.mockResolvedValueOnce(null);
    await expect(registry.publish(outboxRecord('fleet_job_outcome', outcome))).resolves.toBeUndefined();
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('a malformed payload is logged and skipped, never retried', async () => {
    await expect(registry.publish(outboxRecord('fleet_job_outcome', { jobId: 'j1' }))).resolves.toBeUndefined();
    await expect(registry.publish(outboxRecord('fleet_budget_incident', 'garbage'))).resolves.toBeUndefined();
    expect(writer.deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a database failure throws so the outbox retries', async () => {
    writer.deliver.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(registry.publish(outboxRecord('fleet_job_outcome', outcome))).rejects.toBeInstanceOf(OutboxFanOutError);
  });

  const ask = { approvalId: 'ap1', type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', policyId: null, path: '/web/fleet/approvals?id=ap1' };

  it('bash approval ask -> every global admin, labelled with the repo', async () => {
    await registry.publish(outboxRecord('fleet_approval_requested', ask));
    expect(writer.deliver).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'a1', kind: 'approval_requested', title: 'Approval needed: bash on acme/app', sourceId: 'ap1' }),
      expect.objectContaining({ userId: 'a2' }),
    ]);
  });

  it('budget override ask -> labelled with the policy scope', async () => {
    reader.approvalContext.mockResolvedValueOnce({ status: 'pending', repo: null });
    await registry.publish(outboxRecord('fleet_approval_requested', { ...ask, type: 'budget_override_required', jobId: null, policyId: 'pol1' }));
    expect(labels.forPolicy).toHaveBeenCalledWith('pol1');
    expect(writer.deliver).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ title: 'Approval needed: budget override on project KODA' })]));
  });

  it('an ask answered or expired before the handler ran -> no notification (D514, #236 backlog)', async () => {
    reader.approvalContext.mockResolvedValueOnce({ status: 'approved', repo: 'acme/app' });
    await registry.publish(outboxRecord('fleet_approval_requested', ask));
    reader.approvalContext.mockResolvedValueOnce(null);
    await registry.publish(outboxRecord('fleet_approval_requested', ask));
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('budget incident -> every global admin', async () => {
    await registry.publish(outboxRecord('fleet_budget_incident', { incidentId: 'i1', kind: 'warn', scope: 'global', spentUsd: '5', amountUsd: '10' }));
    expect(writer.deliver).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'a1', kind: 'budget_warn' }), expect.objectContaining({ userId: 'a2', kind: 'budget_warn' }),
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/notifications/fleet/fleet-notification-drafts.spec.ts src/notifications/fleet/fleet-subscribers.spec.ts`
Expected: FAIL — "Cannot find module './fleet-notification-drafts'" (and the subscriber modules).

- [ ] **Step 3: Implement the drafts**

Create `apps/api/src/notifications/fleet/fleet-notification-drafts.ts`:

```ts
import { NotificationDraft, TITLE_MAX, truncate } from '../notification.types';
import type {
  FleetBudgetIncidentPayload, FleetHealthAlertPayload, FleetJobOutcomePayload,
} from './fleet-notification-events';

/** Fleet S4a contract "Kinds, links and params": pure builders, English fallback titles (D510: no command text). */

const usd = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : v;
};

const fleetDraft = (d: Omit<NotificationDraft, 'title' | 'body' | 'actorId'> & { title: string }): NotificationDraft => ({
  ...d, title: truncate(d.title, TITLE_MAX), body: null, actorId: null,
});

export function jobOutcomeDraft(p: FleetJobOutcomePayload, slug: string): NotificationDraft {
  const pr = p.outcome === 'pr_opened';
  return fleetDraft({
    userId: p.requestedById, projectId: p.projectId, category: 'FLEET_NEEDS_YOU', kind: `job_${p.outcome}`,
    title: pr ? `Fleet job on ${p.repo} opened a PR` : `Fleet job on ${p.repo} ${p.outcome}`,
    link: `/${slug}/fleet/jobs/${p.jobId}`,
    params: pr ? { repo: p.repo, feature: p.feature, prUrl: p.resultPrUrl ?? '' } : { repo: p.repo, feature: p.feature, state: p.outcome },
    sourceType: 'fleet_job', sourceId: `${p.jobId}:${p.leaseEpoch}`,
  });
}

export function approvalDrafts(
  adminIds: readonly string[],
  a: { approvalId: string; projectId: string | null; kindLabel: string; repo: string },
): NotificationDraft[] {
  return adminIds.map((userId) => fleetDraft({
    userId, projectId: a.projectId, category: 'FLEET_NEEDS_YOU', kind: 'approval_requested',
    title: `Approval needed: ${a.kindLabel} on ${a.repo}`, link: '/admin/fleet/approvals',
    params: { repo: a.repo, kind: a.kindLabel }, sourceType: 'fleet_approval', sourceId: a.approvalId,
  }));
}

export function budgetDrafts(adminIds: readonly string[], p: FleetBudgetIncidentPayload): NotificationDraft[] {
  const spentUsd = usd(p.spentUsd);
  const amountUsd = usd(p.amountUsd);
  return adminIds.map((userId) => fleetDraft({
    userId, projectId: null, category: 'FLEET_HEALTH', kind: `budget_${p.kind}`,
    title: `Budget ${p.scope}: $${spentUsd} of $${amountUsd}`, link: '/admin/fleet/budgets',
    params: { scope: p.scope, spentUsd, amountUsd }, sourceType: 'fleet_budget_incident', sourceId: p.incidentId,
  }));
}

export function healthDrafts(adminIds: readonly string[], p: FleetHealthAlertPayload): NotificationDraft[] {
  const offline = p.kind === 'runner_offline';
  const provider = p.provider ?? '';
  const expiresAt = (p.expiresAt ?? '').slice(0, 10);
  return adminIds.map((userId) => fleetDraft({
    userId, projectId: null, category: 'FLEET_HEALTH', kind: p.kind,
    title: offline ? `Runner ${p.runner} is offline` : `${provider} credential on ${p.runner} expires ${expiresAt}`,
    link: offline ? '/admin/fleet/runners' : '/admin/fleet/credentials',
    params: offline ? { runner: p.runner } : { runner: p.runner, provider, expiresAt },
    sourceType: 'fleet_health_alert', sourceId: p.alertId,
  }));
}
```

- [ ] **Step 4: Implement the reader and the three subscribers**

Create `apps/api/src/notifications/fleet/fleet-notification.reader.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';

/** Fleet S4a §2.4: lookups the fleet notification consumers need at delivery time. */
@Injectable()
export class FleetNotificationReader {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async projectSlug(projectId: string): Promise<string | null> {
    const p = await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true, deletedAt: true } });
    return p && !p.deletedAt ? p.slug : null;
  }

  /** The approval's current status and, for a job ask, the job's repo as owner/name. Null when the row is gone. */
  async approvalContext(approvalId: string): Promise<{ status: string; repo: string | null } | null> {
    // FleetApproval.jobId has no Prisma relation (schema), so the repo is a second lookup.
    const a = await this.db.fleetApproval.findUnique({ where: { id: approvalId }, select: { status: true, jobId: true } });
    if (!a) return null;
    const job = a.jobId
      ? await this.db.fleetJob.findUnique({ where: { id: a.jobId }, select: { repo: { select: { owner: true, name: true } } } })
      : null;
    return { status: a.status, repo: job?.repo ? `${job.repo.owner}/${job.repo.name}` : null };
  }
}
```

Create `apps/api/src/notifications/fleet/fleet-job-outcome.subscriber.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationWriter } from '../notification-writer';
import { jobOutcomeDraft } from './fleet-notification-drafts';
import { FLEET_JOB_OUTCOME, parseJobOutcomePayload } from './fleet-notification-events';
import { FleetNotificationReader } from './fleet-notification.reader';

/** Fleet S4a §2.4: fleet_job_outcome -> the requester (FLEET_NEEDS_YOU). Throws only on database failure. */
@Injectable()
export class FleetJobOutcomeSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetJobOutcomeSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reader: FleetNotificationReader,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_JOB_OUTCOME, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseJobOutcomePayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_JOB_OUTCOME}: malformed payload skipped`);
      return;
    }
    const slug = await this.reader.projectSlug(p.projectId);
    if (!slug) return; // the project is gone: nobody to link to
    await this.writer.deliver([jobOutcomeDraft(p, slug)]);
  };
}
```

Create `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BudgetScopeLabels } from '../../fleet/budgets/budget-scope-labels';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { approvalDrafts } from './fleet-notification-drafts';
import { FLEET_APPROVAL_REQUESTED, parseApprovalRequestedPayload } from './fleet-notification-events';
import { FleetNotificationReader } from './fleet-notification.reader';

const KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  nax_bash_escalate: 'bash',
  budget_override_required: 'budget override',
});

/**
 * Fleet S4a §2.4 (D505, D514): fleet_approval_requested (enqueued since #236) -> every global admin.
 * Registering this handler releases the rows PrismaOutboxStore held back, so an ask that is no longer
 * pending when it is handled creates nothing.
 */
@Injectable()
export class FleetApprovalRequestedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetApprovalRequestedSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reader: FleetNotificationReader,
    private readonly eligibility: NotificationEligibility,
    private readonly labels: BudgetScopeLabels,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_APPROVAL_REQUESTED, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseApprovalRequestedPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_APPROVAL_REQUESTED}: malformed payload skipped`);
      return;
    }
    const ctx = await this.reader.approvalContext(p.approvalId);
    if (!ctx || ctx.status !== 'pending') return;
    const repo = ctx.repo ?? (p.policyId ? await this.labels.forPolicy(p.policyId) : null) ?? 'fleet';
    const adminIds = await this.eligibility.findGlobalAdminIds();
    await this.writer.deliver(approvalDrafts(adminIds, {
      approvalId: p.approvalId, projectId: p.projectId, kindLabel: KIND_LABEL[p.type] ?? p.type, repo,
    }));
  };
}
```

Create `apps/api/src/notifications/fleet/fleet-budget-incident.subscriber.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { budgetDrafts } from './fleet-notification-drafts';
import { FLEET_BUDGET_INCIDENT, parseBudgetIncidentPayload } from './fleet-notification-events';

/** Fleet S4a §2.4 (D508): fleet_budget_incident (warn, hard_stop) -> every global admin (FLEET_HEALTH). */
@Injectable()
export class FleetBudgetIncidentSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetBudgetIncidentSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly eligibility: NotificationEligibility,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_BUDGET_INCIDENT, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseBudgetIncidentPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_BUDGET_INCIDENT}: malformed payload skipped`);
      return;
    }
    await this.writer.deliver(budgetDrafts(await this.eligibility.findGlobalAdminIds(), p));
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/notifications/fleet && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications/fleet
git commit -m "feat(notifications): job outcome, approval and budget fleet notifications (S4a §2.4)"
```

---

### Task D6: Fleet health detector and its subscriber

**Files:**
- Create: `apps/api/src/notifications/fleet/fleet-health-plan.ts`
- Test: `apps/api/src/notifications/fleet/fleet-health-plan.spec.ts`
- Create: `apps/api/src/notifications/fleet/fleet-health.detector.ts`
- Test: `apps/api/src/notifications/fleet/fleet-health.detector.spec.ts`
- Create: `apps/api/src/notifications/fleet/fleet-health-alert.subscriber.ts`
- Test: `apps/api/src/notifications/fleet/fleet-health-alert.subscriber.spec.ts`

**Interfaces:**
- Consumes: `FleetHealthAlertsRepository`, `HealthRunnerRow`, `OpenHealthAlert` (D2); `FLEET_HEALTH_ALERT`, `HealthAlertKind`, `parseHealthAlertPayload` (D1); `healthDrafts` (D5); `isRunnerOnline` (`fleet/common/runner-online.ts`); `isExpiring` (`fleet/dashboard/credential-board.ts`); `readCapabilities` (`fleet/dashboard/dashboard-view.ts`); `FLEET_CFG` (`sweepEnabled`, `runnerOfflineSec`, `credentialExpiryWarnDays`).
- Produces:
  - `planHealthChanges(input: { runners: readonly HealthRunner[]; openAlerts: readonly OpenHealthAlert[]; now: Date; warnDays: number; inBootGrace: boolean }): HealthPlan` with `HealthRunner = { id; name; enabled; online: boolean; capabilities: RunnerCapabilities | null }`, `HealthOpenRequest = { kind: HealthAlertKind; subjectKey: string; runner: string; provider: string | null; expiresAt: string | null }`, `HealthPlan = { open: HealthOpenRequest[]; close: string[] }`.
  - `FleetHealthDetector.detect(now?: Date): Promise<{ opened: number; closed: number }>`.
  - `FleetHealthAlertSubscriber` (registers `fleet_health_alert`).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/notifications/fleet/fleet-health-plan.spec.ts`:

```ts
import type { RunnerCapabilities } from '../../fleet/common/protocol';
import { planHealthChanges } from './fleet-health-plan';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const caps = (credentials: RunnerCapabilities['credentials']): RunnerCapabilities => ({
  nax: { version: '0.83.5', protocols: ['native'] }, sandbox: { available: true, probedAt: NOW.toISOString() }, profiles: {},
  credentials, tools: { git: true, gh: true, glab: true }, executors: ['host'],
} as RunnerCapabilities);
const oauth = (providerId: string, expires: string, available = true) => ({ providerId, available, stored: { kind: 'oauth' as const, expires, expired: false }, ambient: false });
const runner = (over: Partial<{ id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }> = {}) => ({
  id: 'rn1', name: 'wk-mac', enabled: true, online: true, capabilities: caps([]), ...over,
});
const base = { now: NOW, warnDays: 7, inBootGrace: false, openAlerts: [] };

describe('planHealthChanges (S4a §2.4, D507, D515)', () => {
  it('opens an offline alert for an enabled offline runner', () => {
    expect(planHealthChanges({ ...base, runners: [runner({ online: false })] })).toEqual({
      open: [{ kind: 'runner_offline', subjectKey: 'rn1', runner: 'wk-mac', provider: null, expiresAt: null }], close: [],
    });
  });

  it('never alerts for a disabled runner and closes its open alert', () => {
    const plan = planHealthChanges({ ...base, runners: [runner({ online: false, enabled: false })], openAlerts: [{ id: 'al1', kind: 'runner_offline', subjectKey: 'rn1' }] });
    expect(plan).toEqual({ open: [], close: ['al1'] });
  });

  it('does not reopen an alert that is already open, and closes it when the runner is back', () => {
    const open = [{ id: 'al1', kind: 'runner_offline' as const, subjectKey: 'rn1' }];
    expect(planHealthChanges({ ...base, runners: [runner({ online: false })], openAlerts: open })).toEqual({ open: [], close: [] });
    expect(planHealthChanges({ ...base, runners: [runner()], openAlerts: open })).toEqual({ open: [], close: ['al1'] });
  });

  it('boot grace: neither opens nor closes offline alerts (stale lastSeenAt after an API restart)', () => {
    const open = [{ id: 'al1', kind: 'runner_offline' as const, subjectKey: 'rn2' }];
    const plan = planHealthChanges({ ...base, inBootGrace: true, runners: [runner({ online: false }), runner({ id: 'rn2', name: 'b', online: false })], openAlerts: open });
    expect(plan).toEqual({ open: [], close: [] });
  });

  it('opens a credential alert per expiring available OAuth credential, keyed runner:provider', () => {
    const plan = planHealthChanges({ ...base, runners: [runner({ capabilities: caps([oauth('openai-codex', '2026-10-11T00:00:00.000Z'), oauth('anthropic', '2026-12-01T00:00:00.000Z'), oauth('gone', '2026-10-10T00:00:00.000Z', false)]) })] });
    expect(plan.open).toEqual([{ kind: 'credential_expiring', subjectKey: 'rn1:openai-codex', runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11T00:00:00.000Z' }]);
  });

  it('closes a credential alert once refreshed; holds it while capabilities are unreadable', () => {
    const open = [{ id: 'c1', kind: 'credential_expiring' as const, subjectKey: 'rn1:openai-codex' }];
    expect(planHealthChanges({ ...base, runners: [runner({ capabilities: caps([oauth('openai-codex', '2026-12-31T00:00:00.000Z')]) })], openAlerts: open }).close).toEqual(['c1']);
    expect(planHealthChanges({ ...base, runners: [runner({ capabilities: null })], openAlerts: open }).close).toEqual([]);
  });

  it('closes alerts of runners that no longer exist', () => {
    const open = [{ id: 'al9', kind: 'runner_offline' as const, subjectKey: 'deleted' }, { id: 'c9', kind: 'credential_expiring' as const, subjectKey: 'deleted:x' }];
    expect(planHealthChanges({ ...base, runners: [], openAlerts: open }).close).toEqual(['al9', 'c9']);
  });
});
```

Create `apps/api/src/notifications/fleet/fleet-health.detector.spec.ts`:

```ts
import { FleetHealthDetector } from './fleet-health.detector';

const T0 = new Date('2026-10-09T12:00:00.000Z').getTime();
const CFG = { sweepEnabled: false, runnerOfflineSec: 90, credentialExpiryWarnDays: 7 };
const caps = { nax: { version: '0.83.5', protocols: ['native'] }, sandbox: { available: true, probedAt: '2026-10-09T00:00:00.000Z' }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'] };

describe('FleetHealthDetector (S4a §2.4, D507, D515)', () => {
  const repo = {
    findRunners: jest.fn(async () => [{ id: 'rn1', name: 'wk-mac', enabled: true, lastSeenAt: new Date(T0 - 600_000), capabilities: caps }]),
    findOpen: jest.fn(async () => []),
    open: jest.fn(async () => 'al1'),
    close: jest.fn(async () => 0),
  };
  const outbox = { record: jest.fn(async () => undefined) };
  const order: string[] = [];
  const tx = { run: jest.fn(async (fn: () => Promise<unknown>) => { order.push('tx:start'); const r = await fn(); order.push('tx:end'); return r; }) };
  let detector: FleetHealthDetector;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    detector = new FleetHealthDetector(repo as never, outbox as never, tx as never, CFG as never);
    order.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('boot grace: a runner silent since before the API booted is not reported in the first runnerOfflineSec', async () => {
    expect(await detector.detect(new Date(T0 + 30_000))).toEqual({ opened: 0, closed: 0 });
    expect(repo.open).not.toHaveBeenCalled();
    expect(await detector.detect(new Date(T0 + 91_000))).toEqual({ opened: 1, closed: 0 });
  });

  it('opens the alert and enqueues its event in one transaction, without a project', async () => {
    repo.open.mockImplementationOnce(async () => { order.push('open'); return 'al1'; });
    outbox.record.mockImplementationOnce(async () => { order.push('enqueue'); });
    await detector.detect(new Date(T0 + 120_000));
    expect(order).toEqual(['tx:start', 'open', 'enqueue', 'tx:end']);
    expect(outbox.record).toHaveBeenCalledWith({
      type: 'fleet_health_alert',
      payload: { alertId: 'al1', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null },
      metadata: { eventId: 'al1' },
    });
  });

  it('enqueues nothing when another detect already opened the episode', async () => {
    repo.open.mockResolvedValueOnce(null);
    expect(await detector.detect(new Date(T0 + 120_000))).toEqual({ opened: 0, closed: 0 });
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('closes alerts of a runner that came back', async () => {
    repo.findRunners.mockResolvedValueOnce([{ id: 'rn1', name: 'wk-mac', enabled: true, lastSeenAt: new Date(T0 + 119_000), capabilities: caps }]);
    repo.findOpen.mockResolvedValueOnce([{ id: 'al1', kind: 'runner_offline', subjectKey: 'rn1' }]);
    repo.close.mockResolvedValueOnce(1);
    expect(await detector.detect(new Date(T0 + 120_000))).toEqual({ opened: 0, closed: 1 });
    expect(repo.close).toHaveBeenCalledWith(['al1'], new Date(T0 + 120_000));
  });

  it('does not start a timer when the sweep is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    detector.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

Create `apps/api/src/notifications/fleet/fleet-health-alert.subscriber.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../../test/helpers/outbox-record';
import { FleetHealthAlertSubscriber } from './fleet-health-alert.subscriber';

describe('FleetHealthAlertSubscriber (S4a §2.4)', () => {
  const writer = { deliver: jest.fn(async () => 1) };
  const eligibility = { findGlobalAdminIds: jest.fn(async () => ['a1']) };
  let registry: FanOutPublisher;

  beforeEach(() => {
    registry = new FanOutPublisher(noopLastErrors);
    new FleetHealthAlertSubscriber(registry, eligibility as never, writer as never).onModuleInit();
  });
  afterEach(() => jest.clearAllMocks());

  it('delivers the alert to every global admin', async () => {
    await registry.publish(outboxRecord('fleet_health_alert', { alertId: 'al1', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null }));
    expect(writer.deliver).toHaveBeenCalledWith([expect.objectContaining({ userId: 'a1', kind: 'runner_offline', sourceId: 'al1', projectId: null })]);
  });

  it('skips a malformed payload without retrying', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(registry.publish(outboxRecord('fleet_health_alert', { alertId: 'al1', kind: 'nope' }))).resolves.toBeUndefined();
    expect(writer.deliver).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/notifications/fleet/fleet-health-plan.spec.ts src/notifications/fleet/fleet-health.detector.spec.ts src/notifications/fleet/fleet-health-alert.subscriber.spec.ts`
Expected: FAIL — "Cannot find module './fleet-health-plan'" (and the detector and subscriber).

- [ ] **Step 3: Implement the planner**

Create `apps/api/src/notifications/fleet/fleet-health-plan.ts`:

```ts
import type { RunnerCapabilities } from '../../fleet/common/protocol';
import { isExpiring } from '../../fleet/dashboard/credential-board';
import type { OpenHealthAlert } from './fleet-health-alerts.repository';
import type { HealthAlertKind } from './fleet-notification-events';

export interface HealthRunner { id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }
export interface HealthOpenRequest { kind: HealthAlertKind; subjectKey: string; runner: string; provider: string | null; expiresAt: string | null }
export interface HealthPlan { open: HealthOpenRequest[]; close: string[] }

const keyOf = (kind: HealthAlertKind, subjectKey: string): string => `${kind}|${subjectKey}`;

/**
 * Fleet S4a §2.4 (D507, D515): which health episodes to open and which open ones to close. Pure.
 * An open alert is closed when its condition no longer holds, unless the evidence is missing: offline checks
 * during the boot grace, and credential checks of a runner whose capabilities are unreadable, are "held".
 */
export function planHealthChanges(input: {
  runners: readonly HealthRunner[]; openAlerts: readonly OpenHealthAlert[]; now: Date; warnDays: number; inBootGrace: boolean;
}): HealthPlan {
  const wanted = new Map<string, HealthOpenRequest>();
  const held = new Set<string>();
  for (const r of input.runners.filter((x) => x.enabled)) {
    if (!r.online) {
      if (input.inBootGrace) held.add(keyOf('runner_offline', r.id));
      else wanted.set(keyOf('runner_offline', r.id), { kind: 'runner_offline', subjectKey: r.id, runner: r.name, provider: null, expiresAt: null });
    }
    if (r.capabilities === null) {
      input.openAlerts
        .filter((a) => a.kind === 'credential_expiring' && a.subjectKey.startsWith(`${r.id}:`))
        .forEach((a) => held.add(keyOf(a.kind, a.subjectKey)));
      continue;
    }
    for (const cred of r.capabilities.credentials.filter((c) => c.available && isExpiring(c, input.now, input.warnDays))) {
      const subjectKey = `${r.id}:${cred.providerId}`;
      wanted.set(keyOf('credential_expiring', subjectKey), {
        kind: 'credential_expiring', subjectKey, runner: r.name, provider: cred.providerId, expiresAt: cred.stored?.expires ?? null,
      });
    }
  }
  const openKeys = new Set(input.openAlerts.map((a) => keyOf(a.kind, a.subjectKey)));
  return {
    open: [...wanted.entries()].filter(([key]) => !openKeys.has(key)).map(([, req]) => req),
    close: input.openAlerts.filter((a) => !wanted.has(keyOf(a.kind, a.subjectKey)) && !held.has(keyOf(a.kind, a.subjectKey))).map((a) => a.id),
  };
}
```

- [ ] **Step 4: Implement the detector and the subscriber**

Create `apps/api/src/notifications/fleet/fleet-health.detector.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { isRunnerOnline } from '../../fleet/common/runner-online';
import { readCapabilities } from '../../fleet/dashboard/dashboard-view';
import { FleetHealthAlertsRepository } from './fleet-health-alerts.repository';
import { planHealthChanges } from './fleet-health-plan';
import { FLEET_HEALTH_ALERT, FleetHealthAlertPayload } from './fleet-notification-events';

const DETECT_INTERVAL_MS = 60_000;
type HealthConfig = Pick<IFleetConfig, 'sweepEnabled' | 'runnerOfflineSec' | 'credentialExpiryWarnDays'>;

/**
 * Fleet S4a §2.4 (D507, D515): opens and closes runner-offline and credential-expiring episodes every 60 s,
 * in process (single API instance), like FleetSweeper. Each opened episode and its fleet_health_alert event
 * commit in one transaction. For the first runnerOfflineSec after boot, offline checks are skipped: every
 * runner's lastSeenAt is stale after an API restart until it syncs again.
 */
@Injectable()
export class FleetHealthDetector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetHealthDetector.name);
  private readonly bootedAtMs = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: FleetHealthAlertsRepository,
    private readonly outbox: OutboxService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly cfg: HealthConfig,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.detect().catch((error: unknown) => this.logger.error(`Fleet health detect failed: ${error instanceof Error ? error.message : String(error)}`));
    }, DETECT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async detect(now = new Date()): Promise<{ opened: number; closed: number }> {
    const [rows, openAlerts] = await Promise.all([this.repo.findRunners(), this.repo.findOpen()]);
    const plan = planHealthChanges({
      runners: rows.map((r) => ({
        id: r.id, name: r.name, enabled: r.enabled,
        online: isRunnerOnline(r.lastSeenAt, now, this.cfg.runnerOfflineSec),
        capabilities: readCapabilities(r.capabilities),
      })),
      openAlerts,
      now,
      warnDays: this.cfg.credentialExpiryWarnDays,
      inBootGrace: now.getTime() < this.bootedAtMs + this.cfg.runnerOfflineSec * 1000,
    });
    let opened = 0;
    for (const req of plan.open) {
      const done = await this.txManager.run(async () => {
        const alertId = await this.repo.open(req.kind, req.subjectKey, now);
        if (!alertId) return false;
        const payload: FleetHealthAlertPayload = { alertId, kind: req.kind, runner: req.runner, provider: req.provider, expiresAt: req.expiresAt };
        await this.outbox.record({ type: FLEET_HEALTH_ALERT, payload, metadata: { eventId: alertId } });
        return true;
      });
      if (done) opened += 1;
    }
    const closed = plan.close.length > 0 ? await this.repo.close(plan.close, now) : 0;
    return { opened, closed };
  }
}
```

Create `apps/api/src/notifications/fleet/fleet-health-alert.subscriber.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { healthDrafts } from './fleet-notification-drafts';
import { FLEET_HEALTH_ALERT, parseHealthAlertPayload } from './fleet-notification-events';

/** Fleet S4a §2.4 (D507): fleet_health_alert -> every global admin (FLEET_HEALTH), once per opened episode. */
@Injectable()
export class FleetHealthAlertSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetHealthAlertSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly eligibility: NotificationEligibility,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_HEALTH_ALERT, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseHealthAlertPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_HEALTH_ALERT}: malformed payload skipped`);
      return;
    }
    await this.writer.deliver(healthDrafts(await this.eligibility.findGlobalAdminIds(), p));
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/notifications/fleet && bun run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications/fleet
git commit -m "feat(notifications): fleet health detector and alert notifications (S4a §2.4, D507)"
```

---

### Task D7: Module wiring, retention and the PG integration specs

**Files:**
- Modify: `apps/api/src/notifications/notifications.module.ts` (Part A)
- Modify: `apps/api/src/notifications/notification-retention.processor.ts` (Part A)
- Test: `apps/api/src/notifications/notification-retention.processor.spec.ts` (Part A's spec; new case)
- Test: `apps/api/test/integration/notifications/fleet-job-outcome-notifications.integration.spec.ts`
- Test: `apps/api/test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts`
- Test: `apps/api/test/integration/notifications/fleet-health-notifications.integration.spec.ts`

**Interfaces:**
- Consumes: everything from D2-D6; `NotificationsModule` and `NotificationRetentionProcessor` from Part A (Task D0 Step 2 printed their shape); test helpers `bootHttpApp`, `seedFleetHttpWorld`, `insertRunner`, `FLEET_CAPS`, `outboxRecord`, `resetDb`.
- Produces: the Part D providers registered in the running app; closed health alerts purged after 30 days.

- [ ] **Step 1: Write the failing integration specs**

Create `apps/api/test/integration/notifications/fleet-job-outcome-notifications.integration.spec.ts`:

```ts
/**
 * Fleet S4a §2.4 — fleet_job_outcome end to end on PG: enqueue in the transition transaction, no duplicate on
 * redelivery, a new lease notifies again, CANCELLED never notifies.
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-job-outcome-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { JobTransitionsService } from '../../../src/fleet/jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('fleet job outcome notifications (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let tx: ITransactionManager;
  let jobs: IFleetJobRepository;
  let transitions: JobTransitionsService;
  let publisher: FanOutPublisher;
  let runnerId: string;
  let n = 0;

  const uploading = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `out${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'UPLOADING', runnerId, leaseEpoch: 1, ...over,
    },
  });
  const finish = (jobId: string, to: 'ESCALATED' | 'FAILED' | 'CANCELLED') => tx.run(async () => {
    const job = await jobs.lockById(jobId);
    return transitions.apply({ job, to, by: 'runner', now: new Date(), actor: { type: 'RUNNER', id: runnerId } });
  });
  const deliverAll = async (): Promise<void> => {
    for (const row of await prisma.outboxEvent.findMany({ where: { type: 'fleet_job_outcome' }, orderBy: { createdAt: 'asc' } })) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), { id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId } }));
    }
  };
  const devNotes = () => prisma.notification.findMany({ where: { userId: world.ids.dev }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    tx = app.get(TRANSACTION_MANAGER);
    jobs = app.get(FLEET_JOB_REPOSITORY);
    transitions = app.get(JobTransitionsService);
    publisher = app.get(FanOutPublisher);
    runnerId = (await insertRunner(prisma, { createdById: world.ids.root })).id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('enqueues one event per terminal transition, keyed by job and epoch, and none for CANCELLED', async () => {
    const escalated = await uploading();
    const cancelled = await uploading();
    await finish(escalated.id, 'ESCALATED');
    await finish(cancelled.id, 'CANCELLED');
    const rows = await prisma.outboxEvent.findMany({ where: { type: 'fleet_job_outcome' } });
    expect(rows.map((r) => ({ projectId: r.projectId, eventId: r.eventId }))).toEqual([{ projectId: world.projectId, eventId: `${escalated.id}:1` }]);
  });

  it('a rolled-back transition leaves no event', async () => {
    const job = await uploading();
    await expect(tx.run(async () => {
      await transitions.apply({ job: await jobs.lockById(job.id), to: 'FAILED', by: 'runner', now: new Date(), actor: { type: 'RUNNER', id: runnerId } });
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_job_outcome' } })).toBe(0);
  });

  it('redelivery creates no duplicate; a requeued attempt that fails again notifies again', async () => {
    const job = await uploading();
    await finish(job.id, 'FAILED');
    await deliverAll();
    await deliverAll();
    expect((await devNotes()).map((x) => [x.kind, x.sourceId])).toEqual([['job_failed', `${job.id}:1`]]);
    // the next attempt (requeue bumps the epoch; seeded directly here)
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'UPLOADING', leaseEpoch: 2, finishedAt: null } });
    await finish(job.id, 'FAILED');
    await deliverAll();
    const notes = await devNotes();
    expect(notes.map((x) => x.sourceId)).toEqual([`${job.id}:1`, `${job.id}:2`]);
    expect(notes[0]).toMatchObject({ category: 'FLEET_NEEDS_YOU', link: `/web/fleet/jobs/${job.id}`, projectId: world.projectId, readAt: null });
  });

  it('a requester who lost project membership is not notified', async () => {
    const job = await uploading({ requestedById: world.ids.outsider });
    await finish(job.id, 'ESCALATED');
    await deliverAll();
    expect(await prisma.notification.count({ where: { userId: world.ids.outsider } })).toBe(0);
  });
});
```

Create `apps/api/test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts`:

```ts
/**
 * Fleet S4a §2.4 — budget incidents and approval asks on PG: enqueued inside evaluate's transaction (rolled back
 * with it), a global policy enqueues without a project (D512), admins only, stale asks skipped (D514).
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('fleet budget and approval notifications (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let publisher: FanOutPublisher;
  let n = 0;

  const policy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: 50,
      createdById: world.ids.root, updatedById: world.ids.root, ...over,
    },
  });
  const spent = (usd: number) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `bud${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(50), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), costSpentUsd: usd,
    },
  });
  const events = (type: string) => prisma.outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });
  const deliver = async (type: string): Promise<void> => {
    for (const row of await events(type)) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), { id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId } }));
    }
  };
  const notes = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    publisher = app.get(FanOutPublisher);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.notification.deleteMany();
  });

  it('warn: one event per incident, admins notified once, members not', async () => {
    const p = await policy();
    await spent(6);
    await evaluator.evaluate(p.id);
    await evaluator.evaluate(p.id);
    const rows = await events('fleet_budget_incident');
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(world.projectId);
    await deliver('fleet_budget_incident');
    await deliver('fleet_budget_incident');
    expect((await notes(world.ids.root)).map((x) => [x.kind, x.category])).toEqual([['budget_warn', 'FLEET_HEALTH']]);
    expect(await notes(world.ids.dev)).toEqual([]);
  });

  it('a global policy enqueues without a project and still notifies admins', async () => {
    const p = await policy({ scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null });
    await spent(6);
    await evaluator.evaluate(p.id);
    const [row] = await events('fleet_budget_incident');
    expect(row.projectId).toBeNull();
    expect(JSON.parse(row.payload)).toMatchObject({ kind: 'warn', scope: 'global' });
    await deliver('fleet_budget_incident');
    expect((await notes(world.ids.root))[0]).toMatchObject({ kind: 'budget_warn', projectId: null, title: 'Budget global: $6.00 of $10.00' });
  });

  it('hard stop: the incident event rolls back with the evaluate transaction', async () => {
    const p = await policy({ hardStop: true });
    await spent(12);
    jest.spyOn(app.get(FleetJobsService), 'cancelForBudget').mockRejectedValueOnce(new Error('cancel failed'));
    await expect(evaluator.evaluate(p.id)).rejects.toThrow('cancel failed');
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(0);
    expect(await events('fleet_budget_incident')).toHaveLength(0);
    expect(await events('fleet_approval_requested')).toHaveLength(0);
  });

  it('hard stop: the override ask reaches admins while pending; an answered ask notifies nobody', async () => {
    const p = await policy({ hardStop: true });
    await spent(12);
    await evaluator.evaluate(p.id);
    await deliver('fleet_approval_requested');
    const ask = (await notes(world.ids.root)).find((x) => x.kind === 'approval_requested');
    expect(ask).toMatchObject({ category: 'FLEET_NEEDS_YOU', link: '/admin/fleet/approvals', title: 'Approval needed: budget override on project WEB' });
    await prisma.notification.deleteMany();
    await prisma.fleetApproval.updateMany({ data: { status: 'approved', decidedAt: new Date() } });
    await deliver('fleet_approval_requested');
    expect(await notes(world.ids.root)).toEqual([]);
  });
});
```

Create `apps/api/test/integration/notifications/fleet-health-notifications.integration.spec.ts`:

```ts
/**
 * Fleet S4a §2.4 — health episodes on PG: one alert and one notification per episode, closed on recovery,
 * a second outage is a new episode; expiring credentials; closed alerts purged after 30 days.
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-health-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { FleetHealthDetector } from '../../../src/notifications/fleet/fleet-health.detector';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('fleet health notifications (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let detector: FleetHealthDetector;
  let publisher: FanOutPublisher;
  // Past the detector's boot grace (runnerOfflineSec = 90 under test config).
  const later = (ms = 0) => new Date(Date.now() + 120_000 + ms);

  const deliver = async (): Promise<void> => {
    for (const row of await prisma.outboxEvent.findMany({ where: { type: 'fleet_health_alert' }, orderBy: { createdAt: 'asc' } })) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), { id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId } }));
    }
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    detector = app.get(FleetHealthDetector);
    publisher = app.get(FanOutPublisher);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.runner.deleteMany();
    await prisma.fleetHealthAlert.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.notification.deleteMany();
  });

  it('offline -> one episode and one admin notification; back online closes it; a second outage is new', async () => {
    const r = await insertRunner(prisma, { name: 'wk-mac', lastSeenAt: new Date(Date.now() - 3_600_000), createdById: world.ids.root });
    expect(await detector.detect(later())).toEqual({ opened: 1, closed: 0 });
    expect(await detector.detect(later(60_000))).toEqual({ opened: 0, closed: 0 });
    await deliver();
    await deliver();
    expect((await prisma.notification.findMany({ where: { userId: world.ids.root } })).map((x) => x.kind)).toEqual(['runner_offline']);
    expect(await prisma.notification.count({ where: { userId: world.ids.dev } })).toBe(0);

    await prisma.runner.update({ where: { id: r.id }, data: { lastSeenAt: later(60_000) } });
    expect(await detector.detect(later(60_000))).toEqual({ opened: 0, closed: 1 });
    await prisma.runner.update({ where: { id: r.id }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });
    expect(await detector.detect(later(120_000))).toEqual({ opened: 1, closed: 0 });
    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_health_alert', projectId: null } })).toBe(2);
  });

  it('an OAuth credential entering the expiry window opens a credential alert', async () => {
    const expires = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await insertRunner(prisma, {
      name: 'cred-runner', createdById: world.ids.root, lastSeenAt: later(),
      capabilities: { ...FLEET_CAPS, credentials: [{ providerId: 'openai-codex', available: true, stored: { kind: 'oauth', expires, expired: false }, ambient: false }] },
    });
    expect(await detector.detect(later())).toEqual({ opened: 1, closed: 0 });
    await deliver();
    expect((await prisma.notification.findMany({ where: { userId: world.ids.root } }))[0])
      .toMatchObject({ kind: 'credential_expiring', link: '/admin/fleet/credentials' });
  });
});
```

Add a case to Part A's `apps/api/src/notifications/notification-retention.processor.spec.ts` (match the existing
construction in that file; the processor gains a `FleetHealthAlertsRepository` argument):

Part A's `setup(config)` helper builds the processor with two arguments; change it to pass a third
`healthAlerts = { purgeClosed: jest.fn().mockResolvedValue(0) }` and return it, then add:

```ts
  it('purges health alerts closed more than 30 days ago, even with notification retention off (S4a §1)', async () => {
    const { processor, healthAlerts } = setup({ retentionDays: null });
    await processor.purge(new Date('2026-10-09T04:30:00.000Z'));
    expect(healthAlerts.purgeClosed).toHaveBeenCalledWith(new Date('2026-09-09T04:30:00.000Z'));
  });

  it('a failed notification purge does not skip the health-alert purge', async () => {
    const { processor, repo, healthAlerts } = setup({ retentionDays: 90 });
    repo.purgeRead.mockRejectedValueOnce(new Error('db down'));
    await processor.purge(new Date('2026-10-09T04:30:00.000Z'));
    expect(healthAlerts.purgeClosed).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped test/integration/notifications/fleet-job-outcome-notifications.integration.spec.ts test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts test/integration/notifications/fleet-health-notifications.integration.spec.ts src/notifications/notification-retention.processor.spec.ts`
Expected: FAIL — `app.get(FleetHealthDetector)` throws "Nest could not find FleetHealthDetector element"; outcome and
budget events are enqueued but no notifications appear (no handlers registered); the retention case fails (no purge call).

- [ ] **Step 3: Register the providers and extend retention**

In `apps/api/src/notifications/notifications.module.ts`, add the imports

```ts
import { BudgetStoreModule } from '../fleet/budgets/budget-store.module';
import { FleetApprovalRequestedSubscriber } from './fleet/fleet-approval-requested.subscriber';
import { FleetBudgetIncidentSubscriber } from './fleet/fleet-budget-incident.subscriber';
import { FleetHealthAlertSubscriber } from './fleet/fleet-health-alert.subscriber';
import { FleetHealthAlertsRepository } from './fleet/fleet-health-alerts.repository';
import { FleetHealthDetector } from './fleet/fleet-health.detector';
import { FleetJobOutcomeSubscriber } from './fleet/fleet-job-outcome.subscriber';
import { FleetNotificationReader } from './fleet/fleet-notification.reader';
```

append `BudgetStoreModule` to the module's `imports` array, and append to its `providers` array:

```ts
    // Fleet S4a §2.4 (Part D)
    FleetNotificationReader,
    FleetHealthAlertsRepository,
    FleetJobOutcomeSubscriber,
    FleetApprovalRequestedSubscriber,
    FleetBudgetIncidentSubscriber,
    FleetHealthDetector,
    FleetHealthAlertSubscriber,
```

`BudgetStoreModule` imports only `PrismaModule`, so this adds no module cycle (`NotificationsModule` is imported by no
fleet module; fleet code reaches notifications only through the outbox).

In `apps/api/src/notifications/notification-retention.processor.ts`, add

```ts
import { FleetHealthAlertsRepository } from './fleet/fleet-health-alerts.repository';

const HEALTH_ALERT_RETENTION_MS = 30 * 86_400_000;
```

add a constructor parameter (last):

```ts
    private readonly healthAlerts: FleetHealthAlertsRepository,
```

make `purge(now)` run both steps:

```ts
  async purge(now: Date): Promise<void> {
    await this.purgeReadNotifications(now);
    await this.purgeClosedHealthAlerts(now);
  }

  /** S4a §1: closed health episodes are kept 30 days, open ones forever. */
  private async purgeClosedHealthAlerts(now: Date): Promise<void> {
    try {
      const deleted = await this.healthAlerts.purgeClosed(new Date(now.getTime() - HEALTH_ALERT_RETENTION_MS));
      this.logger.log(`Purged ${deleted} closed fleet health alert(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Fleet health alert purge failed, will retry next run: ${message}`);
    }
  }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/notifications src/notifications test/integration/outbox && bun run type-check`
Expected: PASS; type-check clean. Then the boot smoke: `bun run test:scoped src/app.module.spec.ts` PASS (no DI errors).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications apps/api/test/integration/notifications
git commit -m "feat(notifications): register fleet producers, purge closed health alerts, PG specs (S4a §2.4, §8)"
```

---

### Task D8: Guard the fleet kinds' web copy

**Files:**
- Modify (only if the guard fails): `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`notifications.kinds`)
- Test: `apps/web/tests/i18n/notifications-fleet-kinds-locale-parity.spec.ts`

**Interfaces:**
- Consumes: the kind and params names of the contract table (the web renders `notifications.kinds.<kind>` with the row's `params`, spec §1).
- Produces: a parity spec pinning `notifications.kinds.{job_escalated,job_failed,job_crashed,job_pr_opened,approval_requested,budget_warn,budget_hard_stop,runner_offline,credential_expiring}` (shipped by Part B) to Part D's params.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/i18n/notifications-fleet-kinds-locale-parity.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as Record<string, unknown>
const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

type Tree = Record<string, unknown>
const at = (tree: Tree, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)

// S4a contract: fleet kinds and the params each message may use.
const FLEET_KINDS: Record<string, string[]> = {
  job_escalated: ['repo'], job_failed: ['repo'], job_crashed: ['repo'], job_pr_opened: ['repo'],
  approval_requested: ['kind', 'repo'],
  budget_warn: ['scope', 'spentUsd', 'amountUsd'], budget_hard_stop: ['scope', 'spentUsd', 'amountUsd'],
  runner_offline: ['runner'], credential_expiring: ['provider', 'runner', 'expiresAt'],
}

describe('notifications.kinds fleet strings (S4a Part D)', () => {
  test.each(Object.entries(FLEET_KINDS))('%s exists in en and zh with the same placeholders', (kind, params) => {
    for (const locale of [en, zh]) {
      const message = at(locale, `notifications.kinds.${kind}`)
      expect(typeof message).toBe('string')
      const used = [...(message as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      expect(used).toEqual([...params].sort())
    }
  })
})
```

- [ ] **Step 2: Run it**

Run: `cd apps/web && bun run test -- tests/i18n`
Expected: PASS — Part B (merged before this PR) already ships every fleet kind in `notifications.kinds` for en and
zh. This spec is a guard that pins Part D's kinds and params to the web copy. If it fails, the web copy disagrees
with Part D's `params` names: fix the string in `apps/web/i18n/locales/{en,zh}.json` so its placeholders match
`FLEET_KINDS` (never rename a Part D param to fit the copy), and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/i18n/notifications-fleet-kinds-locale-parity.spec.ts apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json
git commit -m "test(web): pin fleet notification kinds to their web copy (S4a Part D)"
```

---

### Task D9: PR 4 gates, docs and pull request

**Files:** `.nax/mono/apps/api/context.md`, generated agent files.

- [ ] **Step 1: Full gates** (all must pass; fix and amend into the owning task's commit if anything fails)

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run generate && git status --short openapi.json apps/cli/src/generated   # expect no diff: Part D adds no route
cd apps/api && bun run lint && bun run type-check && bun run test && bun run test:db:up && bun run test:scoped \
  test/integration/notifications test/integration/outbox test/integration/fleet/fleet-budget-evaluator.integration.spec.ts \
  test/integration/fleet/fleet-ingest.integration.spec.ts test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts \
  test/integration/fleet/fleet-approval-relay.integration.spec.ts test/integration/fleet/fleet-budget-sweeper.integration.spec.ts
cd ../web && bun run lint && bun run type-check && bun run test
```

Expected: every command exits 0.

- [ ] **Step 2: Docs**

In `.nax/mono/apps/api/context.md`, add under the notifications section Part A wrote:

```markdown
- Fleet producers (S4a Part D) live in `src/notifications/fleet/`. Fleet modules never import the notifications
  module: they enqueue outbox events (`fleet_job_outcome` from `FleetJobOutcomeRecorder` inside
  `JobTransitionsService.apply` and the ingest transaction; `fleet_budget_incident` from `BudgetIncidentRecorder` inside
  `BudgetEvaluator.evaluate`; `fleet_health_alert` from `FleetHealthDetector`). Only the types in
  `src/outbox/global-outbox-types.ts` may omit `metadata.projectId`.
```

Regenerate the agent files:
`nax generate --all-packages`. Commit: `docs: fleet notification producers (S4a Part D)`.

- [ ] **Step 3: Push and open the PR** (only with the user's go-ahead to push)

```bash
git push -u origin feat/fleet-s4a-4-fleet-producers
gh pr create --base main --title "feat(fleet): S4a PR 4 — fleet notification producers" --body "$(cat <<'BODY'
## Summary
Fleet S4a slice 4 (spec `docs/superpowers/specs/2026-10-08-fleet-s4a-notifications-core-design.md` §2.4).

- `fleet_job_outcome`: enqueued inside `JobTransitionsService.apply` for ESCALATED / FAILED / CRASHED / COMPLETED-with-PR, and inside the ingest transaction for a late escalation or PR url; keyed `<jobId>:<leaseEpoch>`; notifies the requester.
- `fleet_approval_requested` (#236) gets its consumer: every global admin, only while the ask is still pending (D514), which also drains the backlog held since #236 without stale noise.
- `fleet_budget_incident`: enqueued inside `BudgetEvaluator.evaluate` for warn / hard_stop incidents; admins.
- `FleetHealthAlert` episodes + `FleetHealthDetector` (60 s, boot grace = runnerOfflineSec): runner offline and expiring OAuth credentials, one notification per episode; closed alerts purged after 30 days.
- `OutboxEvent.projectId` is nullable for exactly two global types (D512).

## Migration
`20261009120000_fleet_health_alerts`: `OutboxEvent.projectId` DROP NOT NULL; `FleetHealthAlert` + partial unique index.

## Test plan
- [x] api unit + lint + type-check
- [x] PG: notifications/fleet-* integration specs, outbox store, budget evaluator, ingest, cancel/requeue, approval relay
- [x] web i18n parity for the fleet kinds
- [ ] koda-wk deploy + live check (Task D10, human-run after merge)
BODY
)"
```

---

### Task D10: Deploy to koda-wk and run the live check (human-run, after PR 4 merges)

The approval-ask and escalation checks need **billed nax runs**; get the user's explicit go-ahead before dispatching
each one. Stopping the runner service needs `sudo`; the user runs those commands.

**Files:** none in the repo. Record results in the design doc (`projects/koda/koda-fleet-platform-design-2026-09-13.md`,
new §9.x) and memory.

- [ ] **Step 1: Build and deploy the merged main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && git switch main && git pull --ff-only
MAIN=$(git rev-parse --short=8 HEAD)
~/koda-wk/scripts/build-images.sh "$MAIN"     # pins KODA_IMAGE_TAG in ~/koda-wk/.env
~/koda-wk/deploy.sh                           # backup -> migrate (fleet_health_alerts, plus Part A-C migrations if not yet deployed) -> up -> proxy restart -> health
```

Expected: `Healthy: http://127.0.0.1:8030 (koda <sha8>)`. If the web build is OOM-killed (exit 137), raise the Docker
Desktop VM memory (koda-wk trap, 10-05) and rerun.

- [ ] **Step 2: Check the approval backlog drained without noise**

Registering the approval consumer releases every `fleet_approval_requested` row held since #236 deployed. Within a minute:

```bash
cd ~/koda-wk && docker compose exec -T postgres psql -U koda -d koda -c \
  "select status, count(*) from \"OutboxEvent\" where type = 'fleet_approval_requested' group by status;" -c \
  "select kind, count(*) from \"Notification\" where kind = 'approval_requested' group by kind;"
```

Expected: no `pending`/`processing` approval rows; `approval_requested` notifications only for asks still pending (none,
unless a job is waiting on one now).

- [ ] **Step 3: Restart the runner on the new code** (Part D changes no runner code; restart only if Parts A-C did)

```bash
pgrep -f "apps/runner/src/main.ts" | xargs kill     # launchd (KeepAlive) relaunches it via ~/.koda-runner/run-service.sh
sleep 20; tail -n 20 ~/.koda-runner/runner.log
```

- [ ] **Step 4: Live check (spec §8), signed in as the admin at `http://127.0.0.1:8030`**

1. **Approval ask (billed; ask first).** Dispatch a RUN on `nathapp-io/koda-fleet-sandbox` with bash mode `escalate` and
   the S1.5 `multiply`-style feature that forces a Bash ask (koda-wk-local-deployment notes). When the ask is raised,
   expect within ~5 s (outbox relay tick) an `approval_requested` item in the admin's bell / `/notifications`
   ("Approval needed: bash on nathapp-io/koda-fleet-sandbox"), linking to `/admin/fleet/approvals`. Decide it.
2. **Escalation (billed; ask first).** Use a run whose finish escalates (the sandbox's quality reviewer escalated the
   S1 `substract` run) or let the step-1 run finish. Expect the requester to get `job_escalated` (or `job_pr_opened`
   when finish promoted a PR) linking to `/<project>/fleet/jobs/<id>`. If the finish verdict only arrives with the
   bundle ingest, the item appears after ingest.
3. **Runner offline.** Stop the service (user, sudo): `sudo launchctl bootout system/dev.koda.runner`. Wait at least
   `runnerOfflineSec` (90 s) plus one detector tick (60 s), then 30 s for the relay. Expect exactly **one**
   `runner_offline` item ("Runner wk-mac is offline") per admin, and exactly one open row:
   `select kind, "subjectKey", "openedAt", "closedAt" from "FleetHealthAlert" order by "openedAt";`.
   Wait another 2 minutes: still one item, still one open row.
4. **Recovery.** Start it again (user, sudo): `sudo launchctl bootstrap system /Library/LaunchDaemons/dev.koda.runner.plist`
   (confirm the plist path first with `sudo launchctl print system/dev.koda.runner | head -5` before bootout). Within
   ~2 minutes the row gets `closedAt`; no new notification.
5. **Second outage.** Repeat 3: a **new** `FleetHealthAlert` row and a new `runner_offline` item (two in total). Restart
   the runner after.
6. **Credential expiring (passive).** If `/admin/fleet/credentials` shows an `expiring` cell (the openai-codex OAuth
   credential was flagged on 10-08 with expiry 10-11), expect one `credential_expiring` item for it; otherwise note
   "not exercised".

- [ ] **Step 5: Clean up** — close or merge any sandbox PR the runs opened, delete their branches on GitHub and in the
runner clone (`~/.koda-runner/workspace/nathapp-io/koda-fleet-sandbox`; `git update-ref -d refs/remotes/origin/<branch>`
for stale remote refs), and switch the clone back to `main` (koda-wk traps).

- [ ] **Step 6: Record** the outcome (pass/fail per check, job ids, alert ids, deployed sha, spend) in the design doc
§9.x and the koda memory entries; file issues for any failure.
