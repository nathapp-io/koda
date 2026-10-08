# Fleet S4b — Email Delivery and Project Invites — Design

Second part of fleet phase S4 ("team-ready koda", ruling S4-1). S4a (in-app notifications core,
`2026-10-08-fleet-s4a-notifications-core-design.md`) is merged and deployed (design doc §9.44); the @nathapp 4.1.0 +
Prisma 7 upgrade is merged and deployed (§9.47).

- S4a: in-app notifications core. Done.
- **S4b (this spec): email delivery of S4a notifications, and invite-to-project by email.**
- S4c: team access polish (per-project agents #61, disabled-user member guard, members UI polish).

## Goal

A koda team does not need to sit in the app. A project admin brings a new person into a project without handing over
a password, and a person hears about work that needs them (assignment, mention, a fleet job or approval waiting on
them) by email when they have not already seen it in the app. Email sending and templates use the
`@nathapp/nestjs-notify` stack so a later multi-tenant koda changes a constant, not the schema.

## Success criteria

1. A project admin invites `new@x` as DEVELOPER. With SMTP configured, `new@x` receives an invite email; opening the
   link, entering a name and password logs them in and lands them on the project as a DEVELOPER member.
2. Without SMTP, the same invite succeeds and the admin gets a one-time copyable link that works identically.
3. Inviting an email that already has an active account adds that user to the project immediately and (with SMTP)
   sends them an "added to project" email.
4. An invite link works once, expires after `INVITE_TTL_DAYS`, stops working when cancelled or re-sent, and every
   invalid link gets the same 404.
5. Assigning a ticket to user B, who does not open it, sends B one email about `EMAIL_DELAY_SEC` later; if B reads the
   notification in the app within the delay, no email is sent.
6. With no preference rows, a user gets email for `ASSIGNED`, `MENTIONED` and `FLEET_NEEDS_YOU` and none for
   `WATCHED_ACTIVITY` and `FLEET_HEALTH`; turning the email master switch off stops all notification email.
7. An SMTP outage never blocks or loses in-app notifications; email retries with backoff and ends `FAILED` after
   `EMAIL_MAX_ATTEMPTS`.

## Rulings (user, 2026-10-08)

- D516: invites are **project invites**: a project admin invites an email with a project role; no account means a
  single-use link that creates the account and the membership; an existing active account is added immediately.
- D517: email defaults per category: on for `ASSIGNED`, `MENTIONED`, `FLEET_NEEDS_YOU`; off for `WATCHED_ACTIVITY`,
  `FLEET_HEALTH`. The in-app default stays "missing row = on".
- D518: live suppression (S4-5) = **delayed send if still unread**: email is due `EMAIL_DELAY_SEC` (default 300)
  after the in-app row, `EMAIL_APPROVAL_DELAY_SEC` (default 60) for `approval_requested`, and is sent only if the
  notification is still unread at send time. No live-stream check.
- D519: one email per notification. No batching or digests.
- D520: without `SMTP_URL`, notification email is off (nothing scheduled) and invites still work: the API returns the
  invite path once for the admin to share.
- D521: password reset by email is out of scope (follow-up).
- D522: delay mechanism = approach A: a database schedule table claimed by a polling dispatcher (`SKIP LOCKED`).
  No outbox delay, no BullMQ.
- D523: use `@nathapp/nestjs-notify` 1.1.x + `@nathapp/nestjs-notify-prisma` 1.1.x for templates, the per-channel
  preference, delivery logging and sending; transport is `@nathapp/nestjs-notification` 4.1.x `SmtpEmailProvider`
  behind a koda `IDeliveryChannel`. All package rows use `tenantId = KODA_TENANT_ID = 'default'`.
- D524: koda's S4a `NotificationPreference` model is renamed `NotificationCategoryPreference` (the package owns the
  `NotificationPreference` name) and koda channel values become the package's lowercase `NotificationChannel`
  values (`in_app`, `email`).
