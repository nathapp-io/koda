import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P2 US-004 — the system writers of the delivery side record their retention purges and
 * health episodes: OutboxRetentionProcessor, NotificationRetentionProcessor and FleetHealthDetector.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/audit/audit-delivery-system.integration.spec.ts
 */
import request from 'supertest';
import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { OutboxRetentionProcessor } from '../../../src/outbox/outbox-retention.processor';
import { NotificationRetentionProcessor } from '../../../src/notifications/notification-retention.processor';
import { FleetHealthDetector } from '../../../src/notifications/fleet/fleet-health.detector';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { FLEET_CAPS, insertRunner } from '../../helpers/fleet-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const DAY = 86_400_000;
const OUTBOX_KEY = 'system.outbox.retention';
const NOTIFICATION_KEY = 'system.notification.retention';
const HEALTH_KEY = 'system.health.detect';

vi.setConfig({ testTimeout: 30_000 });

describeIntegration('retention purges and fleet health episodes audit (real AppModule)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let ids: { root: string; dev: string; project: string };
  const spies: Array<{ mockRestore: () => void }> = [];
  let n = 0;
  const priorEnv = {
    outbox: process.env['OUTBOX_RETENTION_DAYS'],
    notification: process.env['NOTIFICATION_RETENTION_DAYS'],
  };

  const old = () => new Date(Date.now() - 40 * DAY);
  /** Past the detector's boot grace (runnerOfflineSec is 90 under the test config). */
  const later = (ms = 0) => new Date(Date.now() + 120_000 + ms);

  const entries = (key: string) => db.auditEntry.findMany({ where: { key }, orderBy: { createdAt: 'asc' } });
  const count = (key: string) => db.auditEntry.count({ where: { key } });

  /**
   * Fails the next call whose key is `key` with `audit down` and delegates every other call — the
   * notification purge's second step must still record (AC-6).
   */
  const rejectFirstRecord = (key: string): { mockRestore: () => void } => {
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    let rejected = false;
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (!rejected && input.key === key) {
        rejected = true;
        throw new Error('audit down');
      }
      return original(input);
    });
    spies.push(spy);
    return spy;
  };

  const purgeOutbox = () => app.get(OutboxRetentionProcessor).scheduledPurge();
  const purgeNotifications = () => app.get(NotificationRetentionProcessor).scheduledPurge();
  const detect = (now = later()) => app.get(FleetHealthDetector).detect(now);

  const createOutboxEvent = (over: { status: string; updatedAt: Date; projectId?: string | null }) =>
    db.outboxEvent.create({
      data: {
        type: 'ticket_event',
        eventId: `evt-${++n}`,
        projectId: over.projectId === undefined ? ids.project : over.projectId,
        payload: '{}',
        status: over.status,
        createdAt: over.updatedAt,
        updatedAt: over.updatedAt,
      },
    });

  const createReadNotification = () =>
    db.notification.create({
      data: {
        userId: ids.dev, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', link: '/',
        sourceType: 'ticket_event', sourceId: `s-${++n}`, readAt: old(),
      },
    });

  const createClosedAlert = () =>
    db.fleetHealthAlert.create({ data: { kind: 'runner_offline', subjectKey: `old-${++n}`, closedAt: old() } });

  const offlineRunner = (lastSeenAt = old()) =>
    insertRunner(db, { name: `audit-runner-${++n}`, lastSeenAt, createdById: ids.root, capabilities: FLEET_CAPS });

  beforeAll(async () => {
    process.env['OUTBOX_RETENTION_DAYS'] = '30';
    process.env['NOTIFICATION_RETENTION_DAYS'] = '30';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const server = app.getHttpServer();
    const registered = await request(server).post('/api/auth/register')
      .send({ email: 'audit-sys-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    const rootToken = data<{ accessToken: string }>(registered).accessToken;
    const asRoot = { Authorization: `Bearer ${rootToken}` };
    ids = {
      root: (await db.user.findUniqueOrThrow({ where: { email: 'audit-sys-root@koda.test' } })).id,
      dev: '',
      project: '',
    };
    await grantBaseline(db, { type: 'USER', id: ids.root });
    await request(server).post('/api/projects').set(asRoot).send({ name: 'System', slug: 'sys-audit', key: 'SYS' }).expect(201);
    ids.project = (await db.project.findUniqueOrThrow({ where: { slug: 'sys-audit' } })).id;
    const dev = await request(server).post('/api/admin/users').set(asRoot)
      .send({ email: 'audit-sys-dev@koda.test', name: 'Dev', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    ids.dev = data<{ id: string }>(dev).id;
    await grantBaseline(db, { type: 'USER', id: ids.dev });
  }, 60_000);

  beforeEach(async () => {
    resetThrottle(app);
    await db.auditEntry.deleteMany();
    await db.outboxEvent.deleteMany();
    await db.notification.deleteMany();
    await db.fleetHealthAlert.deleteMany();
    await db.runner.deleteMany();
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of [
      ['OUTBOX_RETENTION_DAYS', priorEnv.outbox],
      ['NOTIFICATION_RETENTION_DAYS', priorEnv.notification],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('AC-1/AC-2: audits one outbox retention entry per nonempty run and nothing when it deletes nothing', async () => {
    await createOutboxEvent({ status: 'published', updatedAt: old() });
    await createOutboxEvent({ status: 'dead', updatedAt: old() });

    await expect(purgeOutbox()).resolves.toBeUndefined();

    expect(await entries(OUTBOX_KEY)).toMatchObject([{
      key: OUTBOX_KEY, resourceType: 'outbox-event', resourceId: 'all', projectId: null,
      actorType: 'SYSTEM', actorId: 'outbox', origin: 'system', summary: 'purged 2 terminal events',
    }]);
    expect(await db.outboxEvent.count()).toBe(0);

    const fresh = await createOutboxEvent({ status: 'published', updatedAt: new Date() });
    const before = await count(OUTBOX_KEY);
    await expect(purgeOutbox()).resolves.toBeUndefined();
    expect(await count(OUTBOX_KEY)).toBe(before);
    expect(await db.outboxEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it('AC-3/AC-12: a rejected record keeps the dead event, logs and lets the cron resolve', async () => {
    const event = await createOutboxEvent({ status: 'published', updatedAt: old() });
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    rejectFirstRecord(OUTBOX_KEY);

    await expect(purgeOutbox()).resolves.toBeUndefined();

    expect(await db.outboxEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
    expect(await count(OUTBOX_KEY)).toBe(0);
    expect(errorLog.mock.calls.map((call) => call[0])).toContain(
      'Outbox retention purge failed, will retry next run: audit down',
    );
    errorLog.mockRestore();
  });

  it('AC-4/AC-5: audits each nonempty notification retention step with its own resource type', async () => {
    await createReadNotification();
    await createClosedAlert();

    await expect(purgeNotifications()).resolves.toBeUndefined();

    expect(await entries(NOTIFICATION_KEY)).toMatchObject([
      {
        key: NOTIFICATION_KEY, resourceType: 'notification', resourceId: 'all', projectId: null,
        actorType: 'SYSTEM', actorId: 'notification', origin: 'system', summary: 'purged 1 read notifications',
      },
      {
        key: NOTIFICATION_KEY, resourceType: 'fleet-health-alert', resourceId: 'all', projectId: null,
        actorType: 'SYSTEM', actorId: 'notification', origin: 'system', summary: 'purged 1 closed health alerts',
      },
    ]);
    expect(await db.notification.count()).toBe(0);
    expect(await db.fleetHealthAlert.count()).toBe(0);
  });

  it('AC-6: a rejected first step rolls back and the next step still records', async () => {
    const notification = await createReadNotification();
    await createClosedAlert();
    rejectFirstRecord(NOTIFICATION_KEY);

    await expect(purgeNotifications()).resolves.toBeUndefined();

    expect(await db.notification.findUnique({ where: { id: notification.id } })).not.toBeNull();
    expect(await db.fleetHealthAlert.count()).toBe(0);
    expect(await entries(NOTIFICATION_KEY)).toMatchObject([{
      resourceType: 'fleet-health-alert', resourceId: 'all', summary: 'purged 1 closed health alerts',
    }]);
  });

  it('AC-7/AC-8: audits an opened episode once and records nothing while it stays open', async () => {
    const runner = await offlineRunner();
    const now = later();

    expect(await detect(now)).toEqual({ opened: 1, closed: 0 });

    const alert = await db.fleetHealthAlert.findFirstOrThrow({ where: { kind: 'runner_offline', subjectKey: runner.id } });
    expect(await entries(HEALTH_KEY)).toMatchObject([{
      key: HEALTH_KEY, resourceType: 'fleet-health-alert', resourceId: alert.id, projectId: null,
      actorType: 'SYSTEM', actorId: 'health', origin: 'system', summary: 'opened runner_offline',
    }]);

    const before = await count(HEALTH_KEY);
    expect(await detect(later(60_000))).toEqual({ opened: 0, closed: 0 });
    expect(await count(HEALTH_KEY)).toBe(before);
  });

  it('AC-9/AC-13: a rejected open rolls back the episode and its event, and the next tick opens it', async () => {
    const runner = await offlineRunner();
    const now = later();
    const spy = rejectFirstRecord(HEALTH_KEY);

    await expect(detect(now)).rejects.toThrow('audit down');

    expect(await db.fleetHealthAlert.count({ where: { kind: 'runner_offline', subjectKey: runner.id } })).toBe(0);
    expect(await db.outboxEvent.count({ where: { type: 'fleet_health_alert' } })).toBe(0);
    expect(await count(HEALTH_KEY)).toBe(0);

    spy.mockRestore();

    expect(await detect(now)).toEqual({ opened: 1, closed: 0 });
    const alert = await db.fleetHealthAlert.findFirstOrThrow({ where: { kind: 'runner_offline', subjectKey: runner.id } });
    expect(await entries(HEALTH_KEY)).toMatchObject([{ resourceId: alert.id, summary: 'opened runner_offline' }]);
    expect(await db.outboxEvent.count({ where: { type: 'fleet_health_alert' } })).toBe(1);
  });

  it('AC-10: audits a close run for all with the number of episodes closed', async () => {
    const runner = await offlineRunner();
    expect(await detect(later())).toEqual({ opened: 1, closed: 0 });
    await db.runner.update({ where: { id: runner.id }, data: { lastSeenAt: later() } });

    expect(await detect(later())).toEqual({ opened: 0, closed: 1 });

    expect(await entries(HEALTH_KEY)).toMatchObject([
      { resourceId: (await db.fleetHealthAlert.findFirstOrThrow({ where: { subjectKey: runner.id } })).id, summary: 'opened runner_offline' },
      { key: HEALTH_KEY, resourceType: 'fleet-health-alert', resourceId: 'all', projectId: null, actorType: 'SYSTEM', actorId: 'health', origin: 'system', summary: 'closed 1' },
    ]);
    expect(await db.fleetHealthAlert.count({ where: { closedAt: null } })).toBe(0);
  });

  it('AC-11: a detect that changes nothing records nothing', async () => {
    // Control: the writer is live in this fixture, so the count the AC-11 assertion compares against is
    // non-zero and produced by the recording path (an offline episode opens, then closes on recovery).
    const runner = await offlineRunner();
    expect(await detect(later())).toEqual({ opened: 1, closed: 0 });
    await db.runner.update({ where: { id: runner.id }, data: { lastSeenAt: later() } });
    expect(await detect(later())).toEqual({ opened: 0, closed: 1 });
    const before = await count(HEALTH_KEY);
    expect(before).toBe(2);

    // AC-11: every runner online and no open episode — the plan opens and closes nothing.
    expect(await db.fleetHealthAlert.count({ where: { closedAt: null } })).toBe(0);
    expect(await detect(later(60_000))).toEqual({ opened: 0, closed: 0 });

    expect(await count(HEALTH_KEY)).toBe(before);
  });
});
