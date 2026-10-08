# Fleet S4b — Email Delivery and Project Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email delivery of S4a notifications (delayed, only if still unread) and invite-to-project by email, built on
`@nathapp/nestjs-notify` so a later multi-tenant koda changes one constant.

**Architecture:** `nestjs-notify` owns templates, the per-channel email master switch, the delivery log and the send;
koda supplies the SMTP delivery channel, a tenant constant, per-category preferences, an `EmailSchedule` table claimed
by a polling dispatcher (`FOR UPDATE SKIP LOCKED`) for the delay and retries, and a koda `ProjectInvite` model with a
hashed single-use token. Invite email is sent inline from the request (D526); everything else goes through the
schedule.

**Tech Stack:** NestJS 11 + Fastify, Prisma 7.10 (adapter-pg), `@nathapp/nestjs-notify` 1.1.0,
`@nathapp/nestjs-notify-prisma` 1.1.1, `@nathapp/nestjs-notification` 4.1.0 (`SmtpEmailProvider`, nodemailer),
`@nathapp/nestjs-tenant` 1.1.0, `@nestjs/schedule`, Jest, Nuxt 3, Commander 12, Playwright, Mailpit (test compose).

**Spec:** `docs/superpowers/specs/2026-10-08-fleet-s4b-email-and-invites-design.md` (rulings D516-D526). Read it with
this plan; section references below (`§3.3`) point into it.

## Spec refinements (found while planning; the plan wins where they differ)

- R1 (§1): `SmtpDeliveryChannel` constructs `SmtpEmailProvider` directly (`new SmtpEmailProvider({ url, from })`)
  instead of registering `NotificationModule.forRootAsync`, which requires a `templateLoader` koda does not need.
  `nodemailer` (peer of `nestjs-notification`) is added as a dependency.
- R2 (§1): the email delivery channel is **always** registered (`NotifyModule.register` is built at import time,
  before config loads). Without `SMTP_URL` its provider is `null` and `send` throws `PermanentNotificationError`;
  nothing calls it because scheduling, the dispatcher and invite mail are gated on `EmailAvailability.configured`.
- R3 (§1): templates are TypeScript modules (`apps/api/src/email/templates/{en,zh}.ts`), not loose files, so the
  build needs no asset copying and missing `en` codes are a compile error. The seeder runs on every boot
  (idempotent upserts), configured or not.
- R4 (§3.1): the preferences API keeps S4a's `{ items }` envelope (the spec said "array"; it is already an object):
  GET returns `{ emailAvailable, emailEnabled, items: [{ category, inApp, email }] }`; PUT takes
  `{ emailEnabled?, items?: [{ category, inApp?, email? }] }` and returns the GET shape.
- R5 (§4.5): CLI commands join the existing `koda member` group: `koda member invite`, `koda member invites`
  (not `koda project invite`). There is no CLI preferences command today, so none is added.
- R7 (§3.4): the `MEMBER_ADDED` template has no `{{inviterName}}` (data = `projectName`, `role`, `url`); the
  dispatcher builds it at send time from `Project` and `ProjectMember`, and nothing extra is stored on the schedule
  row.
- R6 (§4.4): accepting an invite goes through a Nitro route `server/api/invites/[token]/accept.post.ts` (it must set
  the httpOnly auth cookies, like `server/api/auth/register.post.ts`); `/invite/*` becomes a public route in
  `middleware/auth.global.ts`.

## Global Constraints

- Tenant id: every `nestjs-notify` call and row uses `KODA_TENANT_ID = 'default'` from `apps/api/src/email/koda-tenant.ts`; no other file spells `'default'` for a tenant.
- Channel values are the package's lowercase `NotificationChannel` (`'in_app'`, `'email'`); no `'IN_APP'` literal remains in `apps/api/src`.
- Migration directories: `20261010090000_notify_platform`, `20261010100000_email_schedule`, `20261010110000_project_invites` (after the latest `20261009120000_fleet_health_alerts`).
- Migration SQL: no statement may contain a literal `;` inside it (`test/helpers/migration-schema.ts` splits on `;`).
- Email defaults (D517): `EMAIL_CATEGORY_DEFAULTS = { ASSIGNED: true, MENTIONED: true, FLEET_NEEDS_YOU: true, WATCHED_ACTIVITY: false, FLEET_HEALTH: false }`.
- Delays (D518): `EMAIL_DELAY_SEC` default 300; `EMAIL_APPROVAL_DELAY_SEC` default 60, applied when `Notification.kind === 'approval_requested'`.
- Retries: `EMAIL_MAX_ATTEMPTS` default 5; backoff `2^(attempts-1)` minutes (1, 2, 4, 8); `lockedUntil = now + 2 min`; claim batch 20; tick every 30 000 ms.
- Invite token: 32 random bytes, base64url; stored only as `sha256` hex; `INVITE_TTL_DAYS` default 7 (1-30).
- Never log `SMTP_URL`, a raw invite token, an email body, or a recipient address in a WARN/ERROR line.
- Email links are built only from `WEB_PUBLIC_URL` (config), never from request headers.
- Public invite routes use the same throttle as `/auth/register` (`AUTH_LOGIN_LIMIT` per 60 s).
- API strings via `apps/api/src/i18n/{en,zh}/*.json`; web strings via `apps/web/i18n/locales/{en,zh}.json`.
- Run `bun run generate` (repo root) after any API contract change; never edit `apps/cli/src/generated/`.
- Per-file test command: `cd apps/api && bun run test:scoped <path>`; DB tests need `bun run test:db:up` and `KODA_DB_TESTS=1` (set by `test:integration`; for `test:scoped` export it).
- No `console.log` in API code; comments describe behaviour, no emojis.

## Review Focus

1. **Mixed-case / padded email on invite** (`' New@X.io '` while a legacy `new@x.io` user exists) → treated as the existing user (added, not invited); new invites store `new@x.io`. Test: Task C2 Step 1 `'normalises the email and finds a legacy mixed-case user'`.
2. **`WEB_PUBLIC_URL` with a trailing slash or a path** (`https://koda.x/`) → links must not contain `//invite`. Test: Task A3 Step 1 `'strips one trailing slash from WEB_PUBLIC_URL'`.
3. **Notification title containing markup or template syntax** (`<b>{{url}}</b>`) → HTML body shows it escaped and literal; subject shows it raw and unexpanded. Test: Task A5 Step 1 `'renders a hostile title escaped in html and literal in the subject'`.
4. **The world changes between schedule and send** (notification purged, user disabled, preference flipped, notification read) → skipped with the matching reason, never sent, never retried. Test: Task B4 Step 1 skip cases.
5. **Double-click / replayed accept and a rotated link** → the second accept and the pre-resend link both get the same 404, and no second user is created. Tests: Task C3 Step 1 `'a second accept of the same token is 404'`, `'the token from before a resend is 404'`.

---

# Part A — PR 1: notify platform wiring (spec slice 1)

Branch: `feat/fleet-s4b-1-notify-platform` off `main`. No user-visible behaviour change.

### Task A1: Dependencies, platform module and the DI boot probe

The first task proves the package wiring (spec §7 slice 1, first task) before anything builds on it.

**Files:**
- Modify: `apps/api/package.json` (dependencies)
- Create: `apps/api/src/email/koda-tenant.ts`
- Create: `apps/api/src/email/email-platform.module.ts`
- Test: `apps/api/src/email/notify-wiring.spec.ts`

**Interfaces:**
- Produces: `KODA_TENANT_ID: 'default'`; `EmailPlatformModule` (`@Global()`, exports `TenantContextService`, `CLOCK`, `ID_GENERATOR`).

- [ ] **Step 1: Add dependencies**

```bash
cd apps/api
bun add @nathapp/nestjs-notify@~1.1.0 @nathapp/nestjs-notify-prisma@~1.1.1 @nathapp/nestjs-notification@~4.1.0 @nathapp/nestjs-tenant@1.1.0 @nestjs/event-emitter@^3 nodemailer
bun add -d @types/nodemailer
```

Expected: install succeeds; `bun pm ls | grep -E 'nestjs-notify|nestjs-tenant|event-emitter|nodemailer'` lists them.
`bullmq` / `ioredis` must NOT be added (they are optional peers of `nestjs-queue`, loaded lazily).

- [ ] **Step 2: Write the failing boot probe**

```ts
// apps/api/src/email/notify-wiring.spec.ts
/**
 * Fleet S4b A1: nestjs-notify boots in koda with no tenant context. Real NotifyModule services, in-memory
 * repositories, a fake channel. Proves DI (TenantContextService, CLOCK, ID_GENERATOR) and that a send with
 * tenantId 'default' and no ALS tenant passes the mismatch check.
 */
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DELIVERY_LOG_REPOSITORY, IDeliveryChannel, INotifyService, NOTIFY_SERVICE, NotificationChannel, NotifyModule,
  PREFERENCE_REPOSITORY, SendNotificationPayload, TEMPLATE_REPOSITORY,
} from '@nathapp/nestjs-notify';
import { EmailPlatformModule } from './email-platform.module';
import { KODA_TENANT_ID } from './koda-tenant';

const sent: Array<{ to: string; subject?: string; content: string }> = [];

@Injectable()
class FakeEmailChannel implements IDeliveryChannel {
  readonly channel = NotificationChannel.EMAIL;
  async send(payload: SendNotificationPayload, content: string, subject?: string) {
    sent.push({ to: payload.recipient, subject, content });
    return { providerMessageId: 'm1' };
  }
}

const logs: Array<Record<string, unknown>> = [];

@Global()
@Module({
  providers: [
    { provide: TEMPLATE_REPOSITORY, useValue: {
      findTemplate: async () => ({ id: 't', tenantId: KODA_TENANT_ID, code: 'NOTIFICATION', channel: 'email', locale: 'en',
        subject: 'Hi {{name}}', content: '<p>{{name}}</p>', isActive: true, metadata: {}, createdAt: new Date(), updatedAt: new Date() }),
    } },
    { provide: PREFERENCE_REPOSITORY, useValue: { findByUserAndChannel: async () => null } },
    { provide: DELIVERY_LOG_REPOSITORY, useValue: {
      create: async (log: Record<string, unknown>) => { logs.push(log); return log; },
      updateStatus: async (id: string, _t: string, status: string) => { logs.push({ id, status }); return {}; },
    } },
  ],
  exports: [TEMPLATE_REPOSITORY, PREFERENCE_REPOSITORY, DELIVERY_LOG_REPOSITORY],
})
class FakeRepositoriesModule {}

describe('nestjs-notify wiring (S4b A1)', () => {
  it('boots with EmailPlatformModule and sends with tenant "default" and no tenant context', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EmailPlatformModule,
        FakeRepositoriesModule,
        NotifyModule.register({ deliveryChannels: [{ channel: NotificationChannel.EMAIL, provider: FakeEmailChannel }] }),
      ],
    }).compile();
    const notify = moduleRef.get<INotifyService>(NOTIFY_SERVICE);

    await notify.send({ tenantId: KODA_TENANT_ID, channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION',
      recipient: 'b@x.io', userId: 'u1', data: { name: '<Bea>' } });

    expect(sent).toEqual([{ to: 'b@x.io', subject: 'Hi <Bea>', content: '<p>&lt;Bea&gt;</p>' }]);
    expect(logs.map((l) => l.status)).toEqual(['QUEUED', 'SENT']);
    await moduleRef.close();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/email/notify-wiring.spec.ts`
Expected: FAIL — `Cannot find module './email-platform.module'`.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/email/koda-tenant.ts
/**
 * Fleet S4b D523: koda is single-tenant. Every nestjs-notify row and call uses this id. A multi-tenant koda replaces
 * the call sites with `tenantContext.getTenantId()` after a guard runs `tenantContext.run(tenant)`.
 */
export const KODA_TENANT_ID = 'default';
```

```ts
// apps/api/src/email/email-platform.module.ts
import { Global, Module } from '@nestjs/common';
import { ClockModule, IdGeneratorModule } from '@nathapp/nestjs-common';
import { TenantContextService } from '@nathapp/nestjs-tenant';

/**
 * Fleet S4b §1: what NotifyModule's default services inject but do not provide. TenantContextService is never
 * `run()` in koda, so `getTenantIdOrNull()` is null and the package's tenant-mismatch check is skipped.
 */
@Global()
@Module({
  imports: [ClockModule.register(), IdGeneratorModule.register()],
  providers: [TenantContextService],
  exports: [TenantContextService, ClockModule, IdGeneratorModule],
})
export class EmailPlatformModule {}
```

If `ClockModule.register()` / `IdGeneratorModule.register()` are not exported under those names, check
`node_modules/@nathapp/nestjs-common/dist/index.d.ts` (they live in `dist/clock/` and `dist/id-generator/`, both
global modules) and adjust the import only.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/api && bun run test:scoped src/email/notify-wiring.spec.ts`
Expected: PASS. If `DefaultNotifyService` cannot resolve a dependency, STOP and report the missing token (this probe
is the gate for the whole plan).

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json bun.lock apps/api/src/email/
git commit -m "feat(api): S4b A1 nestjs-notify dependencies and platform module"
```

### Task A2: Schema — package models, category-preference rename, lowercase channels

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261010090000_notify_platform/migration.sql`
- Modify: `apps/api/src/notifications/notification.types.ts:5-6`
- Modify: `apps/api/src/notifications/notification-preferences.service.ts`
- Modify: `apps/api/src/notifications/notification-writer.ts:39`
- Modify: `apps/api/src/notifications/notification-writer.spec.ts`, `notification-preferences.service.spec.ts`
- Test: `apps/api/test/integration/notifications/notify-platform-migration.integration.spec.ts`

**Interfaces:**
- Produces: Prisma models `NotificationCategoryPreference` (delegate `notificationCategoryPreference`), `NotificationPreference`, `DeliveryLog`, `NotificationTemplate` (package); `NOTIFICATION_CHANNELS = ['in_app', 'email']`; `type NotificationChannelValue = 'in_app' | 'email'`.

- [ ] **Step 1: Write the failing migration test**

```ts
// apps/api/test/integration/notifications/notify-platform-migration.integration.spec.ts
/**
 * Fleet S4b §2.1: the S4a preference table is renamed with rows kept and channels lowercased; package tables exist.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/notifications/notify-platform-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20261010090000_notify_platform';

describeIntegration('notify platform migration (S4b §2.1)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'notify_platform_migration', TARGET);
    await scratch.db.$executeRawUnsafe(`INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES ('u1', 'u1@k.t', 'x', CURRENT_TIMESTAMP)`);
    await scratch.db.$executeRawUnsafe(`INSERT INTO "NotificationPreference" ("userId", "category", "channel", "enabled") VALUES ('u1', 'ASSIGNED', 'IN_APP', false)`);
    await applyMigration(scratch.db, TARGET);
  });

  afterAll(async () => { await scratch?.drop(); });

  it('keeps S4a rows under the new table with a lowercase channel', async () => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ userId: string; category: string; channel: string; enabled: boolean }>>(
      `SELECT "userId", "category", "channel", "enabled" FROM "NotificationCategoryPreference"`);
    expect(rows).toEqual([{ userId: 'u1', category: 'ASSIGNED', channel: 'in_app', enabled: false }]);
  });

  it('creates the package tables', async () => {
    const tables = await scratch.db.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename IN ('notification_preferences', 'delivery_logs', 'notification_templates') ORDER BY tablename`);
    expect(tables.map((t) => t.tablename)).toEqual(['delivery_logs', 'notification_preferences', 'notification_templates']);
  });

  it('cascades the renamed table from User', async () => {
    await scratch.db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const [{ n }] = await scratch.db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "NotificationCategoryPreference"`);
    expect(Number(n)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/notifications/notify-platform-migration.integration.spec.ts`
Expected: FAIL — migration directory not found.

- [ ] **Step 3: Edit the schema**

In `apps/api/prisma/schema.prisma`:
- Rename `model NotificationPreference` to `model NotificationCategoryPreference`; change the `channel` comment to `// 'in_app' | 'email' (nestjs-notify NotificationChannel values)`.
- In `model User`, rename `notificationPreferences NotificationPreference[]` to `notificationCategoryPreferences NotificationCategoryPreference[]`.
- Append the three models from `node_modules/@nathapp/nestjs-notify-prisma/prisma/notify.prisma` verbatim, under a
  comment `// === @nathapp/nestjs-notify 1.1 (S4b D523) — copied verbatim, do not edit ===`.

- [ ] **Step 4: Write the migration**

```sql
-- apps/api/prisma/migrations/20261010090000_notify_platform/migration.sql
-- Fleet S4b §2.1: the package owns the NotificationPreference name, so the S4a per-category table is renamed
-- (rows kept) and its channel values become nestjs-notify's lowercase NotificationChannel values.
ALTER TABLE "NotificationPreference" RENAME TO "NotificationCategoryPreference";
ALTER TABLE "NotificationCategoryPreference" RENAME CONSTRAINT "NotificationPreference_pkey" TO "NotificationCategoryPreference_pkey";
ALTER TABLE "NotificationCategoryPreference" RENAME CONSTRAINT "NotificationPreference_userId_fkey" TO "NotificationCategoryPreference_userId_fkey";
UPDATE "NotificationCategoryPreference" SET "channel" = 'in_app' WHERE "channel" = 'IN_APP';

-- @nathapp/nestjs-notify-prisma 1.1.1 prisma/notify.prisma
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_preferences_user_id_tenant_id_channel_key" ON "notification_preferences"("user_id", "tenant_id", "channel");

CREATE TABLE "delivery_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "channel" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "recipient" VARCHAR(512) NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error_message" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "delivery_logs_tenant_id_idx" ON "delivery_logs"("tenant_id");
CREATE INDEX "delivery_logs_recipient_tenant_id_idx" ON "delivery_logs"("recipient", "tenant_id");
CREATE INDEX "delivery_logs_tenant_id_provider_message_id_idx" ON "delivery_logs"("tenant_id", "provider_message_id");

CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" TEXT,
    "locale" TEXT NOT NULL,
    "subject" TEXT,
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_templates_tenant_id_code_locale_channel_key" ON "notification_templates"("tenant_id", "code", "locale", "channel");
CREATE INDEX "notification_templates_tenant_id_idx" ON "notification_templates"("tenant_id");
```

Then confirm the SQL matches what Prisma would generate (no drift): apply migrations to the test DB and diff it
against the schema. Check the exact Prisma 7 flags with `bunx prisma migrate diff --help`; the intent is
`bunx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` with
`DATABASE_URL` pointing at the migrated test DB. Expected: an empty script. If it prints statements (index or
constraint names), copy Prisma's names into the migration and re-run.

- [ ] **Step 5: Lowercase channel code**

```ts
// apps/api/src/notifications/notification.types.ts (replace lines 5-6)
import { NotificationChannel } from '@nathapp/nestjs-notify';

/** S4b D524: nestjs-notify's lowercase channel values. */
export const NOTIFICATION_CHANNELS = [NotificationChannel.IN_APP, NotificationChannel.EMAIL] as const;
export type NotificationChannelValue = (typeof NOTIFICATION_CHANNELS)[number];
```

In `notification-preferences.service.ts`: replace every `this.db.notificationPreference` with
`this.db.notificationCategoryPreference`, every `'IN_APP'` with `NotificationChannel.IN_APP`, the
`NotificationChannel` type import with `NotificationChannelValue`. In `notification-writer.ts:39` pass
`NotificationChannel.IN_APP`. In the two specs replace the expected `'IN_APP'` with `'in_app'`. The old
`NotificationChannel` type export of `notification.types.ts` is gone: fix every importer
(`git grep -n "NotificationChannel" apps/api/src | grep -v nestjs-notify`) to use `NotificationChannelValue` for the
type and the package enum for values. Then:

Run: `cd apps/api && git grep -n "IN_APP'" src` — Expected: no output.
Run: `cd apps/api && bun run db:generate && bunx tsc --noEmit -p tsconfig.json`
Expected: no type errors.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/notifications/notify-platform-migration.integration.spec.ts src/notifications`
Expected: PASS (3 migration tests + all notification unit specs).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/notifications
git commit -m "feat(api): S4b A2 notify schema, rename category preferences, lowercase channels"
```

### Task A3: Email config and `EmailAvailability`

**Files:**
- Create: `apps/api/src/config/email.config.ts`
- Modify: `apps/api/src/config/env.validation.ts` (Joi keys), `apps/api/src/app.module.ts` (`load: [...]`)
- Create: `apps/api/src/email/email-availability.ts`
- Test: `apps/api/src/config/email.config.spec.ts`, `apps/api/src/email/email-availability.spec.ts`

**Interfaces:**
- Produces: `EMAIL_CFG = 'email'`; `interface IEmailConfig { smtpUrl: string | null; from: string | null; webPublicUrl: string | null; delaySec: number; approvalDelaySec: number; maxAttempts: number; inviteTtlDays: number }`; `emailConfig` (registerAs); `EmailAvailability` with `readonly configured: boolean`, `webUrl(path: string): string` (throws when not configured), `config(): IEmailConfig`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/config/email.config.spec.ts
import { emailConfig } from './email.config';

const withEnv = (env: Record<string, string | undefined>) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return emailConfig(); } finally { process.env = saved; }
};