- D525: keep a koda `ProjectInvite` model (not `@nathapp/nestjs-account`, which brings its whole
  Account/Membership/Role model); its fields and status values mirror `IInvitation` so a later move is a mapping.
- D526 (found while writing the spec, approved 2026-10-08): because only the token hash is stored, the
  `INVITE` email is sent inline from the create/resend request after commit and is **not retried**; on failure the
  response says `emailed: false` and the admin shares the returned link or resends. (`MEMBER_ADDED` and notification
  email are scheduled and retried as designed.)

## Ground truth (verified on main `e0ecb9c3`, 2026-10-08)

koda:
- `NotificationWriter.deliver(drafts)` (`apps/api/src/notifications/notification-writer.ts`) is the only notification
  writer: eligibility, IN_APP preference per category (`preferences.disabledUserIds(userIds, category, 'IN_APP')`),
  `repo.insertMany` (skip duplicates on `[userId, sourceType, sourceId, kind]`), then `UserEventBus.publish` per
  inserted row. It runs inside `FanOutPublisher` outbox handlers; a throw retries the record.
- `NOTIFICATION_CHANNELS = ['IN_APP']` (`notification.types.ts:5`). `'IN_APP'` literals appear only in
  `notification-preferences.service.ts` (lines 36, 47, 48) and `notification-writer.ts:39` (plus specs and generated
  agent docs).
- `NotificationPreference { userId, category, channel, enabled }`, `@@id([userId, category, channel])`, no `@@map`
  (table `"NotificationPreference"`), created in migration `20261009090000_notifications_core`. Preferences API:
  `GET/PUT /me/notification-preferences` with `{ category, inApp }`.
- Notification rows carry English `title`/`body` (truncated, no secrets or command text) and an in-app `link` path.
- Accounts: `POST /admin/users` (global ADMIN sets the password) or `POST /auth/register` only when
  `REGISTRATION_ENABLED=true` (default false). Login/register are throttled with `@Throttle(AUTH_LOGIN_LIMIT/60s)`.
- Members: `POST /projects/:slug/members` adds an **existing** user by email (project admin);
  `ProjectMember.role` is `ADMIN | DEVELOPER | AGENT | VIEWER`.
- `PrismaModule.forRoot({ ..., transaction: true })` is registered (provides `TRANSACTION_MANAGER`).
  `@nestjs/schedule` is installed; `SKIP LOCKED` claims exist in `prisma-outbox.store.ts` and `placement.service.ts`.
  Nightly retention precedent: `NotificationRetentionProcessor` `@Cron('30 4 * * *')`.
- koda does not register `ClockModule` / `IdGeneratorModule`, has no `@nestjs/event-emitter`, no tenant module, no
  public web URL config, and no mail catcher in `docker-compose.test.yml`.
- No existing model is named `DeliveryLog` or `NotificationTemplate`.

`@nathapp/nestjs-notify` 1.1.0 / `-notify-prisma` 1.1.1 (published; source read in the platform repo `4d1a20dd` and
the npm tarballs):
- `prisma/notify.prisma` adds `NotificationPreference` (`@@unique([userId, tenantId, channel])`, table
  `notification_preferences`), `DeliveryLog` (`delivery_logs`) and `NotificationTemplate`
  (`@@unique([tenantId, code, locale, channel])`, `notification_templates`). The Prisma repositories hard-code the
  delegates `notificationPreference`, `deliveryLog`, `notificationTemplate`.
- Preferences are per `(userId, tenantId, channel)` only; missing row = enabled. No category dimension.
- `DefaultNotifyService.send(payload)`: tenant check (below); if `userId` and the channel preference row is disabled,
  returns without sending or logging; loads the template (`TEMPLATE_NOT_FOUND` if absent); renders (content
  HTML-escaped, subject not); `CHANNEL_NOT_REGISTERED` if no channel; writes a `DeliveryLog` `QUEUED`; calls
  `channel.send(payload, content, subject)`; on a throw marks the log `FAILED` and rethrows; on success marks `SENT`.
  It sends immediately: delay/retry only exists via the optional `nestjs-queue` processor.
