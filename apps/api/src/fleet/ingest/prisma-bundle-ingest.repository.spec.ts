import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { PrismaBundleIngestRepository } from './prisma-bundle-ingest.repository';

/**
 * S5b US-001 (3c-2-D1): the epoch-scoped replacement of a job's run outcomes.
 * The DB-backed form of the same behaviour (rows, unique key, cascade) lives in
 * `test/integration/fleet/fleet-ingest-repository.integration.spec.ts`; this pins the
 * delete-then-insert contract and the context fields on the repository boundary without a database.
 */
describe('PrismaBundleIngestRepository — run outcomes (US-001)', () => {
  type MockPrisma = ReturnType<typeof createMockPrismaService>;
  type Delegate = { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };

  let prisma: MockPrisma;
  let repo: PrismaBundleIngestRepository;
  let outcomes: Delegate;

  const ctx = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', repoId: 'r1', runnerId: null, naxRunId: null };

  beforeEach(() => {
    prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client.fleetCostEvent = { deleteMany: vi.fn(), createMany: vi.fn() } as never;
    prisma.client.fleetStoryResult = { deleteMany: vi.fn(), createMany: vi.fn() } as never;
    prisma.client.fleetReviewResult = { deleteMany: vi.fn(), createMany: vi.fn() } as never;
    outcomes = { deleteMany: vi.fn(), createMany: vi.fn() };
    prisma.client.fleetRunOutcome = outcomes as never;
    repo = new PrismaBundleIngestRepository(prisma as PrismaService<never>);
  });

  it('AC-7 deletes and re-creates the attempt’s outcome rows, stamping projectId and repoId', async () => {
    await repo.replaceRows(ctx, {
      costEvents: [], stories: [], reviews: [],
      outcomes: [{ kind: 'report', content: '# R' }, { kind: 'decisions', content: '{"id":"D1"}' }],
    });
    expect(outcomes.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'j1', leaseEpoch: 1 } });
    expect(outcomes.createMany).toHaveBeenCalledWith({
      data: [
        { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', repoId: 'r1', kind: 'report', content: '# R' },
        { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', repoId: 'r1', kind: 'decisions', content: '{"id":"D1"}' },
      ],
    });
  });

  it('AC-8 replaces the same epoch and never touches another epoch', async () => {
    await repo.replaceRows(ctx, { costEvents: [], stories: [], reviews: [], outcomes: [{ kind: 'decisions', content: 'old' }] });
    await repo.replaceRows(ctx, { costEvents: [], stories: [], reviews: [], outcomes: [{ kind: 'report', content: 'new' }] });
    expect(outcomes.deleteMany).toHaveBeenCalledTimes(2);
    // Both deletes are scoped to (jobId, leaseEpoch 1): an epoch-2 row is never in the where clause.
    for (const call of outcomes.deleteMany.mock.calls) expect(call[0]).toEqual({ where: { jobId: 'j1', leaseEpoch: 1 } });
    expect(outcomes.createMany).toHaveBeenLastCalledWith({
      data: [{ jobId: 'j1', leaseEpoch: 1, projectId: 'p1', repoId: 'r1', kind: 'report', content: 'new' }],
    });
  });

  it('AC-8b treats an absent outcomes list as an empty one', async () => {
    await repo.replaceRows(ctx, { costEvents: [], stories: [], reviews: [] });
    expect(outcomes.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'j1', leaseEpoch: 1 } });
    expect(outcomes.createMany).not.toHaveBeenCalled();
  });
});