describe('emailConfig (S4b §1)', () => {
  it('is off with defaults when SMTP_URL is unset', () => {
    expect(withEnv({ SMTP_URL: undefined, EMAIL_FROM: undefined, WEB_PUBLIC_URL: undefined })).toEqual({
      smtpUrl: null, from: null, webPublicUrl: null, delaySec: 300, approvalDelaySec: 60, maxAttempts: 5, inviteTtlDays: 7,
    });
  });

  it('requires EMAIL_FROM and WEB_PUBLIC_URL when SMTP_URL is set', () => {
    expect(() => withEnv({ SMTP_URL: 'smtp://u:p@h:25', EMAIL_FROM: undefined, WEB_PUBLIC_URL: 'https://k.x' })).toThrow(/EMAIL_FROM/);
    expect(() => withEnv({ SMTP_URL: 'smtp://u:p@h:25', EMAIL_FROM: 'k@x', WEB_PUBLIC_URL: undefined })).toThrow(/WEB_PUBLIC_URL/);
  });

  it('strips one trailing slash from WEB_PUBLIC_URL (Review Focus 2)', () => {
    expect(withEnv({ SMTP_URL: 'smtp://h', EMAIL_FROM: 'k@x', WEB_PUBLIC_URL: 'https://koda.x/' }).webPublicUrl).toBe('https://koda.x');
  });

  it('rejects a non-http WEB_PUBLIC_URL and out-of-range numbers', () => {
    expect(() => withEnv({ SMTP_URL: 'smtp://h', EMAIL_FROM: 'k@x', WEB_PUBLIC_URL: 'koda.x' })).toThrow(/WEB_PUBLIC_URL/);
    expect(() => withEnv({ INVITE_TTL_DAYS: '31' })).toThrow(/INVITE_TTL_DAYS/);
    expect(() => withEnv({ EMAIL_MAX_ATTEMPTS: '0' })).toThrow(/EMAIL_MAX_ATTEMPTS/);
  });

  it('never puts SMTP_URL in an error message', () => {
    try { withEnv({ SMTP_URL: 'smtp://user:s3cret@h', EMAIL_FROM: undefined, WEB_PUBLIC_URL: 'https://k.x' }); } catch (e) {
      expect(String(e)).not.toContain('s3cret');
    }
  });
});
```

```ts
// apps/api/src/email/email-availability.spec.ts
import { EmailAvailability } from './email-availability';

const cfg = (over = {}) => ({ smtpUrl: 'smtp://h', from: 'k@x', webPublicUrl: 'https://k.x', delaySec: 300, approvalDelaySec: 60, maxAttempts: 5, inviteTtlDays: 7, ...over });
const svc = (c: object) => new EmailAvailability({ get: () => c } as never);

describe('EmailAvailability', () => {
  it('is configured only with an SMTP url', () => {
    expect(svc(cfg()).configured).toBe(true);
    expect(svc(cfg({ smtpUrl: null })).configured).toBe(false);
  });
  it('joins web paths without a double slash', () => {
    expect(svc(cfg()).webUrl('/invite/abc')).toBe('https://k.x/invite/abc');
  });
  it('throws building a link when not configured', () => {
    expect(() => svc(cfg({ smtpUrl: null, webPublicUrl: null })).webUrl('/x')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun run test:scoped src/config/email.config.spec.ts src/email/email-availability.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/config/email.config.ts
import { registerAs } from '@nestjs/config';

export const EMAIL_CFG = 'email';

export interface IEmailConfig {
  smtpUrl: string | null;
  from: string | null;
  webPublicUrl: string | null;
  delaySec: number;
  approvalDelaySec: number;
  maxAttempts: number;
  inviteTtlDays: number;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function webUrlEnv(): string | null {
  const raw = process.env['WEB_PUBLIC_URL']?.trim();
  if (!raw) return null;
  if (!/^https?:\/\/[^/\s]+/i.test(raw)) throw new Error('WEB_PUBLIC_URL must be an absolute http(s) URL');
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Fleet S4b §1: SMTP_URL unset means email is off (D520). With SMTP_URL, EMAIL_FROM and WEB_PUBLIC_URL are
 * required. Error messages name the variable, never its value (SMTP_URL carries credentials).
 */
export const emailConfig = registerAs(EMAIL_CFG, (): IEmailConfig => {
  const smtpUrl = process.env['SMTP_URL']?.trim() || null;
  const from = process.env['EMAIL_FROM']?.trim() || null;
  const webPublicUrl = webUrlEnv();
  if (smtpUrl && !from) throw new Error('EMAIL_FROM is required when SMTP_URL is set');
  if (smtpUrl && !webPublicUrl) throw new Error('WEB_PUBLIC_URL is required when SMTP_URL is set');
  return {
    smtpUrl,
    from,
    webPublicUrl,
    delaySec: intEnv('EMAIL_DELAY_SEC', 300, 0, 86_400),
    approvalDelaySec: intEnv('EMAIL_APPROVAL_DELAY_SEC', 60, 0, 86_400),
    maxAttempts: intEnv('EMAIL_MAX_ATTEMPTS', 5, 1, 20),
    inviteTtlDays: intEnv('INVITE_TTL_DAYS', 7, 1, 30),
  };
});
```

In `env.validation.ts` add, next to `NOTIFICATION_RETENTION_DAYS`:

```ts
  // Fleet S4b §1 (email.config.ts enforces the SMTP_URL-dependent requirements).
  SMTP_URL: Joi.string().optional(),
  EMAIL_FROM: Joi.string().optional(),
  WEB_PUBLIC_URL: Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
  EMAIL_DELAY_SEC: Joi.number().integer().min(0).optional(),
  EMAIL_APPROVAL_DELAY_SEC: Joi.number().integer().min(0).optional(),
  EMAIL_MAX_ATTEMPTS: Joi.number().integer().min(1).optional(),
  INVITE_TTL_DAYS: Joi.number().integer().min(1).max(30).optional(),
```

In `app.module.ts` add `emailConfig` to `ConfigModule.forRoot({ load: [...] })`.

```ts
// apps/api/src/email/email-availability.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_CFG, IEmailConfig } from '../config/email.config';

/** Fleet S4b D520: the single switch every email path checks. */
@Injectable()
export class EmailAvailability {
  constructor(private readonly configService: ConfigService) {}

  config(): IEmailConfig {
    return this.configService.get<IEmailConfig>(EMAIL_CFG) as IEmailConfig;
  }

  get configured(): boolean {
    return this.config().smtpUrl !== null;
  }

  /** Absolute link for an email, from WEB_PUBLIC_URL only (never request headers). */
  webUrl(path: string): string {
    const base = this.config().webPublicUrl;
    if (!base) throw new Error('WEB_PUBLIC_URL is not configured');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bun run test:scoped src/config/email.config.spec.ts src/email/email-availability.spec.ts src/config`
Expected: PASS (including existing config specs).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config apps/api/src/email apps/api/src/app.module.ts
git commit -m "feat(api): S4b A3 email config and availability switch"
```

### Task A4: `SmtpDeliveryChannel`

**Files:**
- Create: `apps/api/src/email/smtp-delivery.channel.ts`
- Test: `apps/api/src/email/smtp-delivery.channel.spec.ts`

**Interfaces:**
- Consumes: `EmailAvailability` (A3).
- Produces: `SMTP_EMAIL_PROVIDER` (DI token, value `EmailProvider | null`); `smtpEmailProviderFactory(availability): EmailProvider | null`; `SmtpDeliveryChannel implements IDeliveryChannel` with `channel = 'email'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/email/smtp-delivery.channel.spec.ts
import { PermanentNotificationError } from '@nathapp/nestjs-notify';
import { SmtpDeliveryChannel } from './smtp-delivery.channel';

const payload = { tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', recipient: 'b@x.io' };

describe('SmtpDeliveryChannel (S4b §1)', () => {
  it('sends the rendered subject and html and returns the message id', async () => {
    const provider = { send: jest.fn(async () => ({ success: true, requestId: 'mid-1' })) };
    const channel = new SmtpDeliveryChannel(provider as never);
    await expect(channel.send(payload, '<p>hi</p>', 'Subj')).resolves.toEqual({ providerMessageId: 'mid-1' });
    expect(provider.send).toHaveBeenCalledWith({ recipient: 'b@x.io', subject: 'Subj', message: '<p>hi</p>' });
  });

  it('throws a retryable Error when the provider reports failure', async () => {
    const provider = { send: jest.fn(async () => ({ success: false, message: 'ECONNREFUSED' })) };
    const err = await new SmtpDeliveryChannel(provider as never).send(payload, 'x', 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentNotificationError);
    expect((err as Error).message).toContain('ECONNREFUSED');
  });

  it('throws a permanent error for a rejected recipient (SMTP 55x)', async () => {
    const provider = { send: jest.fn(async () => ({ success: false, message: '550 5.1.1 mailbox unavailable' })) };
    await expect(new SmtpDeliveryChannel(provider as never).send(payload, 'x', 's')).rejects.toBeInstanceOf(PermanentNotificationError);
  });

  it('throws a permanent error when email is not configured', async () => {
    await expect(new SmtpDeliveryChannel(null).send(payload, 'x', 's')).rejects.toBeInstanceOf(PermanentNotificationError);
  });

  it('uses an empty subject when the template has none', async () => {
    const provider = { send: jest.fn(async () => ({ success: true })) };
    await new SmtpDeliveryChannel(provider as never).send(payload, 'x');
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ subject: '' }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun run test:scoped src/email/smtp-delivery.channel.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/email/smtp-delivery.channel.ts
import { Inject, Injectable } from '@nestjs/common';
import { EmailProvider, SmtpEmailProvider } from '@nathapp/nestjs-notification';
import {
  DeliverySendResult, IDeliveryChannel, NotificationChannel, PermanentNotificationError, SendNotificationPayload,
} from '@nathapp/nestjs-notify';
import { EmailAvailability } from './email-availability';

export const SMTP_EMAIL_PROVIDER = Symbol('SMTP_EMAIL_PROVIDER');

/** S4b R1: the SMTP provider is built directly; null when SMTP_URL is unset (R2). */
export function smtpEmailProviderFactory(availability: EmailAvailability): EmailProvider | null {
  const cfg = availability.config();
  if (!cfg.smtpUrl || !cfg.from) return null;
  return new SmtpEmailProvider({ url: cfg.smtpUrl, from: cfg.from });
}

/** A 5xx SMTP reply about the recipient will not succeed on retry. */
const PERMANENT_SMTP = /\b55[0-4]\b/;

/**
 * Fleet S4b §1: nestjs-notify delivery channel for 'email'. Receives the already-rendered subject and html.
 * A failed send throws so the package logs FAILED and the caller decides on retry.
 */
@Injectable()
export class SmtpDeliveryChannel implements IDeliveryChannel {
  readonly channel = NotificationChannel.EMAIL;

  constructor(@Inject(SMTP_EMAIL_PROVIDER) private readonly provider: EmailProvider | null) {}

  async send(payload: SendNotificationPayload, content: string, subject?: string): Promise<DeliverySendResult> {
    if (!this.provider) throw new PermanentNotificationError('email is not configured');
    const result = await this.provider.send({ recipient: payload.recipient, subject: subject ?? '', message: content });
    if (result.success) return { providerMessageId: result.requestId };
    const message = result.message ?? 'email send failed';
    if (PERMANENT_SMTP.test(message)) throw new PermanentNotificationError(message);
    throw new Error(message);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun run test:scoped src/email/smtp-delivery.channel.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/email
git commit -m "feat(api): S4b A4 SMTP delivery channel"
```

### Task A5: Templates, seeder, `EmailModule`, real-repository integration test

**Files:**
- Create: `apps/api/src/email/templates/template-codes.ts`, `templates/en.ts`, `templates/zh.ts`
- Create: `apps/api/src/email/email-template.seeder.ts`
- Create: `apps/api/src/email/email.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `EmailModule`)
- Test: `apps/api/src/email/email-template.seeder.spec.ts`, `apps/api/src/email/templates/templates.spec.ts`
- Test: `apps/api/test/integration/email/notify-send.integration.spec.ts`

**Interfaces:**
- Consumes: A1-A4.
- Produces: `EMAIL_TEMPLATE_CODES = ['NOTIFICATION', 'INVITE', 'MEMBER_ADDED'] as const`, `type EmailTemplateCode`; `EmailModule` (exports `EmailAvailability`, re-exports `NOTIFY_SERVICE` and `PREFERENCE_SERVICE` via the global `NotifyModule`); `EmailTemplateSeeder.seed(): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/email/templates/templates.spec.ts
import { SimpleTemplateEngine } from '@nathapp/nestjs-notify';
import { EMAIL_TEMPLATE_CODES } from './template-codes';
import { EN_TEMPLATES } from './en';
import { ZH_TEMPLATES } from './zh';

const html = new SimpleTemplateEngine();
const plain = new SimpleTemplateEngine({ escapeHtml: false });

describe('email templates (S4b §3.4)', () => {
  it('defines every code in en', () => {
    expect(Object.keys(EN_TEMPLATES).sort()).toEqual([...EMAIL_TEMPLATE_CODES].sort());
  });

  it('renders a hostile title escaped in html and literal in the subject (Review Focus 3)', () => {
    const t = EN_TEMPLATES.NOTIFICATION;
    const data = { title: '<b>{{url}}</b>', body: '', url: 'https://k.x/a', prefsUrl: 'https://k.x/settings/notifications' };
    expect(plain.compile(t.subject)(data)).toBe('[koda] <b>{{url}}</b>');
    const out = html.compile(t.html)(data);
    expect(out).toContain('&lt;b&gt;{{url}}&lt;/b&gt;');
    expect(out).not.toContain('<b>');
    expect(out).toContain('https://k.x/settings/notifications');
  });

  it('zh entries, when present, use the same placeholders as en', () => {
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const [code, tpl] of Object.entries(ZH_TEMPLATES)) {
      const en = EN_TEMPLATES[code as keyof typeof EN_TEMPLATES];
      expect(vars(tpl.html)).toEqual(vars(en.html));
    }
  });
});
```

```ts
// apps/api/src/email/email-template.seeder.spec.ts
import { EmailTemplateSeeder } from './email-template.seeder';
import { EMAIL_TEMPLATE_CODES } from './templates/template-codes';

function setup(existing: Record<string, { id: string; subject: string; content: string }> = {}) {
  const repo = { findTemplate: jest.fn(async (code: string, locale: string) => existing[`${code}:${locale}`] ?? null) };
  const service = { create: jest.fn(async (x: unknown) => x), update: jest.fn(async (x: unknown) => x) };
  return { seeder: new EmailTemplateSeeder(repo as never, service as never), repo, service };
}

describe('EmailTemplateSeeder (S4b §1, R3)', () => {
  it('creates en and zh for every code with tenant default and channel email', async () => {
    const { seeder, service } = setup();
    await seeder.seed();
    expect(service.create).toHaveBeenCalledTimes(EMAIL_TEMPLATE_CODES.length * 2);
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'default', channel: 'email', locale: 'zh', code: 'INVITE' }));
  });

  it('updates only templates whose text changed (idempotent)', async () => {
    const { seeder, service } = setup();
    await seeder.seed();
    const created = service.create.mock.calls.map(([c]) => c as { code: string; locale: string; subject: string; content: string });
    const existing = Object.fromEntries(created.map((c, i) => [`${c.code}:${c.locale}`, { id: `t${i}`, subject: c.subject, content: c.content }]));
    existing['INVITE:en'] = { ...existing['INVITE:en'], content: 'old' };
    const second = setup(existing);
    await second.seeder.seed();
    expect(second.service.create).not.toHaveBeenCalled();
    expect(second.service.update).toHaveBeenCalledTimes(1);
    expect(second.service.update).toHaveBeenCalledWith(existing['INVITE:en'].id, 'default', expect.objectContaining({ content: expect.not.stringMatching(/^old$/) }));
  });

  it('falls back to en text for a code missing from zh', async () => {
    const { seeder, service } = setup();
    await seeder.seed();
    const zhInvite = service.create.mock.calls.map(([c]) => c as { code: string; locale: string; content: string })
      .find((c) => c.code === 'MEMBER_ADDED' && c.locale === 'zh');
    expect(zhInvite?.content).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun run test:scoped src/email`
Expected: FAIL — template modules and seeder not found.

- [ ] **Step 3: Implement templates**

```ts
// apps/api/src/email/templates/template-codes.ts
export const EMAIL_TEMPLATE_CODES = ['NOTIFICATION', 'INVITE', 'MEMBER_ADDED'] as const;
export type EmailTemplateCode = (typeof EMAIL_TEMPLATE_CODES)[number];
export interface EmailTemplateText { subject: string; html: string }
export const EMAIL_LOCALES = ['en', 'zh'] as const;
```

```ts
// apps/api/src/email/templates/en.ts
import type { EmailTemplateCode, EmailTemplateText } from './template-codes';

const footer = '<p style="color:#666;font-size:12px">You received this because of your koda notification settings. '
  + '<a href="{{prefsUrl}}">Manage email preferences</a></p>';

/** Fleet S4b §3.4. Placeholders are {{name}}; values are HTML-escaped in html, raw in the subject. */
export const EN_TEMPLATES: Record<EmailTemplateCode, EmailTemplateText> = {
  NOTIFICATION: {
    subject: '[koda] {{title}}',
    html: '<p><strong>{{title}}</strong></p><p>{{body}}</p><p><a href="{{url}}">Open in koda</a></p>' + footer,
  },
  INVITE: {
    subject: '[koda] {{inviterName}} invited you to {{projectName}}',
    html: '<p>{{inviterName}} invited you to join <strong>{{projectName}}</strong> on koda as {{role}}.</p>'
      + '<p><a href="{{url}}">Accept the invite</a></p><p>This link works once and expires on {{expiresAt}}.</p>',
  },
  MEMBER_ADDED: {
    subject: '[koda] You were added to {{projectName}}',
    html: '<p>You were added to <strong>{{projectName}}</strong> on koda as {{role}}.</p>'
      + '<p><a href="{{url}}">Open the project</a></p>',
  },
};
```

```ts
// apps/api/src/email/templates/zh.ts
import type { EmailTemplateCode, EmailTemplateText } from './template-codes';

const footer = '<p style="color:#666;font-size:12px">此邮件依据你的 koda 通知设置发送。<a href="{{prefsUrl}}">管理邮件偏好</a></p>';

/** Fleet S4b §3.4: zh is partial by design; missing codes are seeded from en. */
export const ZH_TEMPLATES: Partial<Record<EmailTemplateCode, EmailTemplateText>> = {
  NOTIFICATION: {
    subject: '[koda] {{title}}',
    html: '<p><strong>{{title}}</strong></p><p>{{body}}</p><p><a href="{{url}}">在 koda 中打开</a></p>' + footer,
  },
  INVITE: {
    subject: '[koda] {{inviterName}} 邀请你加入 {{projectName}}',
    html: '<p>{{inviterName}} 邀请你以 {{role}} 身份加入 koda 项目 <strong>{{projectName}}</strong>。</p>'
      + '<p><a href="{{url}}">接受邀请</a></p><p>此链接仅可使用一次，于 {{expiresAt}} 过期。</p>',
  },
};
```

- [ ] **Step 4: Implement the seeder and module**

```ts
// apps/api/src/email/email-template.seeder.ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ITemplateRepository, ITemplateService, NotificationChannel, TEMPLATE_REPOSITORY, TEMPLATE_SERVICE } from '@nathapp/nestjs-notify';
import { KODA_TENANT_ID } from './koda-tenant';
import { EMAIL_LOCALES, EMAIL_TEMPLATE_CODES } from './templates/template-codes';
import { EN_TEMPLATES } from './templates/en';
import { ZH_TEMPLATES } from './templates/zh';

const BY_LOCALE = { en: EN_TEMPLATES, zh: ZH_TEMPLATES } as const;

/** Fleet S4b R3: templates live in git; each boot upserts them into nestjs-notify's table for KODA_TENANT_ID. */
@Injectable()
export class EmailTemplateSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmailTemplateSeeder.name);

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly repo: ITemplateRepository,
    @Inject(TEMPLATE_SERVICE) private readonly templates: ITemplateService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const changed = await this.seed();
    if (changed > 0) this.logger.log(`Seeded ${changed} email template(s)`);
  }

  /** Returns how many rows were created or updated. */
  async seed(): Promise<number> {
    let changed = 0;
    for (const locale of EMAIL_LOCALES) {
      for (const code of EMAIL_TEMPLATE_CODES) {
        const text = BY_LOCALE[locale][code] ?? EN_TEMPLATES[code];
        const current = await this.repo.findTemplate(code, locale, KODA_TENANT_ID, NotificationChannel.EMAIL);
        if (!current) {
          await this.templates.create({ tenantId: KODA_TENANT_ID, code, locale, channel: NotificationChannel.EMAIL, subject: text.subject, content: text.html });
          changed += 1;
        } else if (current.subject !== text.subject || current.content !== text.html) {
          await this.templates.update(current.id, KODA_TENANT_ID, { subject: text.subject, content: text.html });
          changed += 1;
        }
      }
    }
    return changed;
  }
}
```

```ts
// apps/api/src/email/email.module.ts
import { Global, Module } from '@nestjs/common';
import { NotificationChannel, NotifyModule } from '@nathapp/nestjs-notify';
import { NotifyPrismaModule } from '@nathapp/nestjs-notify-prisma';
import { EmailAvailability } from './email-availability';
import { EmailPlatformModule } from './email-platform.module';
import { EmailTemplateSeeder } from './email-template.seeder';
import { SMTP_EMAIL_PROVIDER, SmtpDeliveryChannel, smtpEmailProviderFactory } from './smtp-delivery.channel';

/**
 * SmtpDeliveryChannel is instantiated inside NotifyModule, so its provider token must be globally visible.
 * Global so every module can inject EmailAvailability without importing EmailModule.
 */
@Global()
@Module({
  providers: [
    EmailAvailability,
    { provide: SMTP_EMAIL_PROVIDER, useFactory: smtpEmailProviderFactory, inject: [EmailAvailability] },
  ],
  exports: [EmailAvailability, SMTP_EMAIL_PROVIDER],
})
export class EmailCoreModule {}

/**
 * Fleet S4b §1: nestjs-notify (global) + Prisma repositories + koda's SMTP channel. The channel is always
 * registered (R2); callers gate on EmailAvailability.configured.
 */
@Module({
  imports: [
    EmailPlatformModule,
    EmailCoreModule,
    NotifyPrismaModule.register(),
    NotifyModule.register({ deliveryChannels: [{ channel: NotificationChannel.EMAIL, provider: SmtpDeliveryChannel }] }),
  ],
  providers: [EmailTemplateSeeder],
})
export class EmailModule {}
```

Add `EmailModule` to `AppModule.imports` after `NotificationsModule`. Task B1 adds `EmailScheduleRepository` to
`EmailCoreModule` (providers + exports) so it is global too.

- [ ] **Step 5: Write the real-repository integration test**

```ts
// apps/api/test/integration/email/notify-send.integration.spec.ts
/**
 * Fleet S4b A5: booted AppModule — seeder wrote the templates; NotifyService.send renders from the DB and records a
 * DeliveryLog through the real Prisma repositories. The SMTP provider is replaced by a fake.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/email/notify-send.integration.spec.ts
 */
import { Test } from '@nestjs/testing';
import { INotifyService, NOTIFY_SERVICE } from '@nathapp/nestjs-notify';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AppModule } from '../../../src/app.module';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { SMTP_EMAIL_PROVIDER } from '../../../src/email/smtp-delivery.channel';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30_000);

describeIntegration('nestjs-notify send on PG (S4b A5)', () => {
  const sent: Array<{ recipient: string; subject: string; message: string }> = [];
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let notify: INotifyService;

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMTP_EMAIL_PROVIDER)
      .useValue({ send: async (m: { recipient: string; subject: string; message: string }) => { sent.push(m); return { success: true, requestId: 'r1' }; } })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
    prisma = app.get(PrismaService).client as PrismaClient;
    notify = app.get(NOTIFY_SERVICE);
  });

  afterAll(async () => { await close?.(); });

  it('seeded 6 templates for tenant default', async () => {
    expect(await prisma.notificationTemplate.count({ where: { tenantId: 'default', channel: 'email' } })).toBe(6);
  });

  it('renders from the DB template and logs SENT', async () => {
    await notify.send({ tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', locale: 'en', recipient: 'b@x.io',
      data: { title: 'KODA-1 assigned to you', body: '', url: 'https://k.x/koda/tickets/KODA-1', prefsUrl: 'https://k.x/settings/notifications' } });
    expect(sent.at(-1)).toMatchObject({ recipient: 'b@x.io', subject: '[koda] KODA-1 assigned to you' });
    const log = await prisma.deliveryLog.findFirst({ where: { recipient: 'b@x.io' } });
    expect(log).toMatchObject({ tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', status: 'SENT', providerMessageId: 'r1' });
  });

  it('skips silently when the package email preference is off', async () => {
    const before = sent.length;
    await prisma.notificationPreference.create({ data: { userId: 'u-off', tenantId: 'default', channel: 'email', enabled: false } });
    await notify.send({ tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', recipient: 'off@x.io', userId: 'u-off', data: { title: 't', body: '', url: 'u', prefsUrl: 'p' } });
    expect(sent.length).toBe(before);
  });
});
```

If `test/helpers/http-app.ts` (`AppFactory`) is the established boot for full-app tests and `createNestApplication`
misbehaves with Fastify, boot with `bootHttpApp({ registrationEnabled: false })` after setting a module override is
not possible there; in that case keep `Test.createTestingModule` and use `moduleRef.createNestApplication(new FastifyAdapter())`.

- [ ] **Step 6: Run everything**

Run: `cd apps/api && bun run test:scoped src/email && KODA_DB_TESTS=1 bun run test:scoped test/integration/email/notify-send.integration.spec.ts`
Expected: PASS.
Run: `cd apps/api && bun run test && bunx tsc --noEmit -p tsconfig.json && bun run lint`
Expected: all green (the app now boots `EmailModule` in every app-level spec).

- [ ] **Step 7: Commit and open PR 1**

```bash
git add apps/api
git commit -m "feat(api): S4b A5 email templates, seeder and EmailModule"
bun run generate   # openapi unchanged in Part A; commit only if it changed
git push -u origin feat/fleet-s4b-1-notify-platform
gh pr create --title "feat(api): S4b PR 1 — nestjs-notify platform wiring" --body "Spec slice 1 (D523-D524). No user-visible change. Refs S4b spec."
```

Before pushing: run a fresh code review (CLAUDE rules: review before push). After merge: deploy koda-wk (migration;
backup first) and append the §9.x status note.

---

# Part B — PR 2: notification email (spec slice 2)

Branch: `feat/fleet-s4b-2-notification-email` off `main` after PR 1 merges.

### Task B1: `EmailSchedule` model and repository

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model from spec §2.2 + `Notification.emailSchedule EmailSchedule?` back-relation)
- Create: `apps/api/prisma/migrations/20261010100000_email_schedule/migration.sql`
- Create: `apps/api/src/email/schedule/email-schedule.types.ts`
- Create: `apps/api/src/email/schedule/email-schedule.repository.ts`
- Test: `apps/api/test/integration/email/email-schedule-repository.integration.spec.ts`

**Interfaces:**
- Produces:
  - `type EmailKind = 'NOTIFICATION' | 'INVITE' | 'MEMBER_ADDED'`; `type EmailStatus = 'PENDING' | 'SENDING' | 'SENT' | 'SKIPPED' | 'FAILED'`; `type SkipReason = 'READ' | 'EMAIL_OFF' | 'CATEGORY_OFF' | 'USER_DISABLED' | 'SOURCE_GONE'`.
  - `interface EmailScheduleRow { id; kind: EmailKind; notificationId: string | null; inviteId: string | null; userId: string | null; projectId: string | null; toEmail: string; locale: string; attempts: number; dueAt: Date }`.
  - `EmailScheduleRepository`:
    - `scheduleNotifications(rows: ReadonlyArray<{ notificationId: string; userId: string; toEmail: string; dueAt: Date }>): Promise<number>` (createMany skipDuplicates)
    - `scheduleMemberAdded(input: { userId: string; projectId: string; toEmail: string; locale: string; dueAt: Date }): Promise<void>`
    - `startInviteSend(input: { inviteId: string; toEmail: string; locale: string; now: Date }): Promise<string>` (row id; status SENDING, attempts 1, lockedUntil now+2m)
    - `claimDue(now: Date, limit: number): Promise<EmailScheduleRow[]>` (kinds NOTIFICATION|MEMBER_ADDED only)
    - `closeAbandonedInvites(now: Date): Promise<number>`
    - `markSent(id: string, now: Date): Promise<void>`, `markSkipped(id: string, reason: SkipReason): Promise<void>`, `markFailed(id: string, error: string): Promise<void>`, `retryAt(id: string, dueAt: Date, error: string): Promise<void>`
    - `purgeFinal(before: Date): Promise<number>`

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/email/email-schedule-repository.integration.spec.ts
/**
 * Fleet S4b §2.2/§3.3: claim is exclusive under concurrency, skips invites and future rows, recovers stuck rows.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/email/email-schedule-repository.integration.spec.ts
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { EmailScheduleRepository } from '../../../src/email/schedule/email-schedule.repository';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30_000);
const T0 = new Date('2026-10-10T10:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describeIntegration('EmailScheduleRepository (PG)', () => {
  let prisma: PrismaClient;
  let repo: EmailScheduleRepository;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await resetDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
    prisma = app.get(PrismaService).client as PrismaClient;
    repo = app.get(EmailScheduleRepository);
  });
  afterAll(async () => { await close?.(); });
  beforeEach(async () => { await prisma.emailSchedule.deleteMany(); });

  const row = (over: Record<string, unknown>) => prisma.emailSchedule.create({
    data: { kind: 'MEMBER_ADDED', toEmail: 'a@x.io', dueAt: min(0), ...over } as never,
  });

  it('two concurrent claims never return the same row', async () => {
    for (let i = 0; i < 30; i++) await row({ toEmail: `u${i}@x.io` });
    const [a, b] = await Promise.all([repo.claimDue(min(1), 20), repo.claimDue(min(1), 20)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(30);
  });

  it('does not claim future rows or INVITE rows, and claims SENDING rows whose lock expired', async () => {
    const future = await row({ dueAt: min(10) });
    const invite = await row({ kind: 'INVITE', status: 'SENDING', lockedUntil: min(-5) });
    const stuck = await row({ status: 'SENDING', lockedUntil: min(-1), attempts: 1 });
    const claimed = await repo.claimDue(min(1), 20);
    expect(claimed.map((r) => r.id)).toEqual([stuck.id]);
    expect(claimed[0].attempts).toBe(2);
    expect((await prisma.emailSchedule.findUnique({ where: { id: future.id } }))?.status).toBe('PENDING');
    expect((await prisma.emailSchedule.findUnique({ where: { id: invite.id } }))?.status).toBe('SENDING');
  });

  it('closes abandoned invite sends as FAILED', async () => {
    const invite = await row({ kind: 'INVITE', status: 'SENDING', lockedUntil: min(-1) });
    expect(await repo.closeAbandonedInvites(min(0))).toBe(1);
    expect(await prisma.emailSchedule.findUnique({ where: { id: invite.id } })).toMatchObject({ status: 'FAILED', lastError: 'abandoned' });
  });

  it('retryAt returns the row to PENDING with a truncated error', async () => {
    const r = await row({ status: 'SENDING' });
    await repo.retryAt(r.id, min(4), 'x'.repeat(2000));
    const after = await prisma.emailSchedule.findUnique({ where: { id: r.id } });
    expect(after).toMatchObject({ status: 'PENDING', dueAt: min(4), lockedUntil: null });
    expect(after?.lastError?.length).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/email/email-schedule-repository.integration.spec.ts`
Expected: FAIL — repository module not found.

- [ ] **Step 3: Schema + migration**

Add the spec §2.2 model to `schema.prisma` and `emailSchedule EmailSchedule?` to `model Notification`. Write
`20261010100000_email_schedule/migration.sql` with the `CREATE TABLE "EmailSchedule"`, the unique index on
`"notificationId"`, the `("status", "dueAt")` index and the FK to `"Notification"("id") ON DELETE CASCADE`. Use the
drift check from Task A2 Step 4 until it prints nothing.

- [ ] **Step 4: Implement types and repository**

```ts
// apps/api/src/email/schedule/email-schedule.types.ts
export type EmailKind = 'NOTIFICATION' | 'INVITE' | 'MEMBER_ADDED';
export type EmailStatus = 'PENDING' | 'SENDING' | 'SENT' | 'SKIPPED' | 'FAILED';
export type SkipReason = 'READ' | 'EMAIL_OFF' | 'CATEGORY_OFF' | 'USER_DISABLED' | 'SOURCE_GONE';
export const LOCK_MS = 2 * 60_000;
export const LAST_ERROR_MAX = 500;

export interface EmailScheduleRow {
  id: string;
  kind: EmailKind;
  notificationId: string | null;
  inviteId: string | null;
  userId: string | null;
  projectId: string | null;
  toEmail: string;
  locale: string;
  attempts: number;
  dueAt: Date;
}
```

```ts
// apps/api/src/email/schedule/email-schedule.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../generated/prisma/client';
import { EmailScheduleRow, LAST_ERROR_MAX, LOCK_MS, SkipReason } from './email-schedule.types';

/** Fleet S4b §2.2: timing, claiming and retry of outgoing email. What was sent is nestjs-notify's DeliveryLog. */
@Injectable()
export class EmailScheduleRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async scheduleNotifications(rows: ReadonlyArray<{ notificationId: string; userId: string; toEmail: string; dueAt: Date }>): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await this.db.emailSchedule.createMany({
      data: rows.map((r) => ({ kind: 'NOTIFICATION', notificationId: r.notificationId, userId: r.userId, toEmail: r.toEmail, dueAt: r.dueAt })),
      skipDuplicates: true,
    });
    return count;
  }

  async scheduleMemberAdded(input: { userId: string; projectId: string; toEmail: string; locale: string; dueAt: Date }): Promise<void> {
    await this.db.emailSchedule.create({ data: { kind: 'MEMBER_ADDED', ...input } });
  }

  async startInviteSend(input: { inviteId: string; toEmail: string; locale: string; now: Date }): Promise<string> {
    const row = await this.db.emailSchedule.create({
      data: { kind: 'INVITE', inviteId: input.inviteId, toEmail: input.toEmail, locale: input.locale, status: 'SENDING',
        attempts: 1, dueAt: input.now, lockedUntil: new Date(input.now.getTime() + LOCK_MS) },
      select: { id: true },
    });
    return row.id;
  }

  /** One statement: due PENDING rows plus SENDING rows whose lock expired; INVITE rows are never claimed (D526). */
  async claimDue(now: Date, limit: number): Promise<EmailScheduleRow[]> {
    const lockedUntil = new Date(now.getTime() + LOCK_MS);
    return this.db.$queryRaw<EmailScheduleRow[]>`
      UPDATE "EmailSchedule" SET "status" = 'SENDING', "lockedUntil" = ${lockedUntil}, "attempts" = "attempts" + 1, "updatedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "EmailSchedule"
        WHERE "kind" IN ('NOTIFICATION', 'MEMBER_ADDED')
          AND (("status" = 'PENDING' AND "dueAt" <= ${now}) OR ("status" = 'SENDING' AND "lockedUntil" < ${now}))
        ORDER BY "dueAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "notificationId", "inviteId", "userId", "projectId", "toEmail", "locale", "attempts", "dueAt"`;
  }

  async closeAbandonedInvites(now: Date): Promise<number> {
    const { count } = await this.db.emailSchedule.updateMany({
      where: { kind: 'INVITE', status: 'SENDING', lockedUntil: { lt: now } },
      data: { status: 'FAILED', lastError: 'abandoned', lockedUntil: null },
    });
    return count;
  }

  async markSent(id: string, now: Date): Promise<void> {
    await this.db.emailSchedule.update({ where: { id }, data: { status: 'SENT', sentAt: now, lockedUntil: null } });
  }

  async markSkipped(id: string, reason: SkipReason): Promise<void> {
    await this.db.emailSchedule.update({ where: { id }, data: { status: 'SKIPPED', skipReason: reason, lockedUntil: null } });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.emailSchedule.update({ where: { id }, data: { status: 'FAILED', lastError: error.slice(0, LAST_ERROR_MAX), lockedUntil: null } });
  }

  async retryAt(id: string, dueAt: Date, error: string): Promise<void> {
    await this.db.emailSchedule.update({ where: { id }, data: { status: 'PENDING', dueAt, lastError: error.slice(0, LAST_ERROR_MAX), lockedUntil: null } });
  }

  async purgeFinal(before: Date): Promise<number> {
    const { count } = await this.db.emailSchedule.deleteMany({ where: { status: { in: ['SENT', 'SKIPPED', 'FAILED'] }, updatedAt: { lt: before } } });
    return count;
  }
}
```

Register `EmailScheduleRepository` in `EmailCoreModule` providers and exports (global).

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && bun run db:generate && KODA_DB_TESTS=1 bun run test:scoped test/integration/email/email-schedule-repository.integration.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/src/email
git commit -m "feat(api): S4b B1 EmailSchedule model and repository"
```

### Task B2: Two-layer preferences and the preferences API

**Files:**
- Modify: `apps/api/src/notifications/notification.types.ts` (add `EMAIL_CATEGORY_DEFAULTS`)
- Modify: `apps/api/src/notifications/notification-preferences.service.ts`
- Modify: `apps/api/src/notifications/dto/notification-preferences.dto.ts`
- Modify: `apps/api/src/notifications/me-notifications.controller.ts:63-78`
- Modify: `apps/api/src/notifications/notifications.module.ts` (import `EmailModule`)
- Test: `apps/api/src/notifications/notification-preferences.service.spec.ts`, `me-notifications.controller.spec.ts`

**Interfaces:**
- Produces:
  - `EMAIL_CATEGORY_DEFAULTS: Readonly<Record<NotificationCategory, boolean>>` (Global Constraints values).
  - `interface PreferenceItem { category: NotificationCategory; inApp: boolean; email: boolean }`
  - `interface PreferencesView { emailAvailable: boolean; emailEnabled: boolean; items: readonly PreferenceItem[] }`
  - `interface PreferencesChange { emailEnabled?: boolean; items?: ReadonlyArray<{ category: NotificationCategory; inApp?: boolean; email?: boolean }> }`
  - `NotificationPreferencesService.list(userId): Promise<PreferencesView>`; `.update(userId, change: PreferencesChange): Promise<void>`; `.emailAllowedUserIds(userIds: readonly string[], category: NotificationCategory): Promise<ReadonlySet<string>>`; `.emailAllowed(userId: string, category: NotificationCategory): Promise<{ allowed: true } | { allowed: false; reason: 'EMAIL_OFF' | 'CATEGORY_OFF' }>`; `disabledUserIds` unchanged.

- [ ] **Step 1: Write the failing tests** (add to `notification-preferences.service.spec.ts`; adapt its existing Prisma fake by adding `notificationPreference.findMany` and `notificationCategoryPreference` delegates)

```ts
describe('S4b two-layer email preferences (§3.1)', () => {
  // fake: master rows = package notificationPreference rows { userId, tenantId:'default', channel:'email', enabled }
  //       category rows = notificationCategoryPreference rows { userId, category, channel, enabled }
  it('defaults: email on for ASSIGNED/MENTIONED/FLEET_NEEDS_YOU, off for WATCHED_ACTIVITY/FLEET_HEALTH', async () => {
    const { service } = setup({ master: [], category: [] });
    const view = await service.list('u1');
    expect(view.emailEnabled).toBe(true);
    expect(Object.fromEntries(view.items.map((i) => [i.category, i.email]))).toEqual({
      ASSIGNED: true, MENTIONED: true, WATCHED_ACTIVITY: false, FLEET_NEEDS_YOU: true, FLEET_HEALTH: false,
    });
    expect(view.items.every((i) => i.inApp)).toBe(true);
  });

  it('emailAllowedUserIds applies master switch, then row, then default', async () => {
    const { service } = setup({
      master: [{ userId: 'off', enabled: false }],
      category: [{ userId: 'opt-in', category: 'WATCHED_ACTIVITY', channel: 'email', enabled: true },
                 { userId: 'opt-out', category: 'WATCHED_ACTIVITY', channel: 'email', enabled: false }],
    });
    expect([...await service.emailAllowedUserIds(['off', 'opt-in', 'opt-out', 'plain'], 'WATCHED_ACTIVITY')]).toEqual(['opt-in']);
    expect([...await service.emailAllowedUserIds(['off', 'plain'], 'ASSIGNED')]).toEqual(['plain']);
  });

  it('emailAllowed reports the reason', async () => {
    const { service } = setup({ master: [{ userId: 'off', enabled: false }], category: [{ userId: 'u', category: 'ASSIGNED', channel: 'email', enabled: false }] });
    expect(await service.emailAllowed('off', 'ASSIGNED')).toEqual({ allowed: false, reason: 'EMAIL_OFF' });
    expect(await service.emailAllowed('u', 'ASSIGNED')).toEqual({ allowed: false, reason: 'CATEGORY_OFF' });
    expect(await service.emailAllowed('x', 'ASSIGNED')).toEqual({ allowed: true });
  });

  it('update writes the master switch through the package preference service and only the given fields', async () => {
    const { service, packagePrefs, categoryUpserts } = setup({ master: [], category: [] });
    await service.update('u1', { emailEnabled: false, items: [{ category: 'MENTIONED', email: false }] });
    expect(packagePrefs.updatePreference).toHaveBeenCalledWith('u1', 'default', 'email', false);
    expect(categoryUpserts).toEqual([{ userId: 'u1', category: 'MENTIONED', channel: 'email', enabled: false }]);
  });
});
```

In `me-notifications.controller.spec.ts` change the preferences expectations to the R4 shape:
`GET` → `{ emailAvailable, emailEnabled, items: [{ category, inApp, email }] }`; `PUT { emailEnabled: false }`
(no items) is accepted.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun run test:scoped src/notifications/notification-preferences.service.spec.ts src/notifications/me-notifications.controller.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// notification.types.ts (add)
/** S4b D517: email default per category when a user has no (category, 'email') row. In-app default stays on. */
export const EMAIL_CATEGORY_DEFAULTS: Readonly<Record<NotificationCategory, boolean>> = {
  ASSIGNED: true, MENTIONED: true, FLEET_NEEDS_YOU: true, WATCHED_ACTIVITY: false, FLEET_HEALTH: false,
};
```

```ts
// notification-preferences.service.ts (full replacement of the class body; keep disabledUserIds as is)
import { Inject, Injectable } from '@nestjs/common';
import { IPreferenceService, NotificationChannel, PREFERENCE_SERVICE } from '@nathapp/nestjs-notify';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { EmailAvailability } from '../email/email-availability';
import { KODA_TENANT_ID } from '../email/koda-tenant';
import {
  EMAIL_CATEGORY_DEFAULTS, NOTIFICATION_CATEGORIES, NotificationCategory, NotificationChannelValue,
} from './notification.types';

export interface PreferenceItem { category: NotificationCategory; inApp: boolean; email: boolean }
export interface PreferencesView { emailAvailable: boolean; emailEnabled: boolean; items: readonly PreferenceItem[] }
export interface PreferencesChange {
  emailEnabled?: boolean;
  items?: ReadonlyArray<{ category: NotificationCategory; inApp?: boolean; email?: boolean }>;
}
export type EmailDecision = { allowed: true } | { allowed: false; reason: 'EMAIL_OFF' | 'CATEGORY_OFF' };

/**
 * S4a D503 + S4b §3.1: per-(category, channel) switches in NotificationCategoryPreference; the email master switch
 * is nestjs-notify's NotificationPreference (tenant KODA_TENANT_ID, channel 'email'). Missing rows: in_app on;
 * email per EMAIL_CATEGORY_DEFAULTS; master on.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(PREFERENCE_SERVICE) private readonly packagePrefs: IPreferenceService,
    private readonly email: EmailAvailability,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  // disabledUserIds(...) unchanged from S4a (now on notificationCategoryPreference)

  private async masterOff(userIds: readonly string[]): Promise<ReadonlySet<string>> {
    const rows = await this.db.notificationPreference.findMany({
      where: { userId: { in: [...userIds] }, tenantId: KODA_TENANT_ID, channel: NotificationChannel.EMAIL, enabled: false },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /** Throws on a read failure (S4a §6: never default silently to "on"). */
  async emailAllowedUserIds(userIds: readonly string[], category: NotificationCategory): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const off = await this.masterOff(userIds);
    const rows = await this.db.notificationCategoryPreference.findMany({
      where: { userId: { in: [...userIds] }, category, channel: NotificationChannel.EMAIL },
      select: { userId: true, enabled: true },
    });
    const explicit = new Map(rows.map((r) => [r.userId, r.enabled]));
    return new Set(userIds.filter((id) => !off.has(id) && (explicit.get(id) ?? EMAIL_CATEGORY_DEFAULTS[category])));
  }

  async emailAllowed(userId: string, category: NotificationCategory): Promise<EmailDecision> {
    if ((await this.masterOff([userId])).has(userId)) return { allowed: false, reason: 'EMAIL_OFF' };
    const allowed = await this.emailAllowedUserIds([userId], category);
    return allowed.has(userId) ? { allowed: true } : { allowed: false, reason: 'CATEGORY_OFF' };
  }

  async list(userId: string): Promise<PreferencesView> {
    const rows = await this.db.notificationCategoryPreference.findMany({ where: { userId }, select: { category: true, channel: true, enabled: true } });
    const value = (category: NotificationCategory, channel: NotificationChannelValue): boolean | undefined =>
      rows.find((r) => r.category === category && r.channel === channel)?.enabled;
    const emailEnabled = !(await this.masterOff([userId])).has(userId);
    return {
      emailAvailable: this.email.configured,
      emailEnabled,
      items: NOTIFICATION_CATEGORIES.map((category) => ({
        category,
        inApp: value(category, NotificationChannel.IN_APP) ?? true,
        email: value(category, NotificationChannel.EMAIL) ?? EMAIL_CATEGORY_DEFAULTS[category],
      })),
    };
  }

  async update(userId: string, change: PreferencesChange): Promise<void> {
    await this.txManager.run(async () => {
      for (const item of change.items ?? []) {
        const pairs: Array<[NotificationChannelValue, boolean | undefined]> = [
          [NotificationChannel.IN_APP, item.inApp], [NotificationChannel.EMAIL, item.email],
        ];
        for (const [channel, enabled] of pairs) {
          if (enabled === undefined) continue;
          await this.db.notificationCategoryPreference.upsert({
            where: { userId_category_channel: { userId, category: item.category, channel } },
            create: { userId, category: item.category, channel, enabled },
            update: { enabled },
          });
        }
      }
      if (change.emailEnabled !== undefined) {
        await this.packagePrefs.updatePreference(userId, KODA_TENANT_ID, NotificationChannel.EMAIL, change.emailEnabled);
      }
    });
  }
}
```

DTO (`notification-preferences.dto.ts`):

```ts
export class NotificationPreferenceItemDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES }) @IsIn(NOTIFICATION_CATEGORIES) category: NotificationCategory;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() inApp?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() email?: boolean;
}

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() emailEnabled?: boolean;
  @ApiPropertyOptional({ type: [NotificationPreferenceItemDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(NOTIFICATION_CATEGORIES.length)
  @ValidateNested({ each: true }) @Type(() => NotificationPreferenceItemDto)
  items?: NotificationPreferenceItemDto[];
}

export class NotificationPreferenceViewItemDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES }) category: NotificationCategory;
  @ApiProperty() inApp: boolean;
  @ApiProperty() email: boolean;
}

export class NotificationPreferencesDto {
  @ApiProperty() emailAvailable: boolean;
  @ApiProperty() emailEnabled: boolean;
  @ApiProperty({ type: [NotificationPreferenceViewItemDto] }) items: NotificationPreferenceViewItemDto[];
}
```

Controller: `GET` returns `JsonResponse.Ok(await this.preferences.list(me.id))`; `PUT` takes
`UpdateNotificationPreferencesDto`, calls `this.preferences.update(me.id, { emailEnabled: dto.emailEnabled, items: dto.items })`,
returns the `list`. `EmailAvailability` (global `EmailCoreModule`) and `PREFERENCE_SERVICE` (global `NotifyModule`)
need no module import.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bun run test:scoped src/notifications`
Expected: PASS.

- [ ] **Step 5: Regenerate the contract**

Run: `bun run generate` (repo root). Expected: `openapi.json` and `apps/cli/src/generated/` change for
`/me/notification-preferences`. Run `cd apps/cli && bun run test` — Expected: PASS (fix any CLI type that read the
old item shape).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications openapi.json apps/cli/src/generated
git commit -m "feat(api): S4b B2 two-layer email preferences"
```

### Task B3: Schedule email from `NotificationWriter`

**Files:**
- Modify: `apps/api/src/notifications/notification-writer.ts`
- Modify: `apps/api/src/notifications/notifications.repository.ts` (`insertMany` returns `category`, `kind`, `createdAt` too)
- Test: `apps/api/src/notifications/notification-writer.spec.ts`

**Interfaces:**
- Consumes: `EmailScheduleRepository.scheduleNotifications` (B1), `NotificationPreferencesService.emailAllowedUserIds` (B2), `EmailAvailability` (A3).
- Produces: `NotificationWriter` constructor `(eligibility, preferences, repo, bus, emailSchedule: EmailScheduleRepository, email: EmailAvailability, users: NotificationEmailRecipients)`; `NotificationsRepository.insertMany(...)` returns `ReadonlyArray<{ id: string; userId: string; category: NotificationCategory; kind: string; createdAt: Date }>`; new `NotificationEmailRecipients.emails(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>` in `apps/api/src/notifications/notification-email-recipients.ts`.

- [ ] **Step 1: Write the failing tests** (extend `setup()` in `notification-writer.spec.ts`)

```ts
// setup additions
const emailSchedule = { scheduleNotifications: jest.fn(async (rows: unknown[]) => { order.push('schedule'); return rows.length; }) };
const email = { configured: true, config: () => ({ delaySec: 300, approvalDelaySec: 60 }) };
const recipients = { emails: jest.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, `${id}@x.io`]))) };
preferences.emailAllowedUserIds = jest.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => id !== 'no-email')));
// repo.insertMany returns { id, userId, category, kind, createdAt: T0 }
const writer = new NotificationWriter(eligibility as never, preferences as never, repo as never, bus, emailSchedule as never, email as never, recipients as never);

describe('S4b email scheduling (§3.2)', () => {
  const T0 = new Date('2026-10-10T10:00:00Z');

  it('schedules one email per inserted row the user allows, due after EMAIL_DELAY_SEC, before publishing', async () => {
    const { writer, emailSchedule, order } = setup();
    await writer.deliver([draft('a', { category: 'ASSIGNED', kind: 'ticket_assigned' }), draft('no-email', { category: 'ASSIGNED', kind: 'ticket_assigned' })]);
    expect(emailSchedule.scheduleNotifications).toHaveBeenCalledWith([
      { notificationId: 'n0', userId: 'a', toEmail: 'a@x.io', dueAt: new Date(T0.getTime() + 300_000) },
    ]);
    expect(order).toEqual(['insert', 'schedule', 'publish', 'publish']);
  });

  it('uses EMAIL_APPROVAL_DELAY_SEC for approval_requested', async () => {
    const { writer, emailSchedule } = setup();
    await writer.deliver([draft('a', { category: 'FLEET_NEEDS_YOU', kind: 'approval_requested' })]);
    expect(emailSchedule.scheduleNotifications.mock.calls[0][0][0].dueAt).toEqual(new Date(T0.getTime() + 60_000));
  });

  it('schedules nothing when email is not configured', async () => {
    const { writer, emailSchedule, email } = setup();
    email.configured = false;
    await writer.deliver([draft('a')]);
    expect(emailSchedule.scheduleNotifications).not.toHaveBeenCalled();
  });

  it('skips a user with no email address on file', async () => {
    const { writer, emailSchedule, recipients } = setup();
    recipients.emails.mockResolvedValueOnce(new Map());
    await writer.deliver([draft('a', { category: 'ASSIGNED' })]);
    expect(emailSchedule.scheduleNotifications).toHaveBeenCalledWith([]);
  });

  it('propagates a scheduling failure so the outbox retries (redelivery is absorbed by the unique keys)', async () => {
    const { writer, emailSchedule } = setup();
    emailSchedule.scheduleNotifications.mockRejectedValueOnce(new Error('db down'));
    await expect(writer.deliver([draft('a', { category: 'ASSIGNED' })])).rejects.toThrow('db down');
  });
});
```

Update the S4a test's expected order to `['insert', 'schedule', 'publish', 'publish']`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun run test:scoped src/notifications/notification-writer.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`notifications.repository.ts` `insertMany`: extend the `createManyAndReturn` `select` to
`{ id: true, userId: true, category: true, kind: true, createdAt: true }` and the return type accordingly.

```ts
// apps/api/src/notifications/notification-email-recipients.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';

/** S4b §3.2: current addresses of enabled users (disabled users are re-checked at send time too). */
@Injectable()
export class NotificationEmailRecipients {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async emails(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.client.user.findMany({ where: { id: { in: [...userIds] }, disabled: false }, select: { id: true, email: true } });
    return new Map(rows.map((r) => [r.id, r.email]));
  }
}
```

```ts
// notification-writer.ts — deliver() becomes:
  async deliver(drafts: readonly NotificationDraft[]): Promise<number> {
    if (drafts.length === 0) return 0;
    const eligible = await this.eligibility.filter(drafts);
    const allowed = await this.applyPreferences(eligible);
    const inserted = await this.repo.insertMany(allowed);
    await this.scheduleEmail(inserted);
    const at = new Date().toISOString();
    for (const row of inserted) this.bus.publish({ type: 'notification', userId: row.userId, id: row.id, at });
    return inserted.length;
  }

  /** S4b §3.2: one schedule row per inserted notification whose user allows email for its category. */
  private async scheduleEmail(inserted: readonly InsertedNotification[]): Promise<void> {
    if (inserted.length === 0 || !this.email.configured) return;
    const { delaySec, approvalDelaySec } = this.email.config();
    const allowedByCategory = new Map<NotificationCategory, ReadonlySet<string>>();
    for (const category of unique(inserted.map((r) => r.category))) {
      const ids = unique(inserted.filter((r) => r.category === category).map((r) => r.userId));
      allowedByCategory.set(category, await this.preferences.emailAllowedUserIds(ids, category));
    }
    const wanted = inserted.filter((r) => allowedByCategory.get(r.category)?.has(r.userId));
    const addresses = await this.users.emails(unique(wanted.map((r) => r.userId)));
    await this.emailSchedule.scheduleNotifications(wanted.flatMap((r) => {
      const toEmail = addresses.get(r.userId);
      if (!toEmail) return [];
      const delay = r.kind === 'approval_requested' ? approvalDelaySec : delaySec;
      return [{ notificationId: r.id, userId: r.userId, toEmail, dueAt: new Date(r.createdAt.getTime() + delay * 1000) }];
    }));
  }
