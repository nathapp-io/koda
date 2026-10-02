/**
 * Fleet S1.5 slice 1a — FleetApproval table and the one-pending-per-policy index (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-schema.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('FleetApproval schema (PG)', () => {
  const prisma = new PrismaClient();
  const base = { type: 'budget_override_required', payload: {}, requestedAt: new Date() };

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores an approval with defaults and nullable bash columns', async () => {
    const row = await prisma.fleetApproval.create({ data: { ...base, policyId: 'p0' } });
    expect(row).toEqual(expect.objectContaining({
      status: 'pending', projectId: null, jobId: null, leaseEpoch: null, naxAskId: null, outcome: null,
      expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null,
    }));
  });

  it('allows one pending approval per policy, any number of closed ones', async () => {
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1' } });
    await expect(prisma.fleetApproval.create({ data: { ...base, policyId: 'p1' } })).rejects.toThrow();
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1', status: 'cancelled' } });
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1', status: 'approved' } });
    expect(await prisma.fleetApproval.count({ where: { policyId: 'p1' } })).toBe(3);
  });

  it('dedups a re-reported bash ask on (jobId, leaseEpoch, naxAskId)', async () => {
    const ask = { ...base, type: 'nax_bash_escalate', jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-00000001' };
    await prisma.fleetApproval.create({ data: ask });
    await expect(prisma.fleetApproval.create({ data: ask })).rejects.toThrow();
  });
});