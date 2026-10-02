/**
 * Fleet S1b slice 2a — budget tables and the FleetJob spend columns (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet budgets schema (PG)', () => {
  const prisma = new PrismaClient();
  const WINDOW = new Date('2026-10-01T00:00:00.000Z');

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const policy = (scopeKey: string, windowKind = 'calendar_month_utc') => prisma.budgetPolicy.create({
    data: {
      scopeType: 'global', scopeKey, windowKind, amountUsd: new Prisma.Decimal('10'), createdById: 'u1', updatedById: 'u1',
    },
  });
  const incident = (policyId: string, kind: string, amountUsd = '10') => prisma.budgetIncident.create({
    data: { policyId, kind, windowStart: WINDOW, spentUsd: new Prisma.Decimal('8'), amountUsd: new Prisma.Decimal(amountUsd) },
  });

  it('defaults a policy to warn-less hard stop with finish, and refuses a second policy for the same scope and window', async () => {
    const p = await policy('global');
    expect(p).toEqual(expect.objectContaining({ warnPercent: null, hardStop: true, runningJobs: 'finish', pausedAt: null, pausedWindowStart: null }));
    await expect(policy('global')).rejects.toMatchObject({ code: 'P2002' });
    await expect(policy('global', 'lifetime')).resolves.toBeDefined();
  });

  it('keeps one warn and one hard_stop per (policy, window, amount), any number of resumed rows', async () => {
    const p = await policy('project:p-1');
    await incident(p.id, 'warn');
    await expect(incident(p.id, 'warn')).rejects.toMatchObject({ code: 'P2002' });
    await expect(incident(p.id, 'warn', '20')).resolves.toBeDefined();
    await incident(p.id, 'hard_stop');
    await expect(incident(p.id, 'hard_stop')).rejects.toMatchObject({ code: 'P2002' });
    await incident(p.id, 'resumed');
    await expect(incident(p.id, 'resumed')).resolves.toBeDefined();
  });

  it('deletes incidents with their policy', async () => {
    const p = await policy('repo:r-1');
    await incident(p.id, 'resumed');
    await prisma.budgetPolicy.delete({ where: { id: p.id } });
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(0);
  });

  it('gives FleetJob zero carried spend, no first start and no cancel reason by default', async () => {
    const base = await seedFleetBase(prisma);
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId,
      },
    });
    expect(job.costCarriedUsd.toString()).toBe('0');
    expect(job.firstStartedAt).toBeNull();
    expect(job.cancelReason).toBeNull();
  });
});