```

(`type InsertedNotification = Awaited<ReturnType<NotificationsRepository['insertMany']>>[number]`.) Register
`NotificationEmailRecipients` in `NotificationsModule`; `EmailScheduleRepository` is global (`EmailCoreModule`).
Update the class doc comment: "... then schedules email (S4b §3.2), then a content-free live signal ...".

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bun run test:scoped src/notifications`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications
git commit -m "feat(api): S4b B3 schedule notification email from the writer"
```

### Task B4: `EmailDispatcher`

**Files:**
- Create: `apps/api/src/email/dispatch/email-content.builder.ts`
- Create: `apps/api/src/email/dispatch/send-outcome.ts`
- Create: `apps/api/src/email/dispatch/email-dispatcher.ts`
- Modify: `apps/api/src/notifications/notifications.module.ts` (provide the dispatcher here: it reads notifications and preferences)
- Test: `apps/api/src/email/dispatch/send-outcome.spec.ts`, `apps/api/src/email/dispatch/email-dispatcher.spec.ts`

**Interfaces:**
- Consumes: B1 repository, B2 `emailAllowed`, `EmailAvailability`, `NOTIFY_SERVICE`.
- Produces:
  - `classifySendError(error: unknown): 'permanent' | 'retryable'`
  - `backoffMs(attempts: number): number` (`2^(attempts-1)` minutes)
  - `EmailContentBuilder.build(row: EmailScheduleRow): Promise<{ skip: SkipReason } | { data: Record<string, string>; userId: string | null }>` (NOTIFICATION and MEMBER_ADDED)
  - `EmailDispatcher.tick(now: Date): Promise<{ sent: number; skipped: number; failed: number; retried: number }>`; `@Interval(30_000) scheduledTick()`
  - `EmailDispatcher.sendOne(row: EmailScheduleRow, templateCode: EmailTemplateCode, data: Record<string, string>, userId: string | null, now: Date, retryable = true): Promise<'SENT' | 'FAILED' | 'RETRY'>` (also used by Task C2 for inline invite mail with `retryable = false`)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/email/dispatch/send-outcome.spec.ts
import { NotifyException, NotifyExceptionCode, PermanentNotificationError } from '@nathapp/nestjs-notify';
import { backoffMs, classifySendError } from './send-outcome';

describe('send outcome (S4b §3.3)', () => {
  it.each([
    [new NotifyException(NotifyExceptionCode.TEMPLATE_NOT_FOUND), 'permanent'],
    [new NotifyException(NotifyExceptionCode.CHANNEL_NOT_REGISTERED), 'permanent'],
    [new NotifyException(NotifyExceptionCode.TENANT_MISMATCH), 'permanent'],
    [new PermanentNotificationError('550'), 'permanent'],
    [new Error('ECONNRESET'), 'retryable'],
    ['weird', 'retryable'],
  ])('%p is %s', (err, expected) => expect(classifySendError(err)).toBe(expected));

  it('backs off 1, 2, 4, 8 minutes', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
  });
});
```

```ts
// apps/api/src/email/dispatch/email-dispatcher.spec.ts
import { EmailDispatcher } from './email-dispatcher';
import type { EmailScheduleRow } from '../schedule/email-schedule.types';

const NOW = new Date('2026-10-10T10:00:00Z');
const row = (over: Partial<EmailScheduleRow> = {}): EmailScheduleRow => ({
  id: 's1', kind: 'NOTIFICATION', notificationId: 'n1', inviteId: null, userId: 'u1', projectId: null,
  toEmail: 'u1@x.io', locale: 'en', attempts: 1, dueAt: NOW, ...over,
});

function setup(rows: EmailScheduleRow[], build: unknown = { data: { title: 't' }, userId: 'u1' }) {
  const repo = {
    closeAbandonedInvites: jest.fn(async () => 0),
    claimDue: jest.fn(async () => rows),
    markSent: jest.fn(), markSkipped: jest.fn(), markFailed: jest.fn(), retryAt: jest.fn(),
  };
  const builder = { build: jest.fn(async () => build) };
  const notify = { send: jest.fn(async () => undefined) };
  const email = { configured: true, config: () => ({ maxAttempts: 5 }) };
  const dispatcher = new EmailDispatcher(repo as never, builder as never, notify as never, email as never);
  return { dispatcher, repo, builder, notify, email };
}

describe('EmailDispatcher (S4b §3.3)', () => {
  it('closes abandoned invites, then sends a claimed row through nestjs-notify with tenant default', async () => {
    const { dispatcher, repo, notify } = setup([row()]);
    await expect(dispatcher.tick(NOW)).resolves.toEqual({ sent: 1, skipped: 0, failed: 0, retried: 0 });
    expect(repo.closeAbandonedInvites).toHaveBeenCalledWith(NOW);
    expect(repo.claimDue).toHaveBeenCalledWith(NOW, 20);
    expect(notify.send).toHaveBeenCalledWith({ tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', locale: 'en',
      recipient: 'u1@x.io', userId: 'u1', data: { title: 't' } });
    expect(repo.markSent).toHaveBeenCalledWith('s1', NOW);
  });

  it.each(['READ', 'EMAIL_OFF', 'CATEGORY_OFF', 'USER_DISABLED', 'SOURCE_GONE'])('skips with %s and never sends (Review Focus 4)', async (reason) => {
    const { dispatcher, repo, notify } = setup([row()], { skip: reason });
    await expect(dispatcher.tick(NOW)).resolves.toMatchObject({ skipped: 1 });
    expect(repo.markSkipped).toHaveBeenCalledWith('s1', reason);
    expect(notify.send).not.toHaveBeenCalled();
  });

  it('retries a transport error with backoff', async () => {
    const { dispatcher, repo, notify } = setup([row({ attempts: 2 })]);
    notify.send.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await dispatcher.tick(NOW);
    expect(repo.retryAt).toHaveBeenCalledWith('s1', new Date(NOW.getTime() + 120_000), 'ECONNREFUSED');
  });

  it('fails after EMAIL_MAX_ATTEMPTS', async () => {
    const { dispatcher, repo, notify } = setup([row({ attempts: 5 })]);
    notify.send.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(dispatcher.tick(NOW)).resolves.toMatchObject({ failed: 1 });
    expect(repo.markFailed).toHaveBeenCalledWith('s1', 'ECONNREFUSED');
  });

  it('fails a permanent error on the first attempt', async () => {
    const { PermanentNotificationError } = jest.requireActual('@nathapp/nestjs-notify');
    const { dispatcher, repo, notify } = setup([row()]);
    notify.send.mockRejectedValueOnce(new PermanentNotificationError('550 no such user'));
    await dispatcher.tick(NOW);
    expect(repo.markFailed).toHaveBeenCalledWith('s1', '550 no such user');
    expect(repo.retryAt).not.toHaveBeenCalled();
  });

  it('one row throwing in the builder does not stop the batch', async () => {
    const { dispatcher, builder, repo } = setup([row({ id: 'a' }), row({ id: 'b' })]);
    builder.build.mockRejectedValueOnce(new Error('db blip'));
    await dispatcher.tick(NOW);
    expect(repo.retryAt).toHaveBeenCalledWith('a', expect.any(Date), 'db blip');
    expect(repo.markSent).toHaveBeenCalledWith('b', NOW);
  });

  it('does nothing when email is not configured', async () => {
    const { dispatcher, repo, email } = setup([row()]);
    email.configured = false;
    await dispatcher.tick(NOW);
    expect(repo.claimDue).not.toHaveBeenCalled();
  });
});
```

```ts
// apps/api/src/email/dispatch/email-content.builder.spec.ts
import { EmailContentBuilder } from './email-content.builder';
import type { EmailScheduleRow } from '../schedule/email-schedule.types';

const base: EmailScheduleRow = { id: 's1', kind: 'NOTIFICATION', notificationId: 'n1', inviteId: null, userId: 'u1', projectId: null,
  toEmail: 'u1@x.io', locale: 'en', attempts: 1, dueAt: new Date() };

function setup(state: { notification?: object | null; user?: object | null; member?: object | null; project?: object | null; decision?: object } = {}) {
  const db = {
    notification: { findUnique: jest.fn(async () => (state.notification === undefined
      ? { id: 'n1', userId: 'u1', category: 'ASSIGNED', title: 'KODA-1 assigned to you', body: null, link: '/koda/tickets/KODA-1', readAt: null }
      : state.notification)) },
    user: { findUnique: jest.fn(async () => (state.user === undefined ? { id: 'u1', disabled: false } : state.user)) },
    projectMember: { findUnique: jest.fn(async () => (state.member === undefined ? { role: 'DEVELOPER' } : state.member)) },
    project: { findUnique: jest.fn(async () => (state.project === undefined ? { name: 'Koda', slug: 'koda', deletedAt: null } : state.project)) },
  };
  const prefs = { emailAllowed: jest.fn(async () => state.decision ?? { allowed: true }) };
  const email = { webUrl: (p: string) => `https://k.x${p}` };
  return { builder: new EmailContentBuilder({ client: db } as never, prefs as never, email as never), prefs };
}

describe('EmailContentBuilder (S4b §3.3 step 2)', () => {
  it('builds NOTIFICATION data from the stored title/body/link', async () => {
    await expect(setup().builder.build(base)).resolves.toEqual({ userId: 'u1', data: {
      title: 'KODA-1 assigned to you', body: '', url: 'https://k.x/koda/tickets/KODA-1', prefsUrl: 'https://k.x/settings/notifications' } });
  });
  it.each([
    [{ notification: null }, 'SOURCE_GONE'],
    [{ notification: { id: 'n1', userId: 'u1', category: 'ASSIGNED', title: 't', body: null, link: '/l', readAt: new Date() } }, 'READ'],
    [{ user: { id: 'u1', disabled: true } }, 'USER_DISABLED'],
    [{ user: null }, 'USER_DISABLED'],
    [{ decision: { allowed: false, reason: 'EMAIL_OFF' } }, 'EMAIL_OFF'],
    [{ decision: { allowed: false, reason: 'CATEGORY_OFF' } }, 'CATEGORY_OFF'],
  ])('NOTIFICATION %p -> skip %s', async (state, reason) => {
    await expect(setup(state).builder.build(base)).resolves.toEqual({ skip: reason });
  });
  it('builds MEMBER_ADDED from the project and membership', async () => {
    const row = { ...base, kind: 'MEMBER_ADDED' as const, notificationId: null, projectId: 'p1' };
    await expect(setup().builder.build(row)).resolves.toEqual({ userId: 'u1', data: { projectName: 'Koda', role: 'DEVELOPER', url: 'https://k.x/koda' } });
  });
  it.each([
    [{ project: null }, 'SOURCE_GONE'],
    [{ member: null }, 'SOURCE_GONE'],
    [{ user: { id: 'u1', disabled: true } }, 'USER_DISABLED'],
  ])('MEMBER_ADDED %p -> skip %s', async (state, reason) => {
    const row = { ...base, kind: 'MEMBER_ADDED' as const, notificationId: null, projectId: 'p1' };
    await expect(setup(state).builder.build(row)).resolves.toEqual({ skip: reason });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun run test:scoped src/email/dispatch`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/email/dispatch/send-outcome.ts
import { NotifyException, NotifyExceptionCode, PermanentNotificationError } from '@nathapp/nestjs-notify';

const PERMANENT_CODES = new Set<number>([
  NotifyExceptionCode.TEMPLATE_NOT_FOUND, NotifyExceptionCode.CHANNEL_NOT_REGISTERED, NotifyExceptionCode.TENANT_MISMATCH,
]);

/** S4b §3.3: configuration and recipient errors never succeed on retry. */
export function classifySendError(error: unknown): 'permanent' | 'retryable' {
  if (error instanceof PermanentNotificationError) return 'permanent';
  if (error instanceof NotifyException && PERMANENT_CODES.has(Number((error as { code?: unknown }).code))) return 'permanent';
  return 'retryable';
}

export function backoffMs(attempts: number): number {
  return 2 ** Math.max(0, attempts - 1) * 60_000;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

```ts
// apps/api/src/email/dispatch/email-dispatcher.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { INotifyService, NOTIFY_SERVICE, NotificationChannel } from '@nathapp/nestjs-notify';
import { EmailAvailability } from '../email-availability';
import { KODA_TENANT_ID } from '../koda-tenant';
import { EmailScheduleRepository } from '../schedule/email-schedule.repository';
import type { EmailScheduleRow } from '../schedule/email-schedule.types';
import type { EmailTemplateCode } from '../templates/template-codes';
import { EmailContentBuilder } from './email-content.builder';
import { backoffMs, classifySendError, errorText } from './send-outcome';

export const EMAIL_DISPATCH_INTERVAL_MS = 30_000;
const BATCH = 20;

/**
 * Fleet S4b §3.3: claims due rows, re-checks them, sends through nestjs-notify, and records the outcome. One tick at
 * a time per process; one row's failure never stops the batch. WARN lines carry id/kind/attempts only.
 */
@Injectable()
export class EmailDispatcher {
  private readonly logger = new Logger(EmailDispatcher.name);
  private running = false;

  constructor(
    private readonly repo: EmailScheduleRepository,
    private readonly builder: EmailContentBuilder,
    @Inject(NOTIFY_SERVICE) private readonly notify: INotifyService,
    private readonly email: EmailAvailability,
  ) {}

  @Interval(EMAIL_DISPATCH_INTERVAL_MS)
  async scheduledTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick(new Date());
    } catch (error) {
      this.logger.error(`Email dispatch tick failed: ${errorText(error)}`);
    } finally {
      this.running = false;
    }
  }

  async tick(now: Date): Promise<{ sent: number; skipped: number; failed: number; retried: number }> {
    const counts = { sent: 0, skipped: 0, failed: 0, retried: 0 };
    if (!this.email.configured) return counts;
    await this.repo.closeAbandonedInvites(now);
    for (const row of await this.repo.claimDue(now, BATCH)) {
      try {
        const built = await this.builder.build(row);
        if ('skip' in built) {
          await this.repo.markSkipped(row.id, built.skip);
          counts.skipped += 1;
          continue;
        }
        const outcome = await this.sendOne(row, row.kind as EmailTemplateCode, built.data, built.userId, now);
        counts[outcome === 'SENT' ? 'sent' : outcome === 'FAILED' ? 'failed' : 'retried'] += 1;
      } catch (error) {
        await this.fail(row, error, now);
        counts.retried += 1;
      }
    }
    return counts;
  }

  /** Sends one row and records SENT / FAILED / retry. Used by the tick and by inline invite mail (C2). */
  async sendOne(row: EmailScheduleRow, templateCode: EmailTemplateCode, data: Record<string, string>, userId: string | null, now: Date, retryable = true): Promise<'SENT' | 'FAILED' | 'RETRY'> {
    try {
      await this.notify.send({ tenantId: KODA_TENANT_ID, channel: NotificationChannel.EMAIL, templateCode, locale: row.locale,
        recipient: row.toEmail, userId: userId ?? undefined, data });
      await this.repo.markSent(row.id, now);
      return 'SENT';
    } catch (error) {
      if (!retryable || classifySendError(error) === 'permanent' || row.attempts >= this.email.config().maxAttempts) {
        await this.repo.markFailed(row.id, errorText(error));
        this.logger.warn(`Email ${row.id} (${row.kind}) failed after ${row.attempts} attempt(s)`);
        return 'FAILED';
      }
      await this.repo.retryAt(row.id, new Date(now.getTime() + backoffMs(row.attempts)), errorText(error));
      return 'RETRY';
    }
  }

  private async fail(row: EmailScheduleRow, error: unknown, now: Date): Promise<void> {
    await this.repo.retryAt(row.id, new Date(now.getTime() + backoffMs(row.attempts)), errorText(error));
  }
}
```

```ts
// apps/api/src/email/dispatch/email-content.builder.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../generated/prisma/client';
import { NotificationPreferencesService } from '../../notifications/notification-preferences.service';
import type { NotificationCategory } from '../../notifications/notification.types';
import { EmailAvailability } from '../email-availability';
import type { EmailScheduleRow, SkipReason } from '../schedule/email-schedule.types';

export type BuiltEmail = { skip: SkipReason } | { data: Record<string, string>; userId: string | null };

/** Fleet S4b §3.3 step 2: re-check the world at send time, then build the template data. Skips are final. */
@Injectable()
export class EmailContentBuilder {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly preferences: NotificationPreferencesService,
    private readonly email: EmailAvailability,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  async build(row: EmailScheduleRow): Promise<BuiltEmail> {
    return row.kind === 'NOTIFICATION' ? this.notification(row) : this.memberAdded(row);
  }

  private async activeUser(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true, disabled: true } });
    return !!user && !user.disabled;
  }

  private async notification(row: EmailScheduleRow): Promise<BuiltEmail> {
    const n = row.notificationId ? await this.db.notification.findUnique({ where: { id: row.notificationId } }) : null;
    if (!n) return { skip: 'SOURCE_GONE' };
    if (n.readAt) return { skip: 'READ' };
    if (!(await this.activeUser(n.userId))) return { skip: 'USER_DISABLED' };
    const decision = await this.preferences.emailAllowed(n.userId, n.category as NotificationCategory);
    if (!decision.allowed) return { skip: decision.reason };
    return { userId: n.userId, data: {
      title: n.title, body: n.body ?? '', url: this.email.webUrl(n.link), prefsUrl: this.email.webUrl('/settings/notifications'),
    } };
  }

  private async memberAdded(row: EmailScheduleRow): Promise<BuiltEmail> {
    if (!(await this.activeUser(row.userId))) return { skip: 'USER_DISABLED' };
    const project = row.projectId ? await this.db.project.findUnique({ where: { id: row.projectId }, select: { name: true, slug: true, deletedAt: true } }) : null;
    if (!project || project.deletedAt) return { skip: 'SOURCE_GONE' };
    const member = await this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId: row.projectId as string, userId: row.userId as string } }, select: { role: true },
    });
    if (!member) return { skip: 'SOURCE_GONE' };
    return { userId: row.userId, data: { projectName: project.name, role: member.role, url: this.email.webUrl(`/${project.slug}`) } };
  }
}
```

(`Project.deletedAt` exists — soft delete; `ProjectMember` has `@@unique([projectId, userId])`, so the compound key
is `projectId_userId`.) Register `EmailContentBuilder` and
`EmailDispatcher` in `NotificationsModule.providers` and export `EmailDispatcher` (Task C2 injects it).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bun run test:scoped src/email src/notifications`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/email apps/api/src/notifications
git commit -m "feat(api): S4b B4 email dispatcher"
```

### Task B5: Retention, web settings, Mailpit end-to-end

**Files:**
- Modify: `apps/api/src/notifications/notification-retention.processor.ts` (+ spec)
- Modify: `apps/web/lib/notification-types.ts`, `apps/web/composables/useNotificationPreferences.ts`, `apps/web/pages/settings/notifications.vue`, `apps/web/i18n/locales/{en,zh}.json`
- Test: `apps/web/tests/pages/settings-notifications.spec.ts` (create, or extend the existing settings spec if one exists — `git ls-files apps/web/tests | grep -i notif`)
- Modify: `docker-compose.test.yml` (Mailpit)
- Test: `apps/api/test/e2e/email/notification-email.e2e.spec.ts`

**Interfaces:**
- Consumes: B1 `purgeFinal`; B2 API shape (R4).
- Produces: web `useNotificationPreferences()` returns `{ view, pending, load, setInApp(category, value), setEmail(category, value), setEmailEnabled(value) }`.

- [ ] **Step 1: Retention (test first)** — add to `notification-retention.processor.spec.ts`:

```ts
it('purges final email schedule rows older than 30 days, independent of the notification purge', async () => {
  const { processor, emailSchedule, repo } = setup();
  repo.purgeRead.mockRejectedValueOnce(new Error('boom'));
  await processor.purge(new Date('2026-11-10T04:30:00Z'));
  expect(emailSchedule.purgeFinal).toHaveBeenCalledWith(new Date('2026-10-11T04:30:00Z'));
});
```

Implement `purgeEmailSchedules(now)` with the same log-and-swallow shape as `purgeClosedHealthAlerts`, called from
`purge()`. Run `bun run test:scoped src/notifications/notification-retention.processor.spec.ts` (FAIL then PASS).

- [ ] **Step 2: Web settings (test first)** — update the existing specs `apps/web/tests/pages/notification-settings-page.spec.ts`
  and `apps/web/tests/composables/useNotificationPreferences.spec.ts` (they use `mountSfc` / `webFile` from
  `tests/helpers/mount-sfc` and `uiStubs`, `enI18n`, `toastRecorder` from `tests/helpers/fleet-harness`). The fake
  composable now exposes `view` instead of `items`:

```ts
// notification-settings-page.spec.ts — new fixture and cases (keep the S4a in-app cases, reading view.items)
const VIEW = (over: Partial<NotificationPreferencesView> = {}): NotificationPreferencesView => ({
  emailAvailable: true, emailEnabled: true,
  items: [
    { category: 'ASSIGNED', inApp: true, email: true }, { category: 'MENTIONED', inApp: true, email: true },
    { category: 'WATCHED_ACTIVITY', inApp: false, email: false }, { category: 'FLEET_NEEDS_YOU', inApp: true, email: true },
    { category: 'FLEET_HEALTH', inApp: true, email: false },
  ],
  ...over,
})

