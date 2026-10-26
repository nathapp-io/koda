import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { currentContext } from '../../../src/action-context/action-context';
import { currentAuditScope } from '../../../src/action-context/audit-coverage';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { EnrollmentRetentionProcessor } from '../../../src/fleet/runners/enrollment-retention.processor';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { NotificationRetentionProcessor } from '../../../src/notifications/notification-retention.processor';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { enrollRunner, syncBody } from '../../helpers/fleet-fixtures';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
const DAY = 86_400_000;

describeDb('system audit coverage scopes (booted API)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let rootId: string;
  let token: string;
  let config: IFleetConfig;
  let priorSyncWaitMs: number;
  const priorEnv = {
    NOTIFICATION_RETENTION_DAYS: process.env['NOTIFICATION_RETENTION_DAYS'],
    FLEET_ENROLLMENT_RETENTION_DAYS: process.env['FLEET_ENROLLMENT_RETENTION_DAYS'],
  };

  beforeAll(async () => {
    process.env['NOTIFICATION_RETENTION_DAYS'] = '7';
    process.env['FLEET_ENROLLMENT_RETENTION_DAYS'] = '7';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    await expectGuardActive(app);
    db = fixtureDb(app);
    config = app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    priorSyncWaitMs = config.syncWaitMs;
    config.syncWaitMs = 0;
    const registered = await request(app.getHttpServer()).post('/api/auth/register')
      .send({ email: 'coverage-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'coverage-root@koda.test' } })).id;
  }, 60_000);

  beforeEach(async () => {
    await db.notification.deleteMany();
    await db.fleetHealthAlert.deleteMany();
    await db.runnerEnrollment.deleteMany();
    await db.auditEntry.deleteMany();
  });

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    if (config) config.syncWaitMs = priorSyncWaitMs;
    try {
      await app?.close();
    } finally {
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('AC-5: SYSTEM fixtures keep their actor and origin without opening a scope', async () => {
    await withTestActor({ type: 'SYSTEM', id: 'seed' }, async () => {
      await Promise.resolve();
      expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'seed' }, origin: 'system' });
      expect(currentAuditScope()).toBeUndefined();
    });
  });

  it('AC-6: rejects an invalid SYSTEM fixture id before invoking fn', async () => {
    const fn = vi.fn();
    await expect(withTestActor({ type: 'SYSTEM', id: 'nope' }, fn))
      .rejects.toThrow('unknown system actor id: nope');
    expect(fn).not.toHaveBeenCalled();
  });

  it('AC-7: fixtureDb awaits a lazy create as seed without opening a checked scope', async () => {
    const user = await db.user.create({ data: { email: 'coverage-fixture@koda.test', passwordHash: 'x' } });
    await grantBaseline(db, { type: 'USER', id: user.id });
    expect(user).toMatchObject({ id: expect.any(String), email: 'coverage-fixture@koda.test' });
    expect(await db.user.findUnique({ where: { id: user.id } })).toEqual(user);
  });

  it('AC-8: an idle sync with unchanged boot id answers 200', async () => {
    const runner = await enrollRunner(app.getHttpServer(), token, 'coverage-runner');
    const sync = () => request(app.getHttpServer()).post('/api/fleet/runner/sync')
      .set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody());
    await sync().expect(200);
    const before = await db.auditEntry.count();
    await sync().expect(200);
    expect(await db.auditEntry.count()).toBe(before);
  });

  it('AC-9: marking the caller inbox read answers 204 without an audit entry', async () => {
    const notification = await db.notification.create({ data: {
      userId: rootId, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', link: '/',
      sourceType: 'ticket_event', sourceId: 'coverage-unread',
    } });
    const response = await request(app.getHttpServer()).post('/api/me/notifications/read-all')
      .set({ Authorization: `Bearer ${token}` });
    expect((await db.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt).not.toBeNull();
    expect(await db.auditEntry.count()).toBe(0);
    expect(response.status).toBe(204);
  });

  it('AC-10: a second notification purge changes no row and records nothing', async () => {
    const notification = await db.notification.create({ data: {
      userId: rootId, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', link: '/',
      sourceType: 'ticket_event', sourceId: 'coverage-read', readAt: new Date(Date.now() - 40 * DAY),
    } });
    const retention = app.get(NotificationRetentionProcessor);
    await expect(retention.scheduledPurge()).resolves.toBeUndefined();
    expect(await db.notification.findUnique({ where: { id: notification.id } })).toBeNull();
    expect(await db.auditEntry.count({ where: { key: 'system.notification.retention' } })).toBe(1);
    await db.auditEntry.deleteMany();
    await expect(retention.scheduledPurge()).resolves.toBeUndefined();
    expect(await db.auditEntry.count()).toBe(0);
  });

  it('AC-11: swallowed enrollment record failure rolls back writes and their tally', async () => {
    const ids: string[] = [];
    for (const tokenHash of ['coverage-spent-one', 'coverage-spent-two']) {
      ids.push((await db.runnerEnrollment.create({ data: {
        tokenHash, labels: [], createdById: rootId,
        expiresAt: new Date(Date.now() - 40 * DAY), usedAt: new Date(Date.now() - 30 * DAY),
      } })).id);
    }
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(app.get(EnrollmentRetentionProcessor).scheduledPurge()).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(await db.runnerEnrollment.findMany({ where: { id: { in: ids } } })).toHaveLength(2);
    expect(await db.auditEntry.count()).toBe(0);
  });
});
