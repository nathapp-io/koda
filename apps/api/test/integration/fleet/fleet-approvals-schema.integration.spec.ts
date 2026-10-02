/**
 * Fleet S1.5 slice 1a — FleetApproval table and the one-pending-per-policy index (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-schema.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
// The migration block replays 193 DDL statements across 14 migrations; 13 of the 38 sibling fleet
// integration specs raise the hook timeout for the same reason and this one has no business being the
// exception.
jest.setTimeout(20_000);
const MIGRATION = '20261003090000_fleet_approvals';

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
    await expect(prisma.fleetApproval.create({ data: { ...base, policyId: 'p1' } })).rejects.toMatchObject({ code: 'P2002' });
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1', status: 'cancelled' } });
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1', status: 'approved' } });
    expect(await prisma.fleetApproval.count({ where: { policyId: 'p1' } })).toBe(3);
  });

  it('dedups a re-reported bash ask on (jobId, leaseEpoch, naxAskId)', async () => {
    const ask = { ...base, type: 'nax_bash_escalate', jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-00000001' };
    await prisma.fleetApproval.create({ data: ask });
    await expect(prisma.fleetApproval.create({ data: ask })).rejects.toMatchObject({ code: 'P2002' });
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'fleet_approvals_mig', MIGRATION);
      await applyMigration(scratch.db, MIGRATION);
    });
    afterAll(async () => {
      await scratch.drop();
    });

    it('creates the partial unique index', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'fleet_approvals_mig' AND indexname = 'FleetApproval_pending_policy_key'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
      expect(rows[0].indexdef).toMatch(/WHERE/);
    });
  });
});