function mountPage(fakeOver: Record<string, unknown> = {}, view = VIEW()) {
  const state = ref<NotificationPreferencesView | null>(null)
  const fake = {
    view: state, pending: ref(false),
    load: jest.fn(async () => { state.value = view }),
    setInApp: jest.fn(async () => undefined), setEmail: jest.fn(async () => undefined), setEmailEnabled: jest.fn(async () => undefined),
    ...fakeOver,
  }
  const toast = toastRecorder()
  const app = mountSfc(page, {
    components: uiStubs,
    alias: { '~/composables/useNotificationPreferences': { useNotificationPreferences: () => fake } },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast, definePageMeta: () => undefined },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) { await new Promise((resolve) => { setImmediate(resolve) }); await Vue.nextTick() }
  }
  const find = (id: string) => app.find(`[data-testid="${id}"]`)[0]
  return { app, fake, toast, settle, find }
}

describe('/settings/notifications email (S4b §4.4)', () => {
  test('shows the master switch and a per-category email box with defaults', async () => {
    const p = mountPage()
    await p.settle()
    expect(p.find('notification-email-master').props.checked).toBe(true)
    expect(p.find('notification-pref-email-ASSIGNED').props.checked).toBe(true)
    expect(p.find('notification-pref-email-FLEET_HEALTH').props.checked).toBe(false)
  })

  test('email controls are disabled with a hint when email is unavailable', async () => {
    const p = mountPage({}, VIEW({ emailAvailable: false }))
    await p.settle()
    expect(p.find('notification-email-master').props.disabled).toBe(true)
    expect(p.find('notification-pref-email-ASSIGNED').props.disabled).toBe(true)
    expect(p.app.text()).toContain('Email is not set up on this koda server')
  })

  test('master off disables the per-category email boxes', async () => {
    const p = mountPage({}, VIEW({ emailEnabled: false }))
    await p.settle()
    expect(p.find('notification-pref-email-ASSIGNED').props.disabled).toBe(true)
  })

  test('toggling the master and a row call the composable', async () => {
    const p = mountPage()
    await p.settle()
    ;(p.find('notification-email-master').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    ;(p.find('notification-pref-email-MENTIONED').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await p.settle()
    expect(p.fake.setEmailEnabled).toHaveBeenCalledWith(false)
    expect(p.fake.setEmail).toHaveBeenCalledWith('MENTIONED', false)
  })

  test('a failed save restores the box and shows the error', async () => {
    const p = mountPage({ setEmail: jest.fn(async () => { throw new Error('nope') }) })
    await p.settle()
    const target = { checked: false }
    ;(p.find('notification-pref-email-MENTIONED').props.onChange as (e: unknown) => void)({ target })
    await p.settle()
    expect(target.checked).toBe(true)
    expect(p.toast.errors.length).toBe(1)
  })
})
```

  Adjust `toastRecorder` field names (`errors`) to the helper's real API. In the composable spec, assert
  `setEmail('MENTIONED', false)` PUTs `{ items: [{ category: 'MENTIONED', email: false }] }`,
  `setEmailEnabled(false)` PUTs `{ emailEnabled: false }`, and both replace `view` with the response.

  Then implement: `lib/notification-types.ts` gets `NotificationPreferencesView` (`emailAvailable`, `emailEnabled`,
  `items: { category, inApp, email }[]`); the composable stores the whole view (`view: Ref<NotificationPreferencesView | null>`)
  and adds `setEmail` and `setEmailEnabled` (both `$api.put(PREFERENCES_PATH, ...)` then replace `view`); the page
  adds the master toggle above the list and a second checkbox per row labelled `notifications.preferences.email`,
  disabled when `!view.emailAvailable || !view.emailEnabled` (row) / `!view.emailAvailable` (master). i18n keys
  (en/zh, keep the locale-parity spec green): `notifications.preferences.email` ("Email"),
  `.emailMaster` ("Email notifications"), `.emailMasterHint` ("Turn off to stop all notification email"),
  `.emailUnavailable` ("Email is not set up on this koda server").

  Run: `cd apps/web && bun run test -- notification-settings-page useNotificationPreferences notifications-locale-parity` (FAIL then PASS).

- [ ] **Step 3: Mailpit in the test compose**

```yaml
# docker-compose.test.yml (add under services)
  mailpit-test:
    image: axllent/mailpit:v1.20
    ports:
      - "1026:1025"   # SMTP
      - "8026:8025"   # HTTP API
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8025/api/v1/info"]
      interval: 2s
      timeout: 3s
      retries: 20
```

- [ ] **Step 4: Write the e2e test**

```ts
// apps/api/test/e2e/email/notification-email.e2e.spec.ts
/**
 * Fleet S4b §8 mail e2e: real SmtpEmailProvider -> Mailpit. Assign -> schedule -> dispatcher tick -> message arrives.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 SMTP_URL=smtp://localhost:1026 EMAIL_FROM=koda@test.local WEB_PUBLIC_URL=http://koda.test bun run test:scoped test/e2e/email/notification-email.e2e.spec.ts
 */
```

Body: skip unless `KODA_DB_TESTS === '1'` and `SMTP_URL` is set; `resetDb()`; delete all Mailpit messages
(`DELETE http://localhost:8026/api/v1/messages`); boot with `bootHttpApp`; seed admin + user B + project (reuse
`seedFleetHttpWorld` or the members helpers used by `notifications-api.integration.spec.ts`); assign a ticket to B via
the API; deliver the outbox (`outboxRecord` + `FanOutPublisher.publish`, as in
`fleet-budget-approval-notifications.integration.spec.ts`); assert one `EmailSchedule` PENDING row for B; call
`app.get(EmailDispatcher).tick(new Date(Date.now() + 301_000))`; poll `GET http://localhost:8026/api/v1/messages` up
to 5 s; assert one message `To` B, subject starts with `[koda] `, HTML contains
`http://koda.test/<slug>/tickets/<ref>`. Second case: assign another ticket, mark the notification read via
`POST /api/me/notifications/:id/read`, tick, assert no new message and the row is `SKIPPED`/`READ`.

Add the e2e run to CI where integration tests run: in the workflow job that runs `test:integration`, set
`SMTP_URL=smtp://localhost:1026`, `EMAIL_FROM=koda@test.local`, `WEB_PUBLIC_URL=http://koda.test` and add the Mailpit
service (find the job with `git grep -n "test:integration" .github`).

- [ ] **Step 5: Run everything**

Run: `cd apps/api && bun run test && KODA_DB_TESTS=1 SMTP_URL=smtp://localhost:1026 EMAIL_FROM=koda@test.local WEB_PUBLIC_URL=http://koda.test bun run test:scoped test/e2e/email/notification-email.e2e.spec.ts`
Run: `bun run lint && bun run type-check` (repo root)
Expected: all green.

- [ ] **Step 6: Commit and open PR 2**

```bash
git add -A apps/api apps/web docker-compose.test.yml .github
git commit -m "feat: S4b B5 retention, web email preferences, Mailpit e2e"
git push -u origin feat/fleet-s4b-2-notification-email
gh pr create --title "feat: S4b PR 2 — notification email" --body "Spec slice 2 (D517-D519, D522). Refs S4b spec."
```

Fresh code review before push. After merge: koda-wk deploy (backup, migration), §9.x note. Email stays off on
koda-wk until Part D sets `SMTP_URL`.

---

# Part C — PR 3: project invites (spec slice 3)

Branch: `feat/fleet-s4b-3-project-invites` off `main` after PR 2 merges.

### Task C1: `ProjectInvite` model, token helper, repository

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (spec §2.3 model; back-relations `Project.invites ProjectInvite[]`, `User.sentInvites ProjectInvite[] @relation("ProjectInviteInvitedBy")`)
- Create: `apps/api/prisma/migrations/20261010110000_project_invites/migration.sql`
- Create: `apps/api/src/projects/invites/invite-token.ts` (+ spec)
- Create: `apps/api/src/projects/invites/prisma-project-invites.repository.ts`
- Create: `apps/api/src/projects/invites/domain/project-invite.domain.ts`
- Test: `apps/api/test/integration/projects/project-invites-repository.integration.spec.ts`

**Interfaces:**
- Produces:
  - `generateInviteToken(): { raw: string; hash: string }` (32 random bytes base64url; sha256 hex); `hashInviteToken(raw: string): string`.
  - `type InviteStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED'`; `interface ProjectInviteRecord { id; projectId; email; role: ProjectMemberRole; status: InviteStatus; invitedById; inviterName: string | null; acceptedByUserId: string | null; acceptedAt: Date | null; expiresAt: Date; createdAt: Date }`; `effectiveStatus(r, now): InviteStatus`.
  - `PrismaProjectInvitesRepository`: `cancelPending(projectId, email): Promise<number>`; `create(input: { projectId; email; role; tokenHash; invitedById; expiresAt }): Promise<ProjectInviteRecord>`; `list(projectId): Promise<ProjectInviteRecord[]>`; `findById(projectId, id): Promise<ProjectInviteRecord | null>`; `rotate(id, tokenHash, expiresAt): Promise<ProjectInviteRecord>`; `cancel(projectId, id): Promise<void>`; `findPendingByHash(tokenHash, now): Promise<(ProjectInviteRecord & { projectName: string; projectSlug: string }) | null>`; `acceptByHash(tokenHash, now): Promise<ProjectInviteRecord | null>` (conditional update); `setAcceptedBy(id, userId)`; `expireOverdue(now): Promise<number>`; `purgeFinal(before): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/projects/invites/invite-token.spec.ts
import { generateInviteToken, hashInviteToken } from './invite-token';

describe('invite token (S4b §4.1)', () => {
  it('is 32 random bytes base64url with a sha256 hex hash', () => {
    const { raw, hash } = generateInviteToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(raw)).toBe(hash);
  });
  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateInviteToken().raw));
    expect(seen.size).toBe(1000);
  });
});
```

Integration (`project-invites-repository.integration.spec.ts`, booted like B1): `acceptByHash` succeeds once and
returns `null` the second time; returns `null` for an expired or CANCELLED invite; `rotate` makes the old hash
unfindable; `cancelPending` cancels only PENDING rows of that project+email; `expireOverdue` flips overdue PENDING to
EXPIRED; two concurrent `acceptByHash` calls for one hash → exactly one non-null.

- [ ] **Step 2: Run to verify they fail** — `bun run test:scoped src/projects/invites && KODA_DB_TESTS=1 bun run test:scoped test/integration/projects/project-invites-repository.integration.spec.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/projects/invites/invite-token.ts
import { createHash, randomBytes } from 'crypto';

/** S4b §4.1: 256-bit token, base64url. Only the sha256 hex is stored. */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashInviteToken(raw) };
}

export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
```

Repository `acceptByHash` must be one conditional statement:

```ts
  /** Single-use (§4.2): only a PENDING, unexpired invite flips to ACCEPTED; a race or replay gets null. */
  async acceptByHash(tokenHash: string, now: Date): Promise<ProjectInviteRecord | null> {
    const rows = await this.db.projectInvite.updateManyAndReturn({
      where: { tokenHash, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', acceptedAt: now },
    });
    return rows[0] ? toRecord(rows[0], null) : null;
  }
```

(If `updateManyAndReturn` is unavailable for this client, use `$queryRaw` `UPDATE ... RETURNING *`.) Migration: table,
unique `tokenHash`, index `(projectId, email, status)`, FKs `Project ON DELETE CASCADE`, `User` (invitedBy)
`ON DELETE CASCADE`. Drift check as in A2.

- [ ] **Step 4: Run to verify they pass** — same commands → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): S4b C1 ProjectInvite model, token, repository"`.

### Task C2: `ProjectInvitesService` and admin routes

**Files:**
- Create: `apps/api/src/projects/invites/project-invites.service.ts` (+ spec)
- Create: `apps/api/src/projects/invites/project-invites.controller.ts` (+ spec)
- Create: `apps/api/src/projects/invites/invite-mailer.ts` (+ spec)
- Create: `apps/api/src/projects/invites/dto/{create-invite.dto,invite.dto,invite-result.dto}.ts`
- Create: `apps/api/src/projects/invites/project-invites.module.ts`; register in `AppModule`
- Create: `apps/api/src/i18n/en/invites.json`, `apps/api/src/i18n/zh/invites.json`

**Interfaces:**
- Consumes: C1; `ProjectAccessService.findProjectIdBySlug`, `.assertProjectAdmin`; `PrismaProjectMembersRepository.findUserIdByEmail`, `.createMember`; `EmailAvailability`; `EmailScheduleRepository.startInviteSend`, `.scheduleMemberAdded`; `EmailDispatcher.sendOne` (B4).
- Produces:
  - `CreateInviteDto { email: string; role: ProjectMemberRole }` (`@IsEmail`, `@MaxLength(254)`, `@IsIn(PROJECT_MEMBER_ROLES)`).
  - `InviteResult = { outcome: 'ADDED'; member: ProjectMemberDto } | { outcome: 'INVITED'; invite: InviteDto; invitePath: string; emailed: boolean }`.
  - `InviteDto { id; email; role; status: InviteStatus; inviterName: string | null; expiresAt: string; createdAt: string }` (no token).
  - `ProjectInvitesService.create(slug, dto, principal, locale)`, `.list(slug, principal)`, `.resend(slug, id, principal, locale): Promise<{ invite; invitePath; emailed }>`, `.cancel(slug, id, principal)`.
  - `InviteMailer.sendInvite(input: { inviteId; toEmail; locale; rawToken; projectName; inviterName; role; expiresAt: Date }): Promise<boolean>` (true = emailed).
  - Routes: `POST/GET /projects/:slug/invites`, `POST /projects/:slug/invites/:id/resend`, `DELETE /projects/:slug/invites/:id`.

- [ ] **Step 1: Write the failing service tests** (`project-invites.service.spec.ts`, fakes for repos, access, mailer, email availability, clock via `jest.useFakeTimers().setSystemTime`):