- Tenant: only `DefaultNotifyService` reads tenant context, once: `tenantContext.getTenantIdOrNull()`; it throws
  `TENANT_MISMATCH` only when a tenant is set and differs from `payload.tenantId`. `TenantContextService`
  (`@nathapp/nestjs-tenant` 1.1.0, a dependency of notify) is AsyncLocalStorage-based and returns `null` when `run()`
  was never called. The package's own spec uses `null` as its default case.
- `NotifyModule.register` provides the notify services and imports `EventEmitterModule.forRoot()`; it does **not**
  provide `TenantContextService`, `CLOCK` or `ID_GENERATOR` (the consumer supplies them; the package's module test
  does so from a `@Global()` module). `TEMPLATE_CACHE` is optional.
- `@nathapp/nestjs-queue` 4.1.0 is loaded by notify's processor/DLQ classes; its broker libraries (`bullmq`,
  `ioredis`, `kafkajs`, `amqplib`) are optional peers loaded lazily inside provider factories, so importing it needs
  none of them.

## Out of scope

- Password reset / forgot password (D521).
- Digests, batching, quiet hours (D519).
- Unsubscribe tokens in email; preferences stay behind login.
- Template editing UI, per-tenant template overrides, bounce/delivery webhooks (`providerEventNormalizer`).
- `@nathapp/nestjs-account` adoption; multi-tenant koda; multiple API instances.
- Notification email for agents (agents are never recipients, as in S4a).

## 1. Platform wiring (slice 1)

Dependencies (`apps/api`): `@nathapp/nestjs-notify@~1.1.0`, `@nathapp/nestjs-notify-prisma@~1.1.1`,
`@nathapp/nestjs-notification@~4.1.0`, `@nathapp/nestjs-tenant@1.1.0` (direct, so koda imports it explicitly),
`@nestjs/event-emitter@^3`.

`apps/api/src/email/` (new module `EmailModule`):

- `koda-tenant.ts`: `export const KODA_TENANT_ID = 'default'`. The only place the tenant id is spelled.
- `EmailPlatformModule` (`@Global()`): provides and exports `TenantContextService`, `CLOCK` (`ClockModule`) and
  `ID_GENERATOR` (`IdGeneratorModule`, UUID). koda never calls `tenantContext.run()`.
- `NotifyModule.register({ deliveryChannels: [{ channel: NotificationChannel.EMAIL, provider:
  SmtpDeliveryChannel }] })` and `NotifyPrismaModule.register()`.
- `SmtpDeliveryChannel implements IDeliveryChannel` (`channel = 'email'`): sends the already-rendered `subject` and
  `content` to `payload.recipient` through `@nathapp/nestjs-notification` (`NotificationModule.forRootAsync` with
  `SmtpEmailProvider`, `options.url = SMTP_URL`, from `EMAIL_FROM`; `sendEmailRaw`). A `SendResult` with
  `success: false` is thrown as an `Error` (retryable); an invalid-recipient rejection is thrown as
  `PermanentNotificationError`.
- When `SMTP_URL` is unset, the delivery channel is not registered and `EmailAvailability.configured` is `false`;
  nothing else in this spec schedules or sends email. Boot logs `email: disabled` or `email: smtp configured`; the
  URL is never logged.
- `EmailTemplateSeeder` (`OnApplicationBootstrap`, only when configured): upserts every file under
  `apps/api/src/email-templates/<locale>/<CODE>.{subject,html}` into `NotificationTemplate` for
  `(KODA_TENANT_ID, code, locale, 'email')`. Idempotent; templates live in git, the table is the runtime store.
  Boot fails if a required code has no `en` file. Codes: `NOTIFICATION`, `INVITE`, `MEMBER_ADDED`. Locales: `en`,
  `zh`; `zh` falls back to `en` if a file is missing (seeder copies `en`).

Config (`email.config.ts`, `registerAs('email')`, validated like the other configs; Joi rules in `env.validation.ts`):

