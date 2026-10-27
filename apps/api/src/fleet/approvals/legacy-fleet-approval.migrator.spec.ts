import { createMockPrismaService } from '@nathapp/nestjs-prisma';
import { LegacyFleetApprovalMigrator, MIGRATION_BATCH, MAX_BATCHES_PER_PASS } from './legacy-fleet-approval.migrator';

function build() {
  const base = createMockPrismaService({ fn: vi.fn });
  const prisma = { client: { ...base.client,
    approvalRequest: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    fleetApprovalAsk: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } };
  const tx = { run: vi.fn(async (fn: () => Promise<void>) => fn()) };
  const config = { sweepEnabled: false, approvalSweepMs: 1000 };
  const migrator = new LegacyFleetApprovalMigrator(prisma as never, tx as never, config);
  return { migrator, prisma };
}

const row = (id: string, expiresAt: Date | null = null) => ({
  id, type: 'budget_override_required', projectId: null, jobId: null, leaseEpoch: null, naxAskId: null, policyId: 'policy',
  payload: {}, outcome: null, requestedAt: new Date('2020-01-01Z'), createdAt: new Date('2020-01-01Z'), expiresAt,
  status: 'pending', decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null,
});

describe('LegacyFleetApprovalMigrator (F4)', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves non-expiring legacy validity instead of imposing a new 24 hour timeout', async () => {
    const { migrator, prisma } = build();
    prisma.client.$queryRaw.mockResolvedValueOnce([row('old')]);
    await migrator.migrateBatch();
    expect(prisma.client.approvalRequest.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ expiresAt: new Date('9999-12-31T23:59:59.999Z') })],
    }));
  });

  it('preserves an explicit legacy deadline, even if it has already passed', async () => {
    const { migrator, prisma } = build();
    const deadline = new Date('2025-01-01Z');
    prisma.client.$queryRaw.mockResolvedValueOnce([row('deadline', deadline)]);
    await migrator.migrateBatch();
    expect(prisma.client.approvalRequest.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ expiresAt: deadline })],
    }));
  });

  it('advances past a completely failing front batch and retries failed rows on the next traversal', async () => {
    const { migrator, prisma } = build();
    const poison = Array.from({ length: MIGRATION_BATCH }, (_, i) => row(`bad-${i}`));
    prisma.client.$queryRaw.mockResolvedValueOnce(poison).mockResolvedValueOnce([row('later')]).mockResolvedValueOnce([]);
    prisma.client.approvalRequest.createMany.mockRejectedValue(new Error('bad row'));
    prisma.client.approvalRequest.createMany.mockImplementation(async (args: unknown) => {
      const id = (args as { data: Array<{ id: string }> }).data[0].id;
      if (id !== 'later') throw new Error('bad row');
      return { count: 1 };
    });
    expect(await migrator.migrateAll()).toBe(1);
    expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(2);
    await migrator.migrateAll();
    expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('durably rotates attempts outside the copy transaction and bounds even all-failing passes', async () => {
    const { migrator, prisma } = build();
    const bad = Array.from({ length: MIGRATION_BATCH }, (_, i) => row(`bad-${i}`));
    prisma.client.$queryRaw.mockResolvedValue(bad);
    prisma.client.approvalRequest.createMany.mockRejectedValue(new Error('bad row'));
    await migrator.migrateAll();
    expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(MAX_BATCHES_PER_PASS);
    prisma.client.$queryRaw.mockClear().mockResolvedValueOnce([]);
    await migrator.migrateAll();
    const sql = prisma.client.$queryRaw.mock.calls[0][0].join(' ');
    expect(sql).toContain('ORDER BY f."updatedAt" ASC, f."id" ASC');
    expect(sql).toContain('clock_timestamp()');
    expect(sql).toContain('FOR UPDATE OF f SKIP LOCKED');
  });

  it('continues periodically even when the fleet sweeper is disabled', async () => {
    vi.useFakeTimers();
    const { migrator } = build();
    const pass = vi.spyOn(migrator, 'pass').mockResolvedValue(0);
    migrator.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(pass).toHaveBeenCalledTimes(1);
    } finally {
      migrator.onModuleDestroy();
    }
  });
});