```ts
describe('ProjectInvitesService.create (S4b §4.2)', () => {
  it('normalises the email and finds a legacy mixed-case user (Review Focus 1)', async () => {
    const { service, members } = setup({ existingUser: { id: 'u9', disabled: false } });
    const res = await service.create('p', { email: ' New@X.io ', role: 'DEVELOPER' }, admin, 'en');
    expect(members.findUserIdByEmail).toHaveBeenCalledWith('new@x.io');
    expect(res.outcome).toBe('ADDED');
  });

  it('adds an existing active user and schedules MEMBER_ADDED when email is configured', async () => {
    const { service, schedule } = setup({ existingUser: { id: 'u9', disabled: false } });
    await service.create('p', { email: 'b@x.io', role: 'VIEWER' }, admin, 'en');
    expect(schedule.scheduleMemberAdded).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9', projectId: 'p1', toEmail: 'b@x.io' }));
  });

  it('409 USER_DISABLED for a disabled account, 409 MEMBER_EXISTS for a member', async () => {
    await expect(setup({ existingUser: { id: 'u9', disabled: true } }).service.create('p', { email: 'b@x.io', role: 'VIEWER' }, admin, 'en'))
      .rejects.toMatchObject({ status: 409 });
    const s = setup({ existingUser: { id: 'u9', disabled: false }, memberExists: true });
    await expect(s.service.create('p', { email: 'b@x.io', role: 'VIEWER' }, admin, 'en')).rejects.toMatchObject({ status: 409 });
  });

  it('invites a new email: cancels the previous pending invite, stores only the hash, returns the path once', async () => {
    const { service, invites, mailer } = setup({ existingUser: null });
    const res = await service.create('p', { email: 'new@x.io', role: 'DEVELOPER' }, admin, 'en');
    expect(invites.cancelPending).toHaveBeenCalledWith('p1', 'new@x.io');
    const stored = invites.create.mock.calls[0][0];
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res).toMatchObject({ outcome: 'INVITED', emailed: true });
    if (res.outcome !== 'INVITED') throw new Error('unreachable');
    expect(res.invitePath).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(res.invite)).not.toContain(res.invitePath.slice(8));
    expect(mailer.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ rawToken: res.invitePath.slice(8) }));
  });

  it('without SMTP: no mail, emailed false, invite still created (D520)', async () => {
    const { service, mailer } = setup({ existingUser: null, configured: false });
    await expect(service.create('p', { email: 'new@x.io', role: 'DEVELOPER' }, admin, 'en')).resolves.toMatchObject({ outcome: 'INVITED', emailed: false });
    expect(mailer.sendInvite).not.toHaveBeenCalled();
  });

  it('a failed invite email is not an error: emailed false (D526)', async () => {
    const { service, mailer } = setup({ existingUser: null });
    mailer.sendInvite.mockResolvedValueOnce(false);
    await expect(service.create('p', { email: 'new@x.io', role: 'DEVELOPER' }, admin, 'en')).resolves.toMatchObject({ emailed: false });
  });

  it('requires a project admin', async () => {
    const { service, access } = setup({ existingUser: null });
    access.assertProjectAdmin.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(service.create('p', { email: 'new@x.io', role: 'DEVELOPER' }, admin, 'en')).rejects.toMatchObject({ status: 403 });
  });
});

describe('resend / cancel / list', () => {
  const NOW = new Date('2026-10-10T10:00:00Z');
  const invite = (over = {}) => ({ id: 'i1', projectId: 'p1', email: 'new@x.io', role: 'DEVELOPER', status: 'PENDING', invitedById: 'admin',
    inviterName: 'Ada', acceptedByUserId: null, acceptedAt: null, expiresAt: new Date(NOW.getTime() + 86_400_000), createdAt: NOW, ...over });

  beforeEach(() => { jest.useFakeTimers().setSystemTime(NOW); });
  afterEach(() => { jest.useRealTimers(); });

  it('resend rotates the hash and expiry of a PENDING or expired invite and returns a new path', async () => {
    for (const current of [invite(), invite({ expiresAt: new Date(NOW.getTime() - 1) })]) {
      const { service, invites, mailer } = setup({ existingUser: null });
      invites.findById.mockResolvedValueOnce(current);
      const res = await service.resend('p', 'i1', admin, 'en');
      const [id, hash, expiresAt] = invites.rotate.mock.calls[0];
      expect(id).toBe('i1');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(expiresAt).toEqual(new Date(NOW.getTime() + 7 * 86_400_000));
      expect(res.invitePath).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
      expect(mailer.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ rawToken: res.invitePath.slice(8) }));
    }
  });

  it('resend of an ACCEPTED or CANCELLED invite is 409', async () => {
    for (const status of ['ACCEPTED', 'CANCELLED']) {
      const { service, invites } = setup({ existingUser: null });
      invites.findById.mockResolvedValueOnce(invite({ status }));
      await expect(service.resend('p', 'i1', admin, 'en')).rejects.toMatchObject({ status: 409 });
      expect(invites.rotate).not.toHaveBeenCalled();
    }
  });

  it('resend or cancel of an unknown invite is 404', async () => {
    const { service, invites } = setup({ existingUser: null });
    invites.findById.mockResolvedValue(null);
    await expect(service.resend('p', 'nope', admin, 'en')).rejects.toMatchObject({ status: 404 });
    await expect(service.cancel('p', 'nope', admin)).rejects.toMatchObject({ status: 404 });
  });

  it('cancel is idempotent for final invites', async () => {
    const { service, invites } = setup({ existingUser: null });
    invites.findById.mockResolvedValueOnce(invite({ status: 'ACCEPTED' }));
    await expect(service.cancel('p', 'i1', admin)).resolves.toBeUndefined();
    expect(invites.cancel).not.toHaveBeenCalled();
    invites.findById.mockResolvedValueOnce(invite());
    await service.cancel('p', 'i1', admin);
    expect(invites.cancel).toHaveBeenCalledWith('p1', 'i1');
  });

  it('list returns effective status (overdue PENDING shows EXPIRED) and no token', async () => {
    const { service, invites } = setup({ existingUser: null });
    invites.list.mockResolvedValueOnce([invite(), invite({ id: 'i2', expiresAt: new Date(NOW.getTime() - 1) })]);
    const rows = await service.list('p', admin);
    expect(rows.map((r) => r.status)).toEqual(['PENDING', 'EXPIRED']);
    expect(rows.every((r) => !('tokenHash' in r))).toBe(true);
  });
});
```

The `setup()` used by both `describe` blocks returns fakes `{ service, invites, members, access, mailer, schedule }`:
`invites` has `cancelPending`, `create` (returns `invite()` built from its input), `list`, `findById`, `rotate`
(returns its updated record), `cancel`; `members` has `findUserIdByEmail` (returns `existingUser?.id ?? null`),
`findUserState` (returns `existingUser`), `createMember` (throws a P2002 `isUniqueViolation`-shaped error when
`memberExists`); `access` has `findProjectIdBySlug` (→ `'p1'`) and `assertProjectAdmin`; `mailer.sendInvite` resolves
`true`; `email` is `{ configured: configured ?? true, config: () => ({ inviteTtlDays: 7 }) }`; `txManager.run` calls
its callback. `admin` is a user principal with `role: 'ADMIN'`. Add `findUserState(userId): Promise<{ id; email; disabled } | null>`
to `PrismaProjectMembersRepository` in this task.

`InviteMailer` spec: creates the `INVITE` row via `startInviteSend`, calls `dispatcher.sendOne(row, 'INVITE', data,
null, now, false)` with `data.url === 'https://k.x/invite/<raw>'`, returns `true` on `'SENT'` and `false` on
`'FAILED'`; a thrown error is caught, logged without the token, returns `false`.

- [ ] **Step 2: Run to verify they fail** — `bun run test:scoped src/projects/invites` → FAIL.

- [ ] **Step 3: Implement**

`ProjectInvitesService.create` order: `findProjectIdBySlug` → `assertProjectAdmin` → `email = dto.email.trim().toLowerCase()`
→ `findUserIdByEmail(email)` (case-insensitive) → existing user: load `disabled` (409 `invites.userDisabled` if true),
`createMember` (unique violation → 409 `invites.memberExists`), if `email.configured` `scheduleMemberAdded({ userId,
projectId, toEmail: user.email, locale, dueAt: now })`, return `ADDED`. No user: inside `txManager.run`
`cancelPending` + `create` with `generateInviteToken()` hash and `expiresAt = now + inviteTtlDays`; after commit, if
configured `emailed = await mailer.sendInvite(...)`; return `INVITED` with `invitePath: '/invite/' + raw`.

`locale` comes from the controller: `@Headers('accept-language')` → `'zh'` if it starts with `zh`, else `'en'`.

i18n `invites.json` (en):

```json
{
  "404": "Invite not found",
  "40003": "Project admin role required",
  "-2": "Validation error",
  "memberExists": { "409": "User is already a member of this project" },
  "userDisabled": { "409": "This user account is disabled" },
  "notResendable": { "409": "Only pending or expired invites can be re-sent" },
  "accountExists": { "409": "An account with this email already exists. Ask a project admin to add you." }
}
```

zh: same keys — `"未找到邀请"`, `"需要项目管理员权限"`, `"验证错误"`, `"该用户已是项目成员"`, `"该用户账号已停用"`,
`"只能重新发送待处理或已过期的邀请"`, `"该邮箱已有账号，请联系项目管理员将你加入项目"`.

Controller mirrors `ProjectMembersController` (decorators, `JsonResponse.Ok`, `@ApiResponse` 201/403/404/409).

- [ ] **Step 4: Run to verify they pass** — `bun run test:scoped src/projects/invites` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): S4b C2 project invite admin routes and invite mail"`.

### Task C3: Public lookup and accept

**Files:**
- Create: `apps/api/src/auth/auth-throttle.ts`; modify `apps/api/src/auth/auth.controller.ts` to import `AUTH_LOGIN_LIMIT` from it
- Modify: `apps/api/src/auth/auth.service.ts` (public `issueSession`)
- Create: `apps/api/src/projects/invites/public-invites.controller.ts`
- Create: `apps/api/src/projects/invites/invite-acceptance.service.ts` (+ spec)
- Create: `apps/api/src/projects/invites/dto/{accept-invite.dto,invite-preview.dto}.ts`
- Test: `apps/api/test/integration/projects/project-invites-api.integration.spec.ts`

**Interfaces:**
- Consumes: C1 repository; `AuthService`.
- Produces:
  - `AUTH_LOGIN_LIMIT: number` exported from `auth/auth-throttle.ts`.
  - `AuthService.issueSession(user: { id; email; role; tokenVersion } & UserResponseSource): { accessToken; refreshToken; user: UserResponseDto }` (login/register/refresh call it).
  - `AcceptInviteDto { name: string (1-100); password: string (RegisterDto rules: MinLength 8 + PASSWORD_COMPLEXITY) }`.
  - `InvitePreviewDto { projectName; projectSlug; email; role; inviterName: string | null; expiresAt: string }`.
  - `GET /invites/:token` (`@Public()`, `@Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: 60000 } })`) → `InvitePreviewDto`; `POST /invites/:token/accept` (same) → same body as `/auth/login`.

- [ ] **Step 1: Write the failing API integration test** (boot with `bootHttpApp({ registrationEnabled: false })`, seed a global admin, a project and an invite created through `POST /api/projects/:slug/invites` so the raw token comes from the response):

```ts
// apps/api/test/integration/projects/project-invites-api.integration.spec.ts
/**
 * Fleet S4b §4.2: public preview and accept over HTTP. Booted with registration closed (accept ignores it).
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/projects/project-invites-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30_000);
const STRONG = 'Strong1!pass';

describeIntegration('project invites API (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let server: Parameters<typeof request>[0];
  let adminToken: string;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });  // first user = bootstrap admin
    server = app.getHttpServer();
    prisma = app.get(PrismaService).client as PrismaClient;
    await request(server).post('/api/auth/register').send({ email: 'admin@x.io', name: 'Ada', password: TEST_PASSWORD }).expect(201);
    await app.close();
    app = await bootHttpApp({ registrationEnabled: false });  // invites must work with registration closed
    server = app.getHttpServer();
    prisma = app.get(PrismaService).client as PrismaClient;
    adminToken = await loginToken(server, 'admin@x.io');
    await request(server).post('/api/projects').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Koda', slug: 'koda', key: 'KODA' }).expect(201);
  });
  afterAll(async () => { await app?.close(); });

  const invite = async (email = `new${++n}@x.io`, role = 'DEVELOPER') => {
    const res = await request(server).post('/api/projects/koda/invites').set('Authorization', `Bearer ${adminToken}`).send({ email, role }).expect(201);
    const body = data<{ outcome: string; invitePath: string; invite: { id: string } }>(res);
    return { email, raw: body.invitePath.slice('/invite/'.length), id: body.invite.id };
  };
  const accept = (raw: string, password = STRONG) => request(server).post(`/api/invites/${raw}/accept`).send({ name: 'Nia', password });

  it('preview of a valid token returns project, role, email and inviter', async () => {
    const { raw, email } = await invite();
    const res = await request(server).get(`/api/invites/${raw}`).expect(200);
    expect(data(res)).toMatchObject({ projectName: 'Koda', projectSlug: 'koda', email, role: 'DEVELOPER', inviterName: 'Ada' });
  });

  it('accept creates a MEMBER user and the project membership and returns a session', async () => {
    const { raw, email } = await invite(undefined, 'VIEWER');
    const res = await accept(raw).expect((r) => expect([200, 201]).toContain(r.status));
    const session = data<{ accessToken: string; user: { email: string; role: string } }>(res);
    expect(session.user).toMatchObject({ email, role: 'MEMBER' });
    await request(server).get('/api/projects/koda').set('Authorization', `Bearer ${session.accessToken}`).expect(200);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(await prisma.projectMember.findFirst({ where: { userId: user.id } })).toMatchObject({ role: 'VIEWER' });
  });

  it('a second accept of the same token is 404 (Review Focus 5)', async () => {
    const { raw } = await invite();
    await accept(raw);
    const users = await prisma.user.count();
    await accept(raw).expect(404);
    expect(await prisma.user.count()).toBe(users);
  });

  it('the token from before a resend is 404 (Review Focus 5)', async () => {
    const { raw, id } = await invite();
    await request(server).post(`/api/projects/koda/invites/${id}/resend`).set('Authorization', `Bearer ${adminToken}`).expect((r) => expect([200, 201]).toContain(r.status));
    await request(server).get(`/api/invites/${raw}`).expect(404);
    await accept(raw).expect(404);
  });

  it('expired, cancelled and unknown tokens all give the same 404 body', async () => {
    const expired = await invite();
    await prisma.projectInvite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const cancelled = await invite();
    await request(server).delete(`/api/projects/koda/invites/${cancelled.id}`).set('Authorization', `Bearer ${adminToken}`).expect((r) => expect([200, 204]).toContain(r.status));
    const bodies = await Promise.all([expired.raw, cancelled.raw, 'x'.repeat(43)].map(async (raw) => (await request(server).get(`/api/invites/${raw}`).expect(404)).body));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('accept returns 409 when an account with the email appeared after the invite, and creates nothing', async () => {
    const { raw, email, id } = await invite();
    await request(server).post('/api/admin/users').set('Authorization', `Bearer ${adminToken}`).send({ email, name: 'Late', password: STRONG, role: 'MEMBER' }).expect(201);
    const members = await prisma.projectMember.count();
    await accept(raw).expect(409);
    expect(await prisma.projectMember.count()).toBe(members);
    expect((await prisma.projectInvite.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
  });

  it('rejects a weak password with 400 and leaves the invite PENDING', async () => {
    const { raw, id } = await invite();
    await accept(raw, 'short').expect(400);
    expect((await prisma.projectInvite.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
  });
});
```

Throttle: this file makes more than 5 public invite calls per minute from one IP, and `AUTH_LOGIN_LIMIT` is read
at class-load time. First check how `test/integration/auth/*` avoids 429s and follow it; if nothing does, set
`AUTH_LOGIN_THROTTLE_LIMIT=100` in the api Jest setup that runs before modules load (the `setupFiles` entry in
`apps/api/package.json` jest config; create `test/setup-env.ts` if there is none), mirroring
`apps/web/playwright.config.ts:62`. Do not lower the production default.

Confirm the request bodies for `POST /api/projects` and `POST /api/admin/users` against their DTOs before running
(`git grep -n "class CreateProjectDto\|class CreateUserDto" apps/api/src`); adjust field names only. The 409 case
relies on the transaction rolling back the ACCEPTED flip — that is the point of the test.

Unit spec for `InviteAcceptanceService`: the order is `acceptByHash` → existing-account check (→ throw 409, which
rolls back the transaction) → create user (`bcrypt.hash(password, 12)`, role `MEMBER`, email from invite) →
`setAcceptedBy` → `createMember`; all inside `txManager.run`; `issueSession` only after the transaction resolves.

- [ ] **Step 2: Run to verify it fails** — `KODA_DB_TESTS=1 bun run test:scoped test/integration/projects/project-invites-api.integration.spec.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/auth/auth-throttle.ts
/**
 * Login/register/logout and public invite throttle. Defaults to 5/min; E2E raises it via
 * AUTH_LOGIN_THROTTLE_LIMIT (moved from auth.controller.ts so invite routes share it).
 */
const AUTH_LIMIT = Number.parseInt(process.env['AUTH_LOGIN_THROTTLE_LIMIT'] ?? '5', 10);
export const AUTH_LOGIN_LIMIT = Number.isFinite(AUTH_LIMIT) && AUTH_LIMIT > 0 ? AUTH_LIMIT : 5;
```

`AuthService.issueSession(user)` returns `{ accessToken: this.generateAccessToken(...), refreshToken:
this.generateRefreshToken(...), user: UserResponseDto.from(user) }`; replace the three duplicated blocks in
`register`, `login`, `refresh` with it (existing auth specs must stay green).

`InviteAcceptanceService.accept(rawToken, dto)`:

```ts
  async accept(rawToken: string, dto: AcceptInviteDto) {
    const tokenHash = hashInviteToken(rawToken);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.txManager.run(async () => {
      const invite = await this.invites.acceptByHash(tokenHash, new Date());
      if (!invite) throw new NotFoundAppException({}, 'invites');
      if (await this.members.findUserIdByEmail(invite.email)) throw new ConflictAppException({}, 'invites.accountExists');
      const created = await this.users.createUser({ email: invite.email, name: dto.name.trim(), passwordHash, role: 'MEMBER' });
      await this.invites.setAcceptedBy(invite.id, created.id);
      await this.members.createMember(invite.projectId, created.id, invite.role);
      return created;
    });
    return this.auth.issueSession(user);
  }
```

(`this.users` is the existing users repository used by `UsersAdminService.create`; import its module. Hash the
password before the transaction so bcrypt does not hold row locks.) Map the public 404 so every invalid state
returns the identical body.

- [ ] **Step 4: Run to verify it passes** — the integration file plus `bun run test:scoped src/auth src/projects/invites` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): S4b C3 public invite preview and accept"`.

### Task C4: Invite retention, contract regeneration, CLI

**Files:**
- Modify: `apps/api/src/notifications/notification-retention.processor.ts` (+ spec) — invites `expireOverdue(now)` then `purgeFinal(now - 30d)`, each log-and-swallow
- Run: `bun run generate`
- Modify: `apps/cli/src/commands/member.ts` (+ `member.spec.ts`)

**Interfaces:**
- Consumes: C1 repository; generated `projectInvitesControllerCreate`, `projectInvitesControllerList`, `projectInvitesControllerResend`, `projectInvitesControllerCancel` (names: confirm in `apps/cli/src/generated/sdk.gen.ts` after generate).
- Produces: `koda member invite --email <e> --role <r> [--project <slug>] [--json]`; `koda member invites [--project <slug>] [--cancel <id>] [--resend <id>] [--json]`.

- [ ] **Step 1: Retention test first** (same shape as B5 Step 1: invite purge runs even when the notification purge throws). Implement, run, PASS.

- [ ] **Step 2: Regenerate** — `bun run generate`; Expected: new invite operations in `openapi.json` and the generated client.

- [ ] **Step 3: CLI tests first** (add to `member.spec.ts`; add the four generated fns to the `jest.mock('../generated', ...)` factory):