| Variable | Default | Rule |
|---|---|---|
| `SMTP_URL` | unset | unset = email off |
| `EMAIL_FROM` | — | required when `SMTP_URL` is set |
| `WEB_PUBLIC_URL` | — | required when `SMTP_URL` is set; absolute http(s) URL, no trailing slash |
| `EMAIL_DELAY_SEC` | 300 | integer ≥ 0 |
| `EMAIL_APPROVAL_DELAY_SEC` | 60 | integer ≥ 0 |
| `EMAIL_MAX_ATTEMPTS` | 5 | integer ≥ 1 |
| `INVITE_TTL_DAYS` | 7 | integer 1-30 |

Multi-tenant path (not built): a tenant guard calls `tenantContext.run(tenant)` and `KODA_TENANT_ID` call sites become
`tenantContext.getTenantId()`; the package's mismatch check then protects sends. No schema change.

## 2. Data (one migration per slice that needs it)

### 2.1 Slice 1 migration `<ts>_notify_platform`

- Append the package `notify.prisma` models verbatim (`NotificationPreference`, `DeliveryLog`,
  `NotificationTemplate`; snake_case tables, `timestamptz`).
- Rename koda's S4a model:

```prisma
model NotificationCategoryPreference {
  userId   String
  category String
  channel  String  // 'in_app' | 'email' (package NotificationChannel values)
  enabled  Boolean

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, category, channel])
}
```

  SQL: `ALTER TABLE "NotificationPreference" RENAME TO "NotificationCategoryPreference"`, rename its primary key and
  foreign key constraints to the names Prisma generates for the new model, then
  `UPDATE "NotificationCategoryPreference" SET channel = 'in_app' WHERE channel = 'IN_APP'`; then create the package
  tables. Existing rows survive. `User.notificationPreferences` relation is renamed `notificationCategoryPreferences`.
- `NOTIFICATION_CHANNELS = ['in_app', 'email']`, typed from the package `NotificationChannel`; all `'IN_APP'` literals
  become `NotificationChannel.IN_APP`.

### 2.2 Slice 2 migration `<ts>_email_schedule`

```prisma
model EmailSchedule {
  id             String    @id @default(cuid())
  kind           String    // NOTIFICATION | INVITE | MEMBER_ADDED
  notificationId String?   @unique          // NOTIFICATION: one email per notification (D519)
  inviteId       String?                    // INVITE
  userId         String?                    // NOTIFICATION, MEMBER_ADDED
  projectId      String?                    // MEMBER_ADDED
  toEmail        String                     // snapshot at schedule time
  locale         String    @default("en")
  status         String    @default("PENDING") // PENDING | SENDING | SENT | SKIPPED | FAILED
  skipReason     String?   // READ | EMAIL_OFF | CATEGORY_OFF | USER_DISABLED | SOURCE_GONE
  attempts       Int       @default(0)
  dueAt          DateTime
  lockedUntil    DateTime?
  lastError      String?   // first 500 chars of the error message
  sentAt         DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  notification Notification? @relation(fields: [notificationId], references: [id], onDelete: Cascade)

  @@index([status, dueAt])
}
```

`EmailSchedule` only owns timing, claiming and retry. The audit trail of what was sent is the package `DeliveryLog`.

### 2.3 Slice 3 migration `<ts>_project_invites`

```prisma
model ProjectInvite {
  id               String    @id @default(cuid())
  projectId        String
  email            String    // lowercased, trimmed
  role             String    // ADMIN | DEVELOPER | VIEWER
  tokenHash        String    @unique   // sha256(raw token), hex
  status           String    @default("PENDING") // PENDING | ACCEPTED | EXPIRED | CANCELLED (IInvitation values)
  invitedById      String
  acceptedByUserId String?
  acceptedAt       DateTime?
  expiresAt        DateTime
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  invitedBy User    @relation("ProjectInviteInvitedBy", fields: [invitedById], references: [id], onDelete: Cascade)

  @@index([projectId, email, status])
}
```

- `EXPIRED` is computed on read (`status = PENDING and expiresAt <= now`) and written lazily by the nightly job; no
  code path relies on the stored value being current.
