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