```ts
it('invite prints the outcome and the path when not emailed', async () => {
  (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: { outcome: 'INVITED', emailed: false, invitePath: '/invite/abc', invite: { id: 'i1', email: 'n@x.io', role: 'DEVELOPER' } } });
  await program.parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER']);
  expect(projectInvitesControllerCreate).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, body: { email: 'n@x.io', role: 'DEVELOPER' } });
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('/invite/abc'));
});
it('invite reports ADDED for an existing user', async () => {
  (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: { outcome: 'ADDED', member: { email: 'n@x.io', role: 'DEVELOPER' } } });
  await program.parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER']);
  expect(console.log).toHaveBeenCalledWith('Added n@x.io as DEVELOPER');
});
it('invites lists pending invites in a table', async () => {
  (projectInvitesControllerList as jest.Mock).mockResolvedValue({ data: { ret: 0, data: [
    { id: 'i1', email: 'n@x.io', role: 'VIEWER', status: 'PENDING', expiresAt: '2026-10-17T00:00:00.000Z' },
  ] } });
  await program.parseAsync(['node', 'koda', 'member', 'invites']);
  const printed = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
  expect(printed).toMatch(/ID.*Email.*Role.*Status.*Expires/);
  expect(printed).toContain('n@x.io');
});
it('invites --cancel <id> cancels', async () => {
  (projectInvitesControllerCancel as jest.Mock).mockResolvedValue({ ret: 0, data: {} });
  await program.parseAsync(['node', 'koda', 'member', 'invites', '--cancel', 'i1']);
  expect(projectInvitesControllerCancel).toHaveBeenCalledWith({ path: { slug: 'my-proj', id: 'i1' } });
});
it('invites --resend <id> prints the new path', async () => {
  (projectInvitesControllerResend as jest.Mock).mockResolvedValue({ ret: 0, data: { invitePath: '/invite/new', emailed: false, invite: { id: 'i1', email: 'n@x.io' } } });
  await program.parseAsync(['node', 'koda', 'member', 'invites', '--resend', 'i1']);
  expect(projectInvitesControllerResend).toHaveBeenCalledWith({ path: { slug: 'my-proj', id: 'i1' } });
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('/invite/new'));
});
```

Implement in `member.ts` following the `add` command's structure (`withContext`, `unwrap`, `handleApiError`). Print
`Invite created for <email>. Emailed.` or `Invite created for <email>. Share this link (shown once): <path>` — the CLI
prints the path; the user prefixes their web origin (no web URL in CLI config).

Run: `cd apps/cli && bun run test -- member` → PASS.

- [ ] **Step 4: Commit** — `git commit -m "feat: S4b C4 invite retention, contract, CLI"`.

### Task C5: Web — invite dialog and pending invites

**Files:**
- Create: `apps/web/composables/useProjectInvites.ts`
- Create: `apps/web/components/ProjectInvitesPanel.vue`
- Modify: the page that renders `ProjectMembersPanel` (find with `git grep -n "ProjectMembersPanel" apps/web/pages`) to render `ProjectInvitesPanel` below it when `canManage`
- Modify: `apps/web/i18n/locales/{en,zh}.json` (`projects.invites.*`)
- Test: `apps/web/tests/components/ProjectInvitesPanel.spec.ts`

**Interfaces:**
- Produces: `useProjectInvites(slug)` → `{ invites, load, create(email, role): Promise<InviteResult>, resend(id): Promise<{ invitePath: string; emailed: boolean }>, cancel(id) }`; `inviteLink(path: string): string` = `window.location.origin + path`.

- [ ] **Step 1: Component test first** (mount harness as in `tests/pages/notification-settings-page.spec.ts`):

```ts
// apps/web/tests/components/ProjectInvitesPanel.spec.ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'

const panel = webFile('components', 'ProjectInvitesPanel.vue')

function mountPanel(over: Record<string, unknown> = {}) {
  const fake = {
    invites: ref([{ id: 'i1', email: 'p@x.io', role: 'VIEWER', status: 'PENDING', inviterName: 'Ada', expiresAt: '2026-10-17T00:00:00Z', createdAt: '2026-10-10T00:00:00Z' }]),
    load: jest.fn(async () => undefined),
    create: jest.fn(async () => ({ outcome: 'INVITED', emailed: false, invitePath: '/invite/tok123', invite: { id: 'i2' } })),
    resend: jest.fn(async () => ({ invitePath: '/invite/tok456', emailed: true })),
    cancel: jest.fn(async () => undefined),
    ...over,
  }
  const toast = toastRecorder()
  const app = mountSfc(panel, {
    props: { slug: 'koda' },
    components: uiStubs,
    alias: { '~/composables/useProjectInvites': { useProjectInvites: () => fake, inviteLink: (p: string) => `http://web.test${p}` } },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) { await new Promise((resolve) => { setImmediate(resolve) }); await Vue.nextTick() }
  }
  const find = (id: string) => app.find(`[data-testid="${id}"]`)[0]
  return { app, fake, toast, settle, find }
}

describe('ProjectInvitesPanel (S4b §4.4)', () => {
  test('creating an invite shows the link once with the not-emailed note', async () => {
    const p = mountPanel()
    await p.settle()
    ;(p.find('invite-email').props.onInput as (e: unknown) => void)?.({ target: { value: 'new@x.io' } })
    ;(p.find('invite-submit').props.onClick as () => Promise<void>)()
    await p.settle()
    expect(p.fake.create).toHaveBeenCalledWith('new@x.io', 'DEVELOPER')
    expect(p.find('invite-link').props.value ?? p.find('invite-link').text()).toContain('http://web.test/invite/tok123')
    expect(p.app.text()).toContain('was not emailed')
  })

  test('ADDED shows the added toast and emits member-added, with no link', async () => {
    const p = mountPanel({ create: jest.fn(async () => ({ outcome: 'ADDED', member: { email: 'b@x.io', role: 'DEVELOPER' } })) })
    await p.settle()
    ;(p.find('invite-email').props.onInput as (e: unknown) => void)?.({ target: { value: 'b@x.io' } })
    ;(p.find('invite-submit').props.onClick as () => Promise<void>)()
    await p.settle()
    expect(p.find('invite-link')).toBeUndefined()
    expect(p.app.emitted('member-added')).toBeTruthy()
  })

  test('resend shows the new link; cancel confirms then calls cancel', async () => {
    const confirm = jest.fn(() => true)
    ;(globalThis as { window?: unknown }).window = { confirm }
    const p = mountPanel()
    await p.settle()
    ;(p.find('invite-resend-i1').props.onClick as () => Promise<void>)()
    await p.settle()
    expect(p.fake.resend).toHaveBeenCalledWith('i1')
    expect(p.app.text()).toContain('http://web.test/invite/tok456')
    ;(p.find('invite-cancel-i1').props.onClick as () => Promise<void>)()
    await p.settle()
    expect(confirm).toHaveBeenCalled()
    expect(p.fake.cancel).toHaveBeenCalledWith('i1')
  })

  test('closing the link box clears it for good', async () => {
    const p = mountPanel()
    await p.settle()
    ;(p.find('invite-email').props.onInput as (e: unknown) => void)?.({ target: { value: 'new@x.io' } })
    ;(p.find('invite-submit').props.onClick as () => Promise<void>)()
    await p.settle()
    ;(p.find('invite-link-close').props.onClick as () => void)()
    await p.settle()
    expect(p.find('invite-link')).toBeUndefined()
  })
})
```

  The harness's event-prop names (`onInput` vs `onUpdate:modelValue` for the `Input` stub) and `app.emitted` follow
  `tests/helpers/mount-sfc.ts`; read it first and adapt only those accessors, not the asserted behaviour.
- [ ] **Step 2: Run** `cd apps/web && bun run test -- ProjectInvitesPanel` → FAIL.
- [ ] **Step 3: Implement** the composable and component with the existing UI kit (`Dialog`, `Input`, `Select`, `Button`, `Badge` as used in `ProjectMembersPanel.vue`); copy uses `navigator.clipboard.writeText` with a toast. i18n keys (en/zh): `projects.invites.title`, `.inviteButton`, `.email`, `.role`, `.send`, `.added`, `.created`, `.emailed`, `.notEmailed`, `.copy`, `.copied`, `.shownOnce`, `.resend`, `.cancel`, `.cancelConfirm`, `.status.{PENDING,ACCEPTED,EXPIRED,CANCELLED}`, `.expires`, `.empty`.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(web): S4b C5 invite dialog and pending invites"`.

### Task C6: Web — public accept page, Nitro route, Playwright, PR 3

**Files:**
- Create: `apps/web/server/api/invites/[token]/accept.post.ts`
- Modify: `apps/web/composables/useAuth.ts` (`acceptInvite`)
- Modify: `apps/web/middleware/auth.global.ts`
- Create: `apps/web/pages/invite/[token].vue`
- Modify: `apps/web/i18n/locales/{en,zh}.json` (`invite.*`)
- Test: `apps/web/tests/pages/invite-accept.spec.ts`, `apps/web/tests/middleware/auth-global.spec.ts` (create or extend), `apps/web/e2e/invite.spec.ts` (Playwright; match the existing e2e directory — `git ls-files apps/web | grep playwright.config`)

**Interfaces:**
- Produces: `useAuth().acceptInvite(token: string, body: { name: string; password: string }): Promise<void>`; public route prefix `/invite/`.

- [ ] **Step 1: Tests first**

```ts
// apps/web/tests/middleware/auth.spec.ts — add (source-level, like the existing cases in this file)
describe('S4b R6: invite links are public', () => {
  test('/invite/* returns before the unauthenticated redirect', () => {
    const source = readFileSync(middlewarePath, 'utf-8')
    const publicIdx = source.indexOf("to.path.startsWith('/invite/')")
    const redirectIdx = source.indexOf("navigateTo('/login')")
    expect(publicIdx).toBeGreaterThan(-1)
    expect(publicIdx).toBeLessThan(redirectIdx)
  })
})
```

```ts
// apps/web/tests/pages/invite-accept.spec.ts
import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'

const page = webFile('pages', 'invite', '[token].vue')
const PREVIEW = { projectName: 'Koda', projectSlug: 'koda', email: 'new@x.io', role: 'DEVELOPER', inviterName: 'Ada', expiresAt: '2026-10-17T00:00:00Z' }

function mountPage(opts: { preview?: unknown; previewError?: number; authed?: boolean; acceptError?: number } = {}) {
  const navigateTo = jest.fn()
  const acceptInvite = jest.fn(async () => { if (opts.acceptError) throw Object.assign(new Error('x'), { statusCode: opts.acceptError }) })
  const get = jest.fn(async () => { if (opts.previewError) throw Object.assign(new Error('x'), { statusCode: opts.previewError }); return opts.preview ?? PREVIEW })
  const app = mountSfc(page, {
    components: uiStubs,
    globals: {
      useI18n: () => enI18n(), useAppToast: () => toastRecorder(), definePageMeta: () => undefined, navigateTo,
      useRoute: () => ({ params: { token: 'tok123' } }),
      useApi: () => ({ $api: { get } }),
      useAuth: () => ({ isAuthenticated: ref(!!opts.authed), acceptInvite, logout: jest.fn() }),
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) { await new Promise((resolve) => { setImmediate(resolve) }); await Vue.nextTick() }
  }
  return { app, get, acceptInvite, navigateTo, settle }
}

describe('/invite/[token] (S4b §4.4)', () => {
  test('shows the project, role and email from the preview', async () => {
    const p = mountPage()
    await p.settle()
    expect(p.get).toHaveBeenCalledWith('/invites/tok123')
    expect(p.app.text()).toContain('Koda')
    expect(p.app.text()).toContain('new@x.io')
  })
  test('an invalid link shows the invalid message and no form', async () => {
    const p = mountPage({ previewError: 404 })
    await p.settle()
    expect(p.app.text()).toContain('This invite link is invalid or has expired')
    expect(p.app.find('[data-testid="invite-accept-form"]')[0]).toBeUndefined()
  })
  test('a signed-in visitor is told to sign out first', async () => {
    const p = mountPage({ authed: true })
    await p.settle()
    expect(p.app.find('[data-testid="invite-signed-in"]')[0]).toBeDefined()
    expect(p.app.find('[data-testid="invite-accept-form"]')[0]).toBeUndefined()
  })
  test('submitting accepts and navigates to the project', async () => {
    const p = mountPage()
    await p.settle()
    await (p.app.find('[data-testid="invite-accept-form"]')[0].props.onSubmit as (v: unknown) => Promise<void>)({ name: 'Nia', password: 'Strong1!pass' })
    await p.settle()
    expect(p.acceptInvite).toHaveBeenCalledWith('tok123', { name: 'Nia', password: 'Strong1!pass' })
    expect(p.navigateTo).toHaveBeenCalledWith('/koda')
  })
  test('409 shows the account-exists message', async () => {
    const p = mountPage({ acceptError: 409 })
    await p.settle()
    await (p.app.find('[data-testid="invite-accept-form"]')[0].props.onSubmit as (v: unknown) => Promise<void>)({ name: 'Nia', password: 'Strong1!pass' })
    await p.settle()
    expect(p.app.text()).toContain('An account with this email already exists')
  })
})
```

  The page uses vee-validate like `register.vue`; if the harness cannot drive `handleSubmit`, export the submit
  handler as a plain `onAccept(values)` function wired to the form and call that prop instead (keep the assertion).
  i18n keys (en/zh): `invite.title`, `.subtitle` ("{inviter} invited you to {project} as {role}"), `.name`,
  `.password`, `.accept`, `.invalid` ("This invite link is invalid or has expired"), `.accountExists` ("An account
  with this email already exists. Ask a project admin to add you."), `.signedIn` ("You are signed in. Sign out to
  accept this invite with a new account."), `.signOut`.
- [ ] **Step 2: Run** `cd apps/web && bun run test -- auth.spec invite-accept` → FAIL.
- [ ] **Step 3: Implement**

```ts
// apps/web/server/api/invites/[token]/accept.post.ts
/** Fleet S4b R6: accept + set the httpOnly session cookies, mirroring server/api/auth/register.post.ts. */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  const body = await readBody<{ name: string; password: string }>(event)
  const { status, body: responseBody } = await forwardToApi(event, `/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body })
  if (status >= 400) {
    throw createError({
      statusCode: status,
      statusMessage: typeof responseBody === 'object' && responseBody && 'message' in responseBody
        ? String((responseBody as { message?: unknown }).message)
        : 'Invite acceptance failed',
      data: responseBody,
    })
  }
  const data = unwrapAuth(responseBody as { ret?: number; data?: { accessToken?: string; refreshToken?: string; user?: Record<string, unknown> } })
  setAuthCookies(event, { accessToken: data.accessToken, refreshToken: data.refreshToken })
  return { user: data.user }
})
```

```ts
// middleware/auth.global.ts — before the unauthenticated redirect:
  // Fleet S4b R6: invite links are public; the page handles signed-in visitors itself.
  if (to.path.startsWith('/invite/')) return
```

`useAuth.acceptInvite` posts to `/api/invites/${token}/accept` and sets `user.value` (same as `register`). The page
uses `definePageMeta({ layout: 'auth' })` and the `register.vue` form pattern (vee-validate + zod: name min 1,
password min 8 + the same complexity regex as the API).

- [ ] **Step 4: Playwright**

```ts
// apps/web/tests/e2e/invite.e2e.spec.ts
import { test, expect } from '@playwright/test';
import { createProject, deleteProject, login, E2E_ADMIN } from './fixtures/api-client';
import { generateUniqueProjectKey, waitForHydration, webLogin } from './fixtures/page-helpers';

/** Fleet S4b §8: invite by email without SMTP -> copy link -> accept in a fresh context -> member of the project. */
test.describe('Project invites (S4b)', () => {
  let token: string;
  let slug: string;
  const email = `invitee-${Date.now()}@koda-e2e.test`;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    slug = (await createProject(token, { name: 'E2E Invite', slug: `e2einv${suffix}`, key: generateUniqueProjectKey('IV') })).slug;
  });
  test.afterAll(async () => { if (slug) await deleteProject(token, slug); });

  test('admin invites, invitee accepts from the link and lands on the project', async ({ page, browser }) => {
    await webLogin(page);
    await page.goto(`/${slug}/settings`);
    await waitForHydration(page);
    await page.getByTestId('invite-email').fill(email);
    await page.getByTestId('invite-submit').click();
    const link = (await page.getByTestId('invite-link').inputValue().catch(async () => page.getByTestId('invite-link').innerText())).trim();
    expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

    const guest = await (await browser.newContext()).newPage();
    await guest.goto(link);
    await waitForHydration(guest);
    await expect(guest.getByText('E2E Invite')).toBeVisible();
    await guest.getByLabel(/name/i).fill('Invitee');
    await guest.getByLabel(/password/i).fill('E2ePassword1!');
    await guest.getByRole('button', { name: /accept/i }).click();
    await guest.waitForURL(new RegExp(`/${slug}$`));

    await page.reload();
    await expect(page.getByText(email)).toBeVisible();
  });
});
```

Run: `cd apps/web && bun run build && bun run test:e2e -- invite` (the Playwright web server serves a production build; follow `playwright.config.ts`).

- [ ] **Step 5: Run everything** — `bun run test && bun run lint && bun run type-check` (root); API integration
`cd apps/api && bun run test:integration`. Expected: green.

- [ ] **Step 6: Commit and open PR 3**

```bash
git add -A apps/web apps/api
git commit -m "feat(web): S4b C6 public invite accept page"
git push -u origin feat/fleet-s4b-3-project-invites
gh pr create --title "feat: S4b PR 3 — project invites" --body "Spec slice 3 (D516, D520, D525, D526). Refs S4b spec."
```

Fresh code review + security review (public endpoints, token handling) before push. After merge: koda-wk deploy,
§9.x note.

---

# Part D — Live check on koda-wk (spec slice 4, human-run)

### Task D1: Configure email on koda-wk and run the spec §9 checks

**Files:**
- Modify (on the host, not the repo): `~/koda-wk/.env` or the compose env for the api service; add a Mailpit service to `~/koda-wk/docker-compose.yml` for the first pass.

- [ ] **Step 1:** Back up the DB (`deploy.sh` does it) and add `SMTP_URL=smtp://mailpit:1025`, `EMAIL_FROM=koda@koda-wk.local`, `WEB_PUBLIC_URL=http://localhost:8030` to the api service; add Mailpit (`axllent/mailpit:v1.20`, UI on a free host port). Redeploy.
- [ ] **Step 2:** Run spec §9 checks 1-6 in order; for each record pass/fail, the `EmailSchedule` row (`status`, `skipReason`), and the Mailpit message (subject, link). Check 6 unsets `SMTP_URL` and redeploys.
- [ ] **Step 3:** Optional second pass with a real relay (user supplies credentials; never paste them into logs or docs).
- [ ] **Step 4:** Append the design doc §9.x status note (results, image commit, follow-ups) and update memory.

---

## Self-review notes (planning)

- Spec coverage: §1 → A1-A5; §2.1 → A2; §2.2 → B1; §2.3 → C1; §2.4 → B5 Step 1, C4 Step 1; §3.1 → B2; §3.2 → B3;
  §3.3 → B4; §3.4 → A5 (R7); §4.1-§4.3 → C1-C3; §4.4 → C5, C6, B5 Step 2; §4.5 → C4
  (R5); §5 edge cases → B4 skip tests, C3 tests; §6 security → A3 (secret-free errors), C1 (token), C3 (uniform 404,
  MEMBER role), Global Constraints; §8 testing → each task + B5 Mailpit e2e + C6 Playwright; §9 → D1.
- Changed during planning: R1-R7 above.