- At most one PENDING invite per `(projectId, email)`: creating or re-sending cancels the previous one in the same
  transaction (service-enforced).

### 2.4 Retention

The existing `NotificationRetentionProcessor` run also:
- deletes `EmailSchedule` rows in `SENT | SKIPPED | FAILED` with `updatedAt` older than 30 days;
- marks overdue PENDING invites `EXPIRED`, and deletes invites in `ACCEPTED | CANCELLED | EXPIRED` with `updatedAt`
  older than 30 days.

`DeliveryLog` is not purged in S4b.

## 3. Notification email (slice 2)

### 3.1 Preferences: two layers

| Layer | Store | Key | Missing row |
|---|---|---|---|
| Email master switch | package `NotificationPreference` | `(userId, KODA_TENANT_ID, 'email')` | on (package default) |
| Per category | `NotificationCategoryPreference` | `(userId, category, channel)` | `in_app`: on; `email`: `EMAIL_CATEGORY_DEFAULTS[category]` (D517) |

`EMAIL_CATEGORY_DEFAULTS` is one exported constant map in `notification.types.ts`. Email for a notification requires
both layers on. Writes to the master switch go through the package `PREFERENCE_SERVICE.updatePreference`.

API (extends S4a §3; user principals only):
- `GET /me/notification-preferences` → `{ emailAvailable, emailEnabled, categories: [{ category, inApp, email }] }`
  (effective values). `emailAvailable` = SMTP configured.
- `PUT /me/notification-preferences` → body `{ emailEnabled?, categories?: [{ category, inApp?, email? }] }`; upserts
  only the given fields. Setting email fields while `emailAvailable` is false is allowed (stored, takes effect when
  configured).
- This changes the S4a response shape (array → object); web and CLI consumers are updated in the same slice.

### 3.2 Scheduling

In `NotificationWriter.deliver`, after `insertMany`, when `EmailAvailability.configured`:
1. Take the inserted rows; drop users whose email master switch is off or whose `(category, email)` is off.
2. Load `User.email` for the rest; insert one `EmailSchedule` per row: `kind = NOTIFICATION`, `notificationId`,
   `userId`, `toEmail`, `dueAt = createdAt + EMAIL_APPROVAL_DELAY_SEC` for `kind = approval_requested` else
   `+ EMAIL_DELAY_SEC`. `createMany({ skipDuplicates: true })` on the unique `notificationId`.
3. Then publish live events (unchanged order: rows first, signals after).

This runs in the same outbox handler as the in-app insert. A database failure throws and the outbox retries; the
in-app unique key and the schedule unique key make the retry harmless. Email preference reads that fail throw (same
rule as S4a §6: never default silently).

### 3.3 Dispatcher

`EmailDispatcher` (`@Interval(EMAIL_DISPATCH_INTERVAL_MS = 30_000)`, registered only when configured; one tick at a
time per process):

0. **Close abandoned invite sends**: `INVITE` rows with `status = SENDING and lockedUntil < now` → `FAILED`
   (`lastError = 'abandoned'`). The dispatcher never sends `INVITE` rows.
1. **Claim** up to 20 rows of kind `NOTIFICATION | MEMBER_ADDED`: `status = PENDING and dueAt <= now`, or
   `status = SENDING and lockedUntil < now` (crash recovery). One `UPDATE ... SET status = 'SENDING', lockedUntil =
   now + 2 min, attempts = attempts + 1 WHERE id IN (SELECT id ... ORDER BY dueAt FOR UPDATE SKIP LOCKED LIMIT 20)
   RETURNING *`.
2. **Re-check** each row (skips set `SKIPPED` + `skipReason`, no send):
   - `NOTIFICATION`: notification gone (`SOURCE_GONE`); `readAt` set (`READ`); user disabled (`USER_DISABLED`);
     master switch off (`EMAIL_OFF`); category email off (`CATEGORY_OFF`).
   - `MEMBER_ADDED`: user disabled (`USER_DISABLED`).
