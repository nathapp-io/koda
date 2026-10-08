# SPEC: Fleet S4b — Notification Email and Project Invites

## Summary

Builds the remaining two arcs of fleet S4b on top of the merged email platform (PR #245): (1) S4a in-app
notifications are emailed, a few minutes after they are written and only if the user has not read them yet, under a
two-layer preference (an email master switch plus per-category email toggles); (2) a project admin invites a person to
a project by email with a single-use link that creates their account and membership, or adds an existing user
directly. Sending goes through `@nathapp/nestjs-notify` (`NOTIFY_SERVICE`) with the tenant constant `KODA_TENANT_ID`.

## Motivation

S4 ("team-ready koda") needs a team that does not sit in the app. Today a notification only reaches a user who opens
koda, and adding a person to a project requires a global admin to create their account and hand over a password
(`POST /admin/users`), because `POST /projects/:slug/members` only adds an existing user. PR #245 wired the email
platform (templates `NOTIFICATION`, `INVITE`, `MEMBER_ADDED` seeded for tenant `default`; `SmtpDeliveryChannel`;
`EmailAvailability`; the email config) but nothing schedules or sends email yet, and no invite exists.

Design references (approved, read-only): `docs/superpowers/specs/2026-10-08-fleet-s4b-email-and-invites-design.md`
(rulings D516-D526) and `docs/superpowers/plans/2026-10-08-fleet-s4b-email-and-invites.md` (Parts B and C carry
worked code for every story below; the plan's refinements R1-R7 apply).

## Design

### Rulings that bind every story

- Email is off when `SMTP_URL` is unset or blank: nothing is scheduled, the dispatcher does nothing, invites still work
  and return the link to the admin (D520). Every email path checks `EmailAvailability.configured`.
- Delayed send (D518): a notification email is due `EMAIL_DELAY_SEC` (default 300) after the notification's
  `createdAt`, or `EMAIL_APPROVAL_DELAY_SEC` (default 60) when `Notification.kind === 'approval_requested'`, and is
  sent only if the notification is still unread at send time. One email per notification (D519).
- Email category defaults when a user has no `(category, 'email')` row (D517): `ASSIGNED`, `MENTIONED`,
  `FLEET_NEEDS_YOU` on; `WATCHED_ACTIVITY`, `FLEET_HEALTH` off. The in-app default stays "missing row = on".
- The email master switch is the package's `NotificationPreference` row `(userId, KODA_TENANT_ID, 'email')`; a
  missing row means on. Email requires both the master switch and the category toggle on.
- Invite email is sent inline from the create/resend request after commit and is never retried, because only the
  token hash is stored (D526). `MEMBER_ADDED` and notification email go through the schedule and are retried.
- Retries: `EMAIL_MAX_ATTEMPTS` (default 5); backoff `2^(attempts-1)` minutes; claim lock 2 minutes; batch 20; tick
  every 30 000 ms.
- Invite token: 32 random bytes, base64url (43 characters); stored only as its sha256 hex; expires after
  `INVITE_TTL_DAYS` (default 7).

### Integration

Symbols this feature reads but does not change (verified on `main` `6f5cd3b5`):

- `EmailAvailability` — `apps/api/src/email/email-availability.ts`: `configured: boolean`, `config(): IEmailConfig`,
  `webUrl(path: string): string`.
- `IEmailConfig` — `apps/api/src/config/email.config.ts`: `delaySec`, `approvalDelaySec`, `maxAttempts`, `inviteTtlDays`.
- `KODA_TENANT_ID` — `apps/api/src/email/koda-tenant.ts` (`'default'`).
- `EmailCoreModule` (global) and `EmailModule` — `apps/api/src/email/email.module.ts`; `NotifyModule` is global, so
  `NOTIFY_SERVICE`, `PREFERENCE_SERVICE` and `DELIVERY_CHANNEL_REGISTRY` resolve anywhere in the app.
- `INotifyService.send(payload: SendNotificationPayload): Promise<void>`, `NotifyException` (`code`), and
  `PermanentNotificationError` — `@nathapp/nestjs-notify`. `send` returns without sending when the package channel
  preference is disabled; it throws on transport failure.
- `ProjectAccessService.findProjectIdBySlug(slug)` and `.assertProjectAdmin(projectId, principal)` —
  `apps/api/src/projects/project-access.service.ts`.
- `PrismaProjectMembersRepository.findUserIdByEmail(email)` (case-insensitive) and `.createMember(projectId, userId, role)` —
  `apps/api/src/projects/members/prisma-project-members.repository.ts`.
- `PROJECT_MEMBER_ROLES` (`ADMIN`, `DEVELOPER`, `VIEWER`) — `apps/api/src/projects/members/domain/project-member.domain.ts`.
- `AuthService.generateAccessToken(userId, email, role, tokenVersion)` and `.generateRefreshToken(userId, tokenVersion)`
  (public) — `apps/api/src/auth/auth.service.ts`; `RegisterDto` and `PASSWORD_COMPLEXITY` — `apps/api/src/auth/dto/register.dto.ts`.
- Web: `useApi()`, `useAuth()`, `useAppToast()`, `extractApiError()`; `forwardToApi`, `unwrapAuth`, `setAuthCookies`
  (used by `apps/web/server/api/auth/register.post.ts`).
- CLI: `withContext`, `unwrap`, `table`, `handleApiError` (used by `apps/cli/src/commands/member.ts`).

Symbols this feature changes. Each baseline exists only to locate the code; it is never the interface to implement.

**`NotificationWriter.deliver(drafts)`** — `apps/api/src/notifications/notification-writer.ts` (US-002)
- Baseline: eligibility, in-app preferences, `repo.insertMany`, then `UserEventBus.publish` per inserted row.
- Target: same steps, plus, after `insertMany` and before the publishes, one `EmailSchedule` row per inserted
  notification whose user allows email for its category (only when `EmailAvailability.configured`). Constructor gains
  `EmailScheduleRepository`, `EmailAvailability` and `NotificationEmailRecipients`.

**`NotificationsRepository.insertMany(drafts)`** — `apps/api/src/notifications/notifications.repository.ts` (US-002)
- Baseline: returns `{ id, userId }[]`.
- Target: returns `{ id, userId, category, kind, createdAt }[]`.

**`NotificationPreferencesService`** — `apps/api/src/notifications/notification-preferences.service.ts` (US-001)
- Baseline: `list(userId): Promise<{ category, inApp }[]>`; `update(userId, items: { category, inApp }[])`.
- Target: `list(userId): Promise<PreferencesView>` where
  `PreferencesView = { emailAvailable: boolean; emailEnabled: boolean; items: { category; inApp: boolean; email: boolean }[] }`;
  `update(userId, change: { emailEnabled?: boolean; items?: { category; inApp?: boolean; email?: boolean }[] })`;
  new `emailAllowedUserIds(userIds, category): Promise<ReadonlySet<string>>` and
  `emailAllowed(userId, category): Promise<{ allowed: true } | { allowed: false; reason: 'EMAIL_OFF' | 'CATEGORY_OFF' }>`.
  `disabledUserIds` is unchanged.

**`GET` / `PUT /me/notification-preferences`** — `apps/api/src/notifications/me-notifications.controller.ts` (US-001)
- Baseline: both return `{ items: [{ category, inApp }] }`; PUT takes `{ items: [{ category, inApp }] }` (min 1 item).
- Target: both return `{ emailAvailable, emailEnabled, items: [{ category, inApp, email }] }`; PUT takes
  `{ emailEnabled?: boolean, items?: [{ category, inApp?: boolean, email?: boolean }] }` and upserts only the given fields.

**`AuthService`** — `apps/api/src/auth/auth.service.ts` (US-005)
- Target: new public `issueSession(user)` returning `{ accessToken, refreshToken, user: UserResponseDto }`, used by
  `register`, `login`, `refresh` and invite accept. `AUTH_LOGIN_LIMIT` moves from `auth.controller.ts` to a new
  exported constant in `apps/api/src/auth/auth-throttle.ts`, same value and env override.

**Web `useNotificationPreferences()`** — `apps/web/composables/useNotificationPreferences.ts` (US-003)
- Baseline: `{ items, pending, load, setInApp }`.
- Target: `{ view, pending, load, setInApp, setEmail, setEmailEnabled }` where `view` holds the whole
  `PreferencesView`.

**Web route middleware** — `apps/web/middleware/auth.global.ts` (US-007)
- Target: a path starting with `/invite/` returns before the unauthenticated redirect.

### New data (US-001, US-004)

```prisma
model EmailSchedule {               // US-001, migration 20261010100000_email_schedule
  id             String    @id @default(cuid())
  kind           String    // NOTIFICATION | INVITE | MEMBER_ADDED
  notificationId String?   @unique
  inviteId       String?
  userId         String?
  projectId      String?
  toEmail        String
  locale         String    @default("en")
  status         String    @default("PENDING") // PENDING | SENDING | SENT | SKIPPED | FAILED
  skipReason     String?   // READ | EMAIL_OFF | CATEGORY_OFF | USER_DISABLED | SOURCE_GONE
  attempts       Int       @default(0)
  dueAt          DateTime
  lockedUntil    DateTime?
  lastError      String?   // at most 500 characters
  sentAt         DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  notification Notification? @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  @@index([status, dueAt])
}

model ProjectInvite {               // US-004, migration 20261010110000_project_invites
  id               String    @id @default(cuid())
  projectId        String
  email            String    // lowercased, trimmed
  role             String    // ADMIN | DEVELOPER | VIEWER
  tokenHash        String    @unique
  status           String    @default("PENDING") // PENDING | ACCEPTED | EXPIRED | CANCELLED
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

Migration SQL must contain no `;` inside a statement (`apps/api/test/helpers/migration-schema.ts` splits on it), and
must leave zero drift against `schema.prisma`.

### Approach

- **Schedule and claim (US-001).** `EmailScheduleRepository.claimDue(now, limit)` is one SQL statement:
  `UPDATE "EmailSchedule" SET status='SENDING', "lockedUntil"=now+2min, attempts=attempts+1 WHERE id IN (SELECT id ...
  WHERE kind IN ('NOTIFICATION','MEMBER_ADDED') AND ((status='PENDING' AND "dueAt"<=now) OR (status='SENDING' AND
  "lockedUntil"<now)) ORDER BY "dueAt" LIMIT limit FOR UPDATE SKIP LOCKED) RETURNING ...` — the same SKIP LOCKED pattern
  as `apps/api/src/outbox/prisma-outbox.store.ts`. `INVITE` rows are never claimed.
- **Dispatcher (US-002).** `EmailDispatcher.tick(now)` first closes abandoned invite sends, then claims, then per row:
  `EmailContentBuilder.build(row)` returns either `{ skip: SkipReason }` or `{ data, userId }`; a skip marks the row
  `SKIPPED`; otherwise `sendOne` calls `NOTIFY_SERVICE.send` with `tenantId: KODA_TENANT_ID`, `channel: 'email'`,
  `templateCode: row.kind`, `locale: row.locale`, `recipient: row.toEmail`. One row's error never stops the batch.
  A scheduled tick runs about every 30 seconds and does not overlap a running tick.
- **Build order for a NOTIFICATION row (US-002):** notification missing → `SOURCE_GONE`; `readAt` set → `READ`; user
  missing or disabled → `USER_DISABLED`; `emailAllowed` not allowed → its reason; otherwise data
  `{ title, body: body ?? '', url: webUrl(link), prefsUrl: webUrl('/settings/notifications') }`.
- **Build order for a MEMBER_ADDED row (US-004):** user missing or disabled → `USER_DISABLED`; project missing or
  soft-deleted → `SOURCE_GONE`; membership missing → `SOURCE_GONE`; otherwise `{ projectName, role, url: webUrl('/' + slug) }`.
- **Invite create (US-004)** order: resolve project → `assertProjectAdmin` → normalise email (trim, lowercase) →
  `findUserIdByEmail`. Existing active user: create membership (unique violation → 409), schedule `MEMBER_ADDED` due
  now when configured, return `{ outcome: 'ADDED', member }`. Existing disabled user → 409. No user: in one
  transaction cancel any PENDING invite for `(projectId, email)` and create a new one; after commit, when configured,
  send the `INVITE` email inline (`InviteMailer`); return `{ outcome: 'INVITED', invite, invitePath: '/invite/' + raw, emailed }`.
- **Inline invite mail (US-004).** `InviteMailer.sendInvite` records an `INVITE` `EmailSchedule` row (status `SENDING`,
  attempts 1, lock now+2min) and sends it once through the dispatcher's send step with retry disabled, with data
  `{ projectName, inviterName, role, url: webUrl('/invite/' + raw), expiresAt }`; a successful send → `emailed: true`;
  anything else, including a thrown error, → `emailed: false` and the row `FAILED`.
- **Accept (US-005)** is one transaction: a conditional update flips the invite `PENDING → ACCEPTED` only when the
  hash matches and `expiresAt > now` (zero rows → 404); if a user with the invite email exists → 409 and the transaction
  rolls back; otherwise create the user (password hashed as `UsersAdminService.create` does, role `MEMBER`, email from
  the invite, name from the body), set `acceptedByUserId`, create the membership. The session is issued after commit
  through `AuthService.issueSession`.
- **Web accept (US-007)** goes through a Nitro route `apps/web/server/api/invites/[token]/accept.post.ts` that sets the
  httpOnly auth cookies exactly like `apps/web/server/api/auth/register.post.ts`.
- **Contract regeneration.** API stories that change routes or DTOs (US-001, US-004, US-005) run `bun run api:export-spec`
  from the repo root and commit `openapi.json`; US-006 runs `bun run generate` from the repo root to refresh
  `apps/cli/src/generated/`. Generated files are never hand-edited.

### API (US-004, US-005)

| Route | Auth | Result |
|---|---|---|
| `POST /projects/:slug/invites` `{ email, role }` | project ADMIN or global ADMIN | 201 `{ outcome: 'ADDED', member }` or `{ outcome: 'INVITED', invite, invitePath, emailed }`; 409 `MEMBER_EXISTS` / `USER_DISABLED`; 400 bad role |
| `GET /projects/:slug/invites` | same | `InviteDto[]` newest first, effective status, no token or hash |
| `POST /projects/:slug/invites/:id/resend` | same | 201 `{ invite, invitePath, emailed }`; 409 unless PENDING or expired; 404 unknown |
| `DELETE /projects/:slug/invites/:id` | same | 200; PENDING → CANCELLED; final invites unchanged; 404 unknown |
| `GET /invites/:token` | public, throttled | 200 `{ projectName, projectSlug, email, role, inviterName, expiresAt }`; every invalid state the same 404 |
| `POST /invites/:token/accept` `{ name, password }` | public, throttled | 201 login-shaped `{ accessToken, refreshToken, user }`; 404 invalid; 409 account exists; 400 weak password |

Controllers: `ProjectInvitesController` (methods `create`, `list`, `resend`, `cancel`, so operationIds
`ProjectInvitesController_create` etc. and generated CLI functions `projectInvitesControllerCreate`,
`projectInvitesControllerList`, `projectInvitesControllerResend`, `projectInvitesControllerCancel`) and
`PublicInvitesController` (`preview`, `accept`). `InviteDto = { id, email, role, status, inviterName, expiresAt, createdAt }`.
Error keys live in `apps/api/src/i18n/{en,zh}/invites.json`.

### CLI Behavior (US-006)

- `koda member invite --email <e> --role <ADMIN|DEVELOPER|VIEWER> [--project <slug>] [--json]`
- `koda member invites [--project <slug>] [--cancel <id>] [--resend <id>] [--json]`
- stdout: human lines below, or `JSON.stringify(data, null, 2)` with `--json`; stderr: errors through `handleApiError`.
- Exit 0 success; 1 API/network error (including 404/409 from the API); 2 config/auth error; 3 validation error.
- Human output: `Added <email> as <role>`; `Invite created for <email>. Emailed.`; `Invite created for <email>. Share
  this link (shown once): <invitePath>`; `invites` prints a table with headers `ID`, `Email`, `Role`, `Status`, `Expires`.

### Failure Handling

- SMTP or transport failure on a scheduled row → row back to `PENDING` with `dueAt = now + 2^(attempts-1)` minutes and
  `lastError` (first 500 characters); after `EMAIL_MAX_ATTEMPTS` → `FAILED`.
- `PermanentNotificationError`, or `NotifyException` with code `TEMPLATE_NOT_FOUND`, `CHANNEL_NOT_REGISTERED` or
  `TENANT_MISMATCH` → `FAILED` on the first attempt.
- A `FAILED` row logs one WARN with the row id, kind and attempts only — never the address, the body or the URL.
- A database error while scheduling inside `NotificationWriter.deliver` propagates, so the outbox retries; the unique
  keys make the retry harmless.
- A builder or repository error for one claimed row → that row returns to `PENDING` with backoff; the rest of the batch
  continues.
- Invite email failure → `emailed: false`, the `INVITE` row `FAILED`, the invite still created (no retry, D526).
- An `INVITE` row left `SENDING` past its lock (crash) → `FAILED` with `lastError` `abandoned` on the next tick.
- Accept: any invalid token state → 404 with an identical body; an account created for the invite email after the
  invite → 409 and nothing is written.

## Out of Scope

- Password reset or forgot-password by email (D521).
- Digests, batching or quiet hours: exactly one email per notification (D519).
- Unsubscribe tokens in email links; preferences stay behind login.
- Editing email templates in the UI, per-tenant template overrides, and bounce or delivery webhooks (`providerEventNormalizer`).
- Adopting `@nathapp/nestjs-account` invitations or memberships, multi-tenant koda, and coordinating more than one API instance.
- Email for agents: agents are never notification or email recipients.
- BullMQ, Redis or the `nestjs-notify` queue processor (`enableProcessor`): the delay and retries live in the `EmailSchedule` table.
- Retrying invite email: only the token hash is stored, so a failed invite email is reported as `emailed: false` and the admin shares the link or resends (D526).
- Storing, logging or returning the raw invite token anywhere except the create and resend responses and the invite email.
- A per-user email locale: notification email is always rendered in `en`; only invite email picks `zh` from `Accept-Language`.
- Changing the merged S4b platform pieces (`EmailModule`, `SmtpDeliveryChannel`, `email.config.ts`, the seeded templates, `KODA_TENANT_ID`).
- Deploying to koda-wk or editing anything under `deployments/` or the koda-wk compose files.
- The Mailpit SMTP end-to-end test and the Playwright invite end-to-end test: they run after this nax run, outside story acceptance.
- Adding email or invite coverage to `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`, which does not cover members or notifications today.
- The nightly purge of final `EmailSchedule` rows and of expired, accepted or cancelled `ProjectInvite` rows (S4b design §2.4) is a follow-up; this feature computes `EXPIRED` on read instead of writing it.
- US-002 only: the WARN line for a `FAILED` email row (row id, kind and attempts only, never the address, body or URL) is required behaviour but is not acceptance-tested in this story.
- US-002 only: classifying `NotifyException` codes `TEMPLATE_NOT_FOUND`, `CHANNEL_NOT_REGISTERED` and `TENANT_MISMATCH` as permanent is not acceptance-tested; `PermanentNotificationError` is.
- US-004 only: two concurrent `POST /projects/:slug/invites` for the same project and email may both leave a `PENDING` invite; cancel-then-create is atomic per request, not across requests.
- US-005 only: per-token or per-IP lockout beyond the existing `AUTH_LOGIN_LIMIT` throttle on the two public invite routes.
- US-002 only: email for notifications written before this feature ships (no backfill of `EmailSchedule`).

## Stories

1. **US-001: Email schedule store and two-layer email preferences** — `Workdir: apps/api` — no dependencies.
2. **US-002: Schedule notification email and dispatch it** — `Workdir: apps/api` — depends on US-001.
3. **US-003: Web email preference controls** — `Workdir: apps/web` — depends on US-001.
4. **US-004: Project invites — model, admin routes and invite mail** — `Workdir: apps/api` — depends on US-002.
5. **US-005: Public invite preview and accept** — `Workdir: apps/api` — depends on US-004.
6. **US-006: CLI member invite and invites** — `Workdir: apps/cli` — depends on US-004.
7. **US-007: Web invite dialog and accept page** — `Workdir: apps/web` — depends on US-005.

### Context Files

> Existing files to read, or files an upstream dependency creates (annotated).

**US-001**

- `apps/api/src/notifications/notification-preferences.service.ts` — the S4a per-category service this story extends
- `apps/api/src/notifications/me-notifications.controller.ts` — preferences routes whose shape changes
- `apps/api/src/outbox/prisma-outbox.store.ts` — the SKIP LOCKED claim pattern to mirror
- `apps/api/src/email/email.module.ts` — `EmailCoreModule`, where the schedule repository is registered (global)
- `docs/superpowers/plans/2026-10-08-fleet-s4b-email-and-invites.md` — Tasks B1 and B2 carry worked code

**US-002**

- `apps/api/src/notifications/notification-writer.ts` — the only notification writer, extended here
- `apps/api/src/email/schedule/email-schedule.repository.ts` — created by US-001, consumed here
- `apps/api/src/email/email-availability.ts` — the email-on switch and link builder
- `apps/api/test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts` — how to deliver outbox records through `FanOutPublisher` in a PG test
- `docs/superpowers/plans/2026-10-08-fleet-s4b-email-and-invites.md` — Tasks B3 and B4 carry worked code

**US-003**

- `apps/web/pages/settings/notifications.vue` — the S4a settings page extended here
- `apps/web/composables/useNotificationPreferences.ts` — composable whose return shape changes
- `apps/web/lib/notification-types.ts` — `PREFERENCES_PATH` and preference types
- `apps/web/tests/pages/notification-settings-page.spec.ts` — mount harness (`mountSfc`, `uiStubs`, `enI18n`, `toastRecorder`)

**US-004**

- `apps/api/src/projects/members/project-members.service.ts` — membership add pattern and 409 mapping to mirror
- `apps/api/src/projects/members/prisma-project-members.repository.ts` — `findUserIdByEmail`, `createMember`
- `apps/api/src/projects/members/project-members.controller.ts` — controller shape and Swagger decorators to mirror
- `apps/api/src/email/dispatch/email-dispatcher.ts` — created by US-002, `sendOne` used for inline invite mail
- `apps/api/src/email/dispatch/email-content.builder.ts` — created by US-002; this story adds its `MEMBER_ADDED` branch and the matching cases in its spec

**US-005**

- `apps/api/src/projects/invites/prisma-project-invites.repository.ts` — created by US-004, extended here
- `apps/api/src/projects/invites/project-invites.service.ts` — created by US-004, gains `resend` and `cancel`
- `apps/api/src/auth/auth.service.ts` — session issuing refactored into `issueSession`
- `apps/api/src/auth/auth.controller.ts` — `AUTH_LOGIN_LIMIT` throttle pattern
- `apps/api/test/helpers/http-app.ts` — `bootHttpApp`, `data`, `loginToken`

**US-006**

- `apps/cli/src/commands/member.ts` — the `member` command group this story extends
- `apps/cli/src/commands/member.spec.ts` — command test pattern (mocked generated client and context)
- `apps/cli/src/utils/output.ts` — `table`
- `apps/cli/src/utils/error.ts` — `handleApiError`

**US-007**

- `apps/web/components/ProjectMembersPanel.vue` — members panel the invite panel sits beside
- `apps/web/pages/[project]/settings.vue` — renders `ProjectMembersPanel` today
- `apps/web/server/api/auth/register.post.ts` — cookie-setting Nitro route to mirror
- `apps/web/middleware/auth.global.ts` — public-route handling extended here
- `apps/web/pages/register.vue` — vee-validate + zod form to mirror on the accept page

### Creates

> New files each story authors.

**US-001**

- `apps/api/prisma/migrations/20261010100000_email_schedule/migration.sql` — `EmailSchedule` table
- `apps/api/src/email/schedule/email-schedule.types.ts` — `EmailKind`, `EmailStatus`, `SkipReason`, `EmailScheduleRow`, `LOCK_MS`, `LAST_ERROR_MAX`
- `apps/api/src/email/schedule/email-schedule.repository.ts` — `EmailScheduleRepository`
- `apps/api/test/integration/email/email-schedule-repository.integration.spec.ts` — claim and idempotency on PG

**US-002**

- `apps/api/src/notifications/notification-email-recipients.ts` — `NotificationEmailRecipients.emails(userIds)`
- `apps/api/src/email/dispatch/send-outcome.ts` — `classifySendError`, `backoffMs`, `errorText`
- `apps/api/src/email/dispatch/email-content.builder.ts` — `EmailContentBuilder.build(row)`
- `apps/api/src/email/dispatch/email-dispatcher.ts` — `EmailDispatcher.tick`, `sendOne`, `scheduledTick`
- `apps/api/test/integration/email/notification-email.integration.spec.ts` — the outbox-to-send seam on PG

**US-004**

- `apps/api/prisma/migrations/20261010110000_project_invites/migration.sql` — `ProjectInvite` table
- `apps/api/src/projects/invites/invite-token.ts` — `generateInviteToken()`, `hashInviteToken(raw)`
- `apps/api/src/projects/invites/domain/project-invite.domain.ts` — `InviteStatus`, `ProjectInviteRecord`, `effectiveStatus(record, now)`
- `apps/api/src/projects/invites/prisma-project-invites.repository.ts` — `PrismaProjectInvitesRepository`
- `apps/api/src/projects/invites/project-invites.service.ts` — `ProjectInvitesService.create`, `list`
- `apps/api/src/projects/invites/invite-mailer.ts` — `InviteMailer.sendInvite`
- `apps/api/src/projects/invites/project-invites.controller.ts` — `ProjectInvitesController`
- `apps/api/src/projects/invites/project-invites.module.ts` — `ProjectInvitesModule`
- `apps/api/src/projects/invites/dto/create-invite.dto.ts` — `CreateInviteDto`
- `apps/api/src/projects/invites/dto/invite.dto.ts` — `InviteDto` and the create result DTO
- `apps/api/src/i18n/en/invites.json` — invite error messages
- `apps/api/src/i18n/zh/invites.json` — invite error messages (zh)
- `apps/api/test/integration/projects/project-invites-admin.integration.spec.ts` — admin routes over HTTP on PG

**US-005**

- `apps/api/src/auth/auth-throttle.ts` — exported `AUTH_LOGIN_LIMIT`
- `apps/api/src/projects/invites/invite-acceptance.service.ts` — `InviteAcceptanceService.accept`
- `apps/api/src/projects/invites/public-invites.controller.ts` — `PublicInvitesController`
- `apps/api/src/projects/invites/dto/accept-invite.dto.ts` — `AcceptInviteDto`
- `apps/api/src/projects/invites/dto/invite-preview.dto.ts` — `InvitePreviewDto`
- `apps/api/test/integration/projects/project-invites-api.integration.spec.ts` — preview, accept, resend and cancel over HTTP on PG

**US-007**

- `apps/web/composables/useProjectInvites.ts` — `useProjectInvites(slug)`, `inviteLink(path)`
- `apps/web/components/ProjectInvitesPanel.vue` — invite dialog and pending invites
- `apps/web/pages/invite/[token].vue` — public accept page
- `apps/web/server/api/invites/[token]/accept.post.ts` — accept and set auth cookies
- `apps/web/tests/components/ProjectInvitesPanel.spec.ts` — panel behaviour
- `apps/web/tests/pages/invite-accept.spec.ts` — accept page behaviour
- `apps/web/tests/server/invite-accept-route.spec.ts` — Nitro route behaviour

### Modifies

> Only existing tests and test helpers whose assertions this feature's correct change breaks. Production files a story
> changes are not listed; files an upstream story creates are listed under that consumer's Context Files instead.

**US-001**

- `apps/api/src/notifications/notification-preferences.service.spec.ts` — its setup constructs NotificationPreferencesService with two arguments and asserts list() returns a bare array of category and inApp pairs. US-001 adds the package PREFERENCE_SERVICE and EmailAvailability constructor arguments and changes list() to return emailAvailable, emailEnabled and items with category, inApp and email. Replacing invariant: in-app values are unchanged per category and appear under items[].inApp.
- `apps/api/src/notifications/me-notifications.controller.spec.ts` — asserts the preferences routes return items of category and inApp only, and that PUT requires at least one item. Replacing invariant: both routes return emailAvailable, emailEnabled and items with category, inApp and email; PUT accepts emailEnabled alone.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — the NotificationsModule DI spec compiles the module with only these global stubs; US-001 makes NotificationPreferencesService inject PREFERENCE_SERVICE and EmailAvailability, so this module must provide useValue stubs for both and for EmailScheduleRepository.

**US-002**

- `apps/api/src/notifications/notification-writer.spec.ts` — constructs NotificationWriter with four arguments and asserts the call order insert, publish, publish. US-002 adds three constructor arguments and an email-scheduling step between the insert and the publishes. Replacing invariant: the order is insert, schedule, then one publish per inserted row.
- `apps/api/src/notifications/notifications.repository.spec.ts` — asserts insertMany selects only id and userId and resolves rows of id and userId. Replacing invariant: it selects and returns id, userId, category, kind and createdAt.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — NotificationsModule now provides EmailDispatcher and EmailContentBuilder, so the global stubs must also provide a NOTIFY_SERVICE stub for the NotificationsModule DI spec.

**US-003**

- `apps/web/tests/pages/notification-settings-page.spec.ts` — its fake composable exposes items and the S4a cases read items; US-003 changes the composable to expose view. Replacing invariant: the S4a in-app cases read view.items and otherwise pass unchanged.
- `apps/web/tests/composables/useNotificationPreferences.spec.ts` — asserts load() stores the response items array and setInApp replaces items; US-003 stores the whole view. Replacing invariant: view.items holds what items held.

**US-005**

- `apps/api/src/auth/auth.controller.spec.ts` — its throttle tests read the login limit from the auth controller module at class-load time; US-005 moves the constant to the new auth throttle module. Replacing invariant: the same 5-per-minute default and the same AUTH_LOGIN_THROTTLE_LIMIT override apply to login, register, logout and the two public invite routes.

**US-006**

- `apps/cli/src/commands/member.spec.ts` — its mock factory for the generated client lists only the four member functions; US-006 adds the four invite functions (projectInvitesControllerCreate, projectInvitesControllerList, projectInvitesControllerResend, projectInvitesControllerCancel). Replacing invariant: the existing member command cases pass unchanged.

**US-007**

- `apps/web/tests/middleware/auth.spec.ts` — gains the invite public-route case; existing cases keep asserting that unauthenticated visits to protected routes redirect to the login page.

### Seams

- S1 (US-001 → US-002) — [integration] `EmailScheduleRepository.scheduleNotifications` and `NotificationPreferencesService.emailAllowedUserIds` reached from `FanOutPublisher.publish` of a `ticket_event` `assigned` outbox record (US-002 AC 13).
- S2 (US-002 → US-002) — [integration] `NOTIFY_SERVICE` reached from `EmailDispatcher.tick` once per due row, and not again on a second tick (US-002 AC 13, AC 14).
- S3 (US-002 → US-004) — [integration] the dispatcher's send step reached from `POST /projects/:slug/invites` for a new email (US-004 AC 10).
- S4 (US-001 → US-003) — [unit] the composable's PUT body shape matches the US-001 request contract (US-003 AC 9, AC 10).
- S5 (US-004 → US-006) — [unit] the CLI calls `projectInvitesControllerCreate` with `{ path: { slug }, body: { email, role } }` (US-006 AC 1).
- S6 (US-005 → US-007) — [unit] the Nitro route sets auth cookies from the `/invites/<token>/accept` response (US-007 AC 13).
- S7 (US-004 → US-007) — [unit] the web composable posts `{ email, role }` to `/projects/<slug>/invites` (US-007 AC 7).

## Acceptance Criteria

### US-001: Email schedule store and two-layer email preferences (`Workdir: apps/api`)

- [integration] Two concurrent `EmailScheduleRepository.claimDue(now, 20)` calls over 30 due `MEMBER_ADDED` rows return disjoint row sets whose sizes sum to 30.
- [integration] `EmailScheduleRepository.claimDue(now, 20)` leaves a `PENDING` row whose `dueAt` is later than `now` in status `PENDING`.
- [integration] `EmailScheduleRepository.claimDue(now, 20)` never returns a row of kind `INVITE`, even one that is `SENDING` with `lockedUntil` before `now`.
- [integration] `EmailScheduleRepository.claimDue(now, 20)` returns a `SENDING` row whose `lockedUntil` is before `now` with its `attempts` increased by one.
- [integration] `EmailScheduleRepository.closeAbandonedInvites(now)` sets an `INVITE` row that is `SENDING` with `lockedUntil` before `now` to `FAILED` with `lastError` `abandoned`.
- [integration] Calling `EmailScheduleRepository.scheduleNotifications` twice with the same `notificationId` leaves exactly one `EmailSchedule` row for that notification.
- [integration] `EmailScheduleRepository.retryAt(id, dueAt, error)` with a 2 000-character `error` stores a `lastError` of exactly 500 characters.
- [unit] For a user with no preference rows, `NotificationPreferencesService.list(userId)` returns `items` whose `email` values are `true` for `ASSIGNED`, `MENTIONED` and `FLEET_NEEDS_YOU` and `false` for `WATCHED_ACTIVITY` and `FLEET_HEALTH`.
- [unit] `NotificationPreferencesService.list(userId)` returns `emailAvailable` equal to `EmailAvailability.configured`.
- [unit] `NotificationPreferencesService.emailAllowedUserIds(['off', 'plain'], 'ASSIGNED')` returns only `plain` when user `off` has a package `NotificationPreference` row for tenant `default`, channel `email`, with `enabled` false.
- [unit] `NotificationPreferencesService.emailAllowedUserIds(['opt-in'], 'WATCHED_ACTIVITY')` returns `opt-in` when that user has a `NotificationCategoryPreference` row for `WATCHED_ACTIVITY`, channel `email`, with `enabled` true.
- [unit] `NotificationPreferencesService.emailAllowed(userId, category)` returns `{ allowed: false, reason: 'EMAIL_OFF' }` when the user's email master switch is off.
- [unit] `NotificationPreferencesService.emailAllowed(userId, category)` returns `{ allowed: false, reason: 'CATEGORY_OFF' }` when the master switch is on and only the category email toggle is off.
- [integration] `PUT /me/notification-preferences` with body `{ emailEnabled: false }` stores a `NotificationPreference` row with `tenantId` `default`, `channel` `email` and `enabled` false for the caller.
- [integration] `PUT /me/notification-preferences` with body `{ items: [{ category: 'MENTIONED', email: false }] }` leaves the caller's `inApp` value for `MENTIONED` unchanged.

**Out of scope:**
- `/me/notification-preferences` ownership: the S4a users-only, caller-scoped guard is unchanged and not re-tested here.

### US-002: Schedule notification email and dispatch it (`Workdir: apps/api`)

- [unit] When `EmailAvailability.configured` is true and the user is allowed email for `ASSIGNED`, `NotificationWriter.deliver` calls `EmailScheduleRepository.scheduleNotifications` with that notification's id, the user's email address, and `dueAt` equal to the notification's `createdAt` plus `EMAIL_DELAY_SEC` seconds.
- [unit] `NotificationWriter.deliver` schedules a notification of kind `approval_requested` with `dueAt` equal to its `createdAt` plus `EMAIL_APPROVAL_DELAY_SEC` seconds.
- [unit] `NotificationWriter.deliver` does not call `EmailScheduleRepository.scheduleNotifications` when `EmailAvailability.configured` is false.
- [unit] `NotificationWriter.deliver` leaves out of the scheduled rows a user whom `NotificationPreferencesService.emailAllowedUserIds` does not return.
- [unit] `NotificationWriter.deliver` rejects with the same error when `EmailScheduleRepository.scheduleNotifications` throws.
- [unit] `EmailDispatcher.tick(now)` marks a claimed `NOTIFICATION` row `SKIPPED` with `skipReason` `SOURCE_GONE` when its notification no longer exists.
- [unit] `EmailDispatcher.tick(now)` marks a claimed `NOTIFICATION` row `SKIPPED` with `skipReason` `USER_DISABLED` when its user is disabled.
- [unit] `EmailDispatcher.tick(now)` marks a claimed `NOTIFICATION` row `SKIPPED` with the `reason` that `NotificationPreferencesService.emailAllowed` returns when that result is not allowed.
- [unit] `EmailDispatcher.tick(now)` calls `NOTIFY_SERVICE.send` for an allowed row with `tenantId` `default`, `channel` `email`, `templateCode` `NOTIFICATION`, the row's `toEmail` as `recipient`, and `data.url` equal to `WEB_PUBLIC_URL` joined with the notification's `link`.
- [unit] When `NOTIFY_SERVICE.send` throws an `Error` for a row with `attempts` 2 and `EMAIL_MAX_ATTEMPTS` 5, `EmailDispatcher.tick(now)` returns the row to `PENDING` with `dueAt` equal to `now` plus 2 minutes.
- [unit] When `NOTIFY_SERVICE.send` throws an `Error` for a row whose `attempts` equals `EMAIL_MAX_ATTEMPTS`, `EmailDispatcher.tick(now)` marks the row `FAILED`.
- [unit] When `NOTIFY_SERVICE.send` throws `PermanentNotificationError` for a row with `attempts` 1, `EmailDispatcher.tick(now)` marks the row `FAILED`.
- [integration] **(seam S1, S2)** With email configured and the registered email delivery channel's `send` spied, publishing a `ticket_event` `assigned` outbox record for user B through `FanOutPublisher.publish` and then calling `EmailDispatcher.tick` at a time later than `EMAIL_DELAY_SEC` after it invokes the channel's `send` once with B's email address as `recipient`.
- [integration] **(seam S2, re-trigger)** A second `EmailDispatcher.tick` after that send does not invoke the email channel's `send` again.
- [integration] When B's notification is marked read through `POST /me/notifications/:id/read` before its email is due, `EmailDispatcher.tick` at a time later than `EMAIL_DELAY_SEC` does not invoke the email channel's `send`.

**Out of scope:**
- The WARN line for a `FAILED` row: required (row id, kind, attempts only) but not acceptance-tested here.
- Continuing the batch when one claimed row's build or repository call throws: required (that row returns to `PENDING` with backoff) but not acceptance-tested here.
- The scheduled tick's timer and its no-overlap guard: not acceptance-tested; `tick(now)` is the tested entry point below the timer.
- Classifying `NotifyException` codes as permanent: not acceptance-tested; `PermanentNotificationError` is.

### US-003: Web email preference controls (`Workdir: apps/web`)

- [unit] The `/settings/notifications` page renders a checkbox with `data-testid` `notification-email-master` whose checked state equals the loaded view's `emailEnabled`.
- [unit] The `/settings/notifications` page renders a checkbox with `data-testid` `notification-pref-email-<CATEGORY>` for each of the five categories whose checked state equals that item's `email`.
- [unit] When the loaded view has `emailAvailable` false, the `notification-email-master` checkbox is disabled.
- [unit] When the loaded view has `emailAvailable` false, every `notification-pref-email-<CATEGORY>` checkbox is disabled.
- [unit] When the loaded view has `emailAvailable` false, the page shows the text of i18n key `notifications.preferences.emailUnavailable`.
- [unit] When the loaded view has `emailEnabled` false, every `notification-pref-email-<CATEGORY>` checkbox is disabled.
- [unit] Unchecking `notification-email-master` calls the composable's `setEmailEnabled(false)`.
- [unit] Unchecking `notification-pref-email-MENTIONED` calls the composable's `setEmail('MENTIONED', false)`.
- [unit] **(seam S4)** `useNotificationPreferences().setEmail('MENTIONED', false)` sends `PUT /me/notification-preferences` through `useApi()` with body exactly `{ items: [{ category: 'MENTIONED', email: false }] }`.
- [unit] **(seam S4)** `useNotificationPreferences().setEmailEnabled(false)` sends `PUT /me/notification-preferences` through `useApi()` with body exactly `{ emailEnabled: false }`.
- [unit] `useNotificationPreferences().load()` stores the response's `emailAvailable`, `emailEnabled` and `items` in `view`.
- [unit] When `setEmail` rejects, the page restores the checkbox to its previous checked state.
- [unit] When `setEmail` rejects, the page shows the error through `useAppToast().error` with `extractApiError(err)`.
- [unit] The `zh` locale file defines every `notifications.preferences` key that the `en` locale file defines.

### US-004: Project invites — model, admin routes and invite mail (`Workdir: apps/api`)

- [unit] `generateInviteToken()` returns a `hash` equal to the 64-character lowercase sha256 hex digest of its `raw` value.
- [integration] `POST /projects/:slug/invites` by a project member whose role is not `ADMIN`, and who is not a global ADMIN, responds 403.
- [integration] `POST /projects/:slug/invites` with email ` New@X.io ` and role `DEVELOPER`, when an active user with email `new@x.io` exists, creates a `ProjectMember` row with role `DEVELOPER` for that user.
- [integration] `POST /projects/:slug/invites` for the email of a user who is already a member of the project responds 409.
- [integration] `POST /projects/:slug/invites` for the email of a disabled user responds 409.
- [integration] `POST /projects/:slug/invites` with role `AGENT` responds 400.
- [integration] `POST /projects/:slug/invites` for an email with no account responds 201 with `outcome` `INVITED` and an `invitePath` whose last segment `t` satisfies `hashInviteToken(t)` equal to the stored `ProjectInvite.tokenHash`.
- [integration] A second `POST /projects/:slug/invites` for the same project and email sets the first invite's `status` to `CANCELLED`.
- [integration] `GET /projects/:slug/invites` returns invites with no `token` and no `tokenHash` field.
- [integration] **(seam S3)** With email configured and the registered email delivery channel's `send` spied, `POST /projects/:slug/invites` for a new email invokes `send` once with `recipient` equal to the invite email and a rendered body containing `WEB_PUBLIC_URL` followed by the response's `invitePath`.
- [integration] When the email delivery channel's `send` throws during `POST /projects/:slug/invites`, the response is 201 with `emailed: false`.
- [integration] With email not configured, `POST /projects/:slug/invites` for a new email creates no `EmailSchedule` row.
- [integration] With email configured, `POST /projects/:slug/invites` for an existing active user creates one `MEMBER_ADDED` `EmailSchedule` row with that user's id.
- [unit] `EmailContentBuilder.build` for a `MEMBER_ADDED` row returns data `{ projectName, role, url }` where `role` is the user's `ProjectMember` role and `url` is `WEB_PUBLIC_URL` joined with `/` and the project slug.
- [unit] `EmailContentBuilder.build` for a `MEMBER_ADDED` row returns `{ skip: 'SOURCE_GONE' }` when the project is soft-deleted.

**Out of scope:**
- Concurrent creates for the same project and email: each request cancels then creates atomically, but two simultaneous requests may both leave a `PENDING` invite (best-effort).

### US-005: Public invite preview and accept (`Workdir: apps/api`)

All integration criteria in this story run against an app booted with `REGISTRATION_ENABLED` false.

- [integration] `GET /invites/:token` for a valid pending invite responds 200 with `projectName`, `projectSlug`, `email`, `role`, `inviterName` and `expiresAt`.
- [integration] `GET /invites/:token` responds 404 with an identical response body for an unknown token, an expired invite and a cancelled invite.
- [integration] `POST /invites/:token/accept` with `{ name, password }` creates a user whose email is the invite email and whose global `role` is `MEMBER`.
- [integration] `POST /invites/:token/accept` creates a `ProjectMember` row for the new user with the invite's role.
- [integration] The `accessToken` returned by `POST /invites/:token/accept` authorises `GET /projects/:slug` for the invite's project.
- [integration] A second `POST /invites/:token/accept` with the same token responds 404.
- [integration] Two concurrent `POST /invites/:token/accept` requests with the same token produce exactly one 201 response.
- [integration] After `POST /projects/:slug/invites/:id/resend`, `POST /invites/:token/accept` with the token from before the resend responds 404.
- [integration] `POST /invites/:token/accept` responds 409 when a user with the invite email was created after the invite.
- [integration] After that 409, the invite's `status` is still `PENDING`.
- [integration] `POST /invites/:token/accept` with password `short` responds 400.
- [integration] `POST /projects/:slug/invites/:id/resend` on an `ACCEPTED` invite responds 409.
- [integration] `DELETE /projects/:slug/invites/:id` sets a `PENDING` invite's `status` to `CANCELLED`.
- [integration] `GET /projects/:slug/invites` reports a `PENDING` invite whose `expiresAt` has passed with `status` `EXPIRED`.
- [unit] `PublicInvitesController.preview` and `PublicInvitesController.accept` carry `@Public()` and the same `@Throttle` limit as `AuthController.register`: `AUTH_LOGIN_LIMIT` per 60 000 ms.

**Out of scope:**
- Password hashing parameters are not asserted; accept hashes the password the same way `UsersAdminService.create` does.
- Lockout beyond the `AUTH_LOGIN_LIMIT` throttle on the two public routes.

### US-006: CLI member invite and invites (`Workdir: apps/cli`)

- [unit] **(seam S5)** `koda member invite --email n@x.io --role DEVELOPER` calls `projectInvitesControllerCreate` with `{ path: { slug: <context project> }, body: { email: 'n@x.io', role: 'DEVELOPER' } }`.
- [unit] `koda member invite` prints `Invite created for n@x.io. Share this link (shown once): /invite/abc` when the API returns `outcome` `INVITED` with `emailed` false and `invitePath` `/invite/abc`.
- [unit] `koda member invite` prints `Invite created for n@x.io. Emailed.` when the API returns `outcome` `INVITED` with `emailed` true.
- [unit] `koda member invite` prints `Added n@x.io as DEVELOPER` when the API returns `outcome` `ADDED`.
- [unit] `koda member invite --json` prints the API result as `JSON.stringify(result, null, 2)`.
- [unit] `koda member invites` prints a table with headers `ID`, `Email`, `Role`, `Status`, `Expires` and one row per invite returned by `projectInvitesControllerList`.
- [unit] `koda member invites --cancel i1` calls `projectInvitesControllerCancel` with `{ path: { slug: <context project>, id: 'i1' } }`.
- [unit] `koda member invites --resend i1` calls `projectInvitesControllerResend` with `{ path: { slug: <context project>, id: 'i1' } }`.
- [unit] `koda member invites --resend i1` prints the `invitePath` that `projectInvitesControllerResend` returns.
- [unit] When `projectInvitesControllerCreate` rejects with an API 409, `koda member invite` reports through `handleApiError`, which exits with code 1.

### US-007: Web invite dialog and accept page (`Workdir: apps/web`)

- [unit] Submitting the invite form in `ProjectInvitesPanel` with `new@x.io` and role `DEVELOPER` calls `useProjectInvites(slug).create('new@x.io', 'DEVELOPER')`.
- [unit] After a create result with `outcome` `INVITED`, `ProjectInvitesPanel` shows an element with `data-testid` `invite-link` containing `window.location.origin` joined with the result's `invitePath`.
- [unit] After a create result with `emailed` false, `ProjectInvitesPanel` shows the text of i18n key `projects.invites.notEmailed`.
- [unit] After a create result with `outcome` `ADDED`, `ProjectInvitesPanel` emits `member-added`.
- [unit] After clicking the resend control for invite `i1`, `invite-link` contains the `invitePath` that `resend('i1')` returned.
- [unit] Clicking the cancel control for invite `i1` calls `cancel('i1')` only after `window.confirm` returns true.
- [unit] **(seam S7)** `useProjectInvites(slug).create(email, role)` sends `POST /projects/<slug>/invites` through `useApi()` with body exactly `{ email, role }`.
- [unit] The `/invite/[token]` page requests `GET /invites/<token>` through `useApi()` and renders the returned `projectName`.
- [unit] When `GET /invites/<token>` fails with status 404, the `/invite/[token]` page shows the text of i18n key `invite.invalid`.
- [unit] When `useAuth().isAuthenticated` is true, the `/invite/[token]` page renders an element with `data-testid` `invite-signed-in` in place of the accept form.
- [unit] Submitting `invite-accept-form` with a name and a password calls `useAuth().acceptInvite(<token>, { name, password })`.
- [unit] After `acceptInvite` resolves, the `/invite/[token]` page navigates to `/<projectSlug>`.
- [unit] **(seam S6)** `server/api/invites/[token]/accept.post.ts` calls `setAuthCookies` with the `accessToken` and `refreshToken` returned by `forwardToApi` for `/invites/<token>/accept`.
- [unit] When `acceptInvite` rejects with status 409, the `/invite/[token]` page shows the text of i18n key `invite.accountExists`.
- [unit] `middleware/auth.global.ts` does not redirect an unauthenticated visit to `/invite/abc` to `/login`.
