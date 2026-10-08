/**
 * Fleet S4a §2.4 — health episodes on PG: one alert and one notification per episode, closed on recovery,
 * a second outage is a new episode; expiring credentials; closed alerts purged after 30 days.
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-health-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
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