3. **Send** via `NOTIFY_SERVICE.send({ tenantId: KODA_TENANT_ID, channel: 'email', templateCode: row.kind, locale:
   row.locale, recipient: row.toEmail, userId: row.userId ?? undefined, data })`. `data` per template in §3.4.
4. **Outcome**:
   - resolved → `SENT`, `sentAt = now`;
   - `NotifyException` with `TEMPLATE_NOT_FOUND | CHANNEL_NOT_REGISTERED | TENANT_MISMATCH`, or
     `PermanentNotificationError` → `FAILED` immediately;
   - any other error → if `attempts >= EMAIL_MAX_ATTEMPTS` then `FAILED`, else `PENDING`,
     `dueAt = now + 2^(attempts-1) min` (1, 2, 4, 8). `lastError` stores the first 500 chars of the message.
   - `FAILED` logs one WARN with `id`, `kind` and attempts; never the address or the message body.

The master-switch re-check in step 2 runs before `send()` because `send()` returns silently on a disabled channel
preference; doing it first keeps `skipReason` accurate.

### 3.4 Templates

Files `apps/api/src/email-templates/{en,zh}/<CODE>.subject` and `<CODE>.html`, rendered by the package
`SimpleTemplateEngine` (content HTML-escaped; subject plain).

| Code | `data` |
|---|---|
| `NOTIFICATION` | `title`, `body` (may be empty), `url` = `WEB_PUBLIC_URL + notification.link`, `prefsUrl` = `WEB_PUBLIC_URL + '/settings/notifications'` |
| `INVITE` | `projectName`, `inviterName`, `role`, `url` = `WEB_PUBLIC_URL + '/invite/' + rawToken`, `expiresAt` (ISO date) |
| `MEMBER_ADDED` | `projectName`, `inviterName`, `role`, `url` = `WEB_PUBLIC_URL + '/' + projectSlug` |

- `NOTIFICATION` subject = `[koda] {title}`; the body reuses the stored English `title`/`body` (no secrets, no
  command text, per S4a). Locale for notifications is `en` (users have no stored locale).
- The raw invite token is never stored, so an `INVITE` row cannot rebuild its URL later. `INVITE` email is
  therefore sent inline from the create/resend request and never retried by the dispatcher (§4.3, D526).

## 4. Project invites (slice 3)

### 4.1 Rules

- Who: a project ADMIN member or a global ADMIN (same guard as `POST /projects/:slug/members`).
- Roles: `ADMIN | DEVELOPER | VIEWER`; `AGENT` is rejected by the DTO.
- Token: 32 random bytes, base64url. Stored as `sha256` hex in `tokenHash`. Never logged; returned only in the create
  and resend responses.
- `expiresAt = now + INVITE_TTL_DAYS`.
- Accepting creates a global `MEMBER` user. `REGISTRATION_ENABLED` does not apply to invites.

### 4.2 API

| Route | Behaviour |
|---|---|
| `POST /projects/:slug/invites` `{ email, role }` | Lowercase + trim `email`. **Active user exists:** already a member → 409 `MEMBER_EXISTS`; else create `ProjectMember` (role) and, if configured, schedule a `MEMBER_ADDED` email (due now); 201 `{ outcome: 'ADDED', member }`. **Disabled user exists:** 409 `USER_DISABLED`. **No user:** in one transaction cancel any PENDING invite for `(project, email)` and create a new invite; after commit, if configured, send the `INVITE` email (§4.3); 201 `{ outcome: 'INVITED', invite, invitePath: '/invite/<token>', emailed }`. |
| `GET /projects/:slug/invites` | Invites newest first with effective status; no token. Same guard. |
| `POST /projects/:slug/invites/:id/resend` | Only PENDING or expired. New token + `expiresAt`, old invite row updated in place (`tokenHash` replaced, so the old link dies); send the `INVITE` email if configured; returns `{ invite, invitePath, emailed }`. |
| `DELETE /projects/:slug/invites/:id` | PENDING → CANCELLED; 204. Idempotent for already-final invites. |
| `GET /invites/:token` | `@Public()`, `@Throttle(AUTH_LOGIN_LIMIT/60s)`. Valid PENDING, unexpired → `{ projectName, projectSlug, email, role, inviterName, expiresAt }`. Anything else → the same 404 `INVITE_NOT_FOUND`. |
| `POST /invites/:token/accept` `{ name, password }` | `@Public()`, same throttle. Password rules = `RegisterDto`. One transaction: `UPDATE ProjectInvite SET status='ACCEPTED', acceptedAt=now WHERE tokenHash=$1 AND status='PENDING' AND expiresAt > now RETURNING *` (0 rows → 404 `INVITE_NOT_FOUND`); if a user with the invite email now exists → roll back, 409 `ACCOUNT_EXISTS` ("ask a project admin to add you"); else create the user (bcrypt 12, role MEMBER), set `acceptedByUserId`, create `ProjectMember`. After commit, issue tokens exactly as `POST /auth/login` does and return the same `AuthResponse`. |

`openapi.json` and the CLI client are regenerated.

### 4.3 Invite email

- `invitePath` is relative. The web builds the copy-link from its own origin; the email uses `WEB_PUBLIC_URL`.
- The raw token exists only in the create/resend request (D526). After commit, the request inserts an
  `EmailSchedule` row (`kind = INVITE`, `inviteId`, `toEmail`, `dueAt = now`, `status = SENDING`,
  `lockedUntil = now + 2 min`, `attempts = 1`) and calls `NOTIFY_SERVICE.send` with the URL held in memory:
  - success → row `SENT`; response `emailed: true`;
  - failure → row `FAILED` (no retry: the URL is not recoverable); response `emailed: false`. The admin still has
    the link in the response and can share it or resend.
- An `INVITE` row left `SENDING` by a crash is closed `FAILED` by dispatcher step 0 (§3.3).
- `MEMBER_ADDED` carries no secret, so it goes through the normal schedule (due now, retried).

### 4.4 Web

- Project members page: "Invite by email" dialog (email, role). Result: "Added <name>" or "Invite created" with the
  link shown once in a copy box and a note when `emailed` is false ("Email is not configured / could not be sent -
  share this link yourself").
- Pending invites list (status, email, role, inviter, expiry) with Resend (shows the new link once) and Cancel.
- Public page `/invite/[token]` (no auth layout): loads `GET /invites/:token`; shows project, role and email; name +
  password form; on success stores the session like login and navigates to `/<projectSlug>`; 404 → "This invite
  link is invalid or has expired"; 409 → "An account with this email already exists. Ask a project admin to add
  you."
- `/settings/notifications`: an "Email notifications" master toggle and an Email column in the category grid; both
  disabled with a hint when `emailAvailable` is false.
- i18n keys (`en`, `zh`) for all new strings.

### 4.5 CLI

- `koda project invite <email> --role <role> [--project <slug>]`: prints the outcome; prints `invitePath` when the
  invite was not emailed.
- `koda project invites [--project <slug>] [--cancel <id>] [--resend <id>] [--json]`.

## 5. Errors and edge cases

- SMTP down: in-app rows and live events are unaffected (email is scheduled after the insert, sent by the
  dispatcher); notification email retries then `FAILED`.
- A user who changes their email after scheduling gets the email at the old address (snapshot); accepted.
- A notification deleted by retention before its email is due → `SOURCE_GONE` (cascade deletes the schedule row in
  practice; the check covers the gap).
- Two accepts of the same token race: the conditional update lets exactly one win; the other gets 404.
- An invite for an email that registers or is admin-created before acceptance → accept returns 409; the admin uses
  the existing add-member path.
- Removing a member does not cancel unrelated invites; cancelling the project (delete) cascades invites.
- A missing template for `zh` falls back to `en` at seed time; a missing `en` file fails boot only when SMTP is
  configured.

## 6. Security

- Invite tokens: 256-bit, hashed at rest, single-use by conditional update, expiring, rotated on resend, absent from
  logs, list responses and `EmailSchedule`.
- Public invite endpoints: throttled like `/auth/register`; one 404 for every invalid state (no enumeration of
  tokens or invite states). Admin-only routes may return 409s that reveal account existence to project admins, as
  `POST /members` already does.
- Accept can never create a global ADMIN; the project role is the one a project admin chose.
- `SMTP_URL` (contains credentials) is never logged or returned; `GET /me/notification-preferences` exposes only
  `emailAvailable`.
- Email content: stored S4a `title`/`body` + escaped template values; no command text or secrets.
- Email links are built only from `WEB_PUBLIC_URL` (config), never from request headers (no host-header poisoning).

## 7. Slices

| Slice | Contents | Migration |
|---|---|---|
| 1 | Dependencies; `EmailPlatformModule` (tenant context, clock, id generator); `NotifyModule` + `NotifyPrismaModule`; `SmtpDeliveryChannel`; email config + `EmailAvailability`; template seeder + `en`/`zh` templates; S4a model rename + channel lowercasing. **First task: a module test that boots `NotifyModule` + `NotifyPrismaModule` + the koda providers and sends one email through a fake channel** (settles the DI wiring before anything builds on it). No user-visible change. | yes |
| 2 | `EmailSchedule`; two-layer preferences + API shape change; scheduling in `NotificationWriter`; `EmailDispatcher`; web settings page; CLI preference output; retention. | yes |
| 3 | `ProjectInvite`; invite + accept API; `INVITE` / `MEMBER_ADDED` email; web dialog, pending list, `/invite/[token]`; CLI; retention. | yes |
| 4 | koda-wk live check (human-run). | no |

Slices are sequential (2 needs 1; 3 needs 1 and the dispatcher from 2).

## 8. Testing

- Unit:
  - effective preferences (master switch × category defaults × rows);
  - scheduling: due times (normal vs `approval_requested`), skipped users, unique-key redelivery;
  - dispatcher with a fake clock and fake `INotifyService`: claim, every skip reason, success, permanent error,
    retryable error backoff and the `EMAIL_MAX_ATTEMPTS` cut-off, stuck-`SENDING` recovery;
  - invite service: every create outcome, resend rotation, cancel, expiry, accept outcomes;
  - `SmtpDeliveryChannel` result mapping; template seeder (idempotent, `zh` fallback, missing `en`).
- Integration (`KODA_DB_TESTS=1`):
  - slice 1 migration on a database holding S4a rows (`IN_APP` → `in_app`, rows kept);
  - the real `NotifyPrismaModule` repositories against the appended schema (`send` writes a `DeliveryLog`);
  - two concurrent dispatcher claims never take the same row;
  - two concurrent accepts of one token: one 201, one 404; no orphan user.
- Mail e2e: `docker-compose.test.yml` gains a Mailpit service; one test sends a real `NOTIFICATION` and an `INVITE`
  through `SmtpEmailProvider` and asserts arrival, subject and link via the Mailpit API.
- Web: component specs for the invite dialog, pending list, accept page and email preference controls.
- Playwright: admin invites → copies link → `/invite/[token]` → sets password → lands on the project as a member.

## 9. Live check (slice 4, koda-wk, human-run)

With `SMTP_URL` / `EMAIL_FROM` / `WEB_PUBLIC_URL` set (Mailpit on koda-wk first, then a real relay):
1. Assign a ticket to user B; do not open it; one email arrives after the delay with a working link.
2. Assign another; open it in the app within the delay; no email.
3. Invite a new address as DEVELOPER; accept from the email; logged in on the project with that role.
4. Invite an existing user; added immediately; "added to project" email arrives.
5. Turn email off for B; assign again; no email; `EmailSchedule` shows `EMAIL_OFF`.
6. Unset `SMTP_URL`; invite returns a copyable link that works; no schedule rows are created.

## 10. Delivery

One spec, one plan, three PRs (slices 1-3), then the live check. Design doc §9.x status note after each merge and
after the live check; koda-wk deploy after each PR (migration + backup as usual).
