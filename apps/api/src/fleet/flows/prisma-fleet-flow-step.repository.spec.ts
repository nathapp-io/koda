import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { PrismaFleetFlowStepRepository } from './prisma-fleet-flow-step.repository';

/**
 * US-012: the flow's latest job and the ingest status of its own lease come from one statement, because
 * a RUN's `resultPrUrl` and that settled mark commit together. The DB-backed form of the same read lives
 * with the rest of this repository in `test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`;
 * this pins the statement and the mapping without a database.
 */
describe('PrismaFleetFlowStepRepository — latest job with its ingest status', () => {
  type MockPrisma = ReturnType<typeof createMockPrismaService>;

  let prisma: MockPrisma;
  let repo: PrismaFleetFlowStepRepository;
  let queryRaw: ReturnType<typeof vi.fn>;
  let transactionManager: { run: ReturnType<typeof vi.fn> };

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'feat/f', command: 'RUN', feature: 'f',
    planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
    selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
    state: 'COMPLETED', stateReason: null, requestedById: 'u1', queuedAt: new Date('2026-11-07T12:05:00.000Z'),
    finishedAt: new Date('2026-11-07T12:20:00.000Z'), costSpentUsd: '0.5000', costCarriedUsd: '0.0000',
    resultBranch: 'feat/f', resultSha: 'b'.repeat(40), resultPrUrl: 'https://github.com/o/r/pull/12',
    fixReady: null, agentResult: null, flowId: 'flow-1', flowStep: 'RUN', threadId: null,
    ingestSettled: true, ...over,
  });

  beforeEach(() => {
    prisma = createMockPrismaService({ fn: vi.fn });
    queryRaw = vi.fn().mockResolvedValue([]);
    prisma.client.$queryRaw = queryRaw as never;
    transactionManager = { run: vi.fn((work: () => Promise<unknown>) => work()) };
    repo = new PrismaFleetFlowStepRepository(transactionManager as never, prisma as PrismaService<never>);
  });

  /** The `Prisma.Sql` a call carried; `values` are the parameters, `strings` the literal SQL halves. */
  const sqlOf = (call: number = 0): { text: string; values: unknown[] } => {
    const sql = queryRaw.mock.calls[call][0] as unknown as { strings: string[]; values: unknown[] };
    return { text: sql.strings.join('?'), values: sql.values };
  };

  it('records calls and applicable SHAs inside the transaction manager', async () => {
    const featureUpdate = vi.fn().mockResolvedValue({});
    const flowUpdate = vi.fn().mockResolvedValue({});
    (prisma.client as unknown as Record<string, unknown>).fleetFlowFeature = { update: featureUpdate };
    (prisma.client as unknown as Record<string, unknown>).fleetFlow = { update: flowUpdate };

    await repo.recordCalls('flow-1', 'feature-1', 'job-1', 'sha-1', { setSha: true });

    expect(transactionManager.run).toHaveBeenCalledTimes(1);
    expect(featureUpdate).toHaveBeenCalledExactlyOnceWith({ where: { id: 'feature-1' }, data: { callsJobId: 'job-1' } });
    expect(flowUpdate).toHaveBeenCalledExactlyOnceWith({ where: { id: 'flow-1' }, data: { specSha: 'sha-1', setSha: 'sha-1' } });
  });

  it('B2: persists the PLAN output branch without approving a new sha', async () => {
    const update = vi.fn().mockResolvedValue({});
    (prisma.client as unknown as Record<string, unknown>).fleetFlow = { update };
    await repo.setBranch('flow-1', 'prd/output');
    expect(update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'flow-1' }, data: { branch: 'prd/output' } });
  });

  it('returns null when the flow has no job', async () => {
    await expect(repo.latestJobWithIngest('flow-1', 'feature-1')).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf().values).toEqual(['flow-1', 'feature-1']);
  });

  it('pairs the job row with the settled mark of its own lease in one statement', async () => {
    queryRaw.mockResolvedValue([row()]);

    const latest = await repo.latestJobWithIngest('flow-1', 'feature-1');

    expect(latest?.ingestSettled).toBe(true);
    expect(latest?.job).toMatchObject({
      id: 'job-1', flowId: 'flow-1', flowStep: 'RUN', state: 'COMPLETED',
      resultPrUrl: 'https://github.com/o/r/pull/12', resultSha: 'b'.repeat(40),
    });
    expect(latest?.job).not.toHaveProperty('ingestSettled');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('answers unsettled for a job whose lease has no settled ingest', async () => {
    queryRaw.mockResolvedValue([row({ ingestSettled: false })]);

    await expect(repo.latestJobWithIngest('flow-1', 'feature-1')).resolves.toMatchObject({ ingestSettled: false });
  });

  it('scopes the status to the job and its own lease, counting done, partial and failed as settled', async () => {
    await repo.latestJobWithIngest('flow-1', 'feature-1');

    const { text } = sqlOf();
    expect(text).toContain('FROM "FleetBundleIngest" AS ingest');
    expect(text).toContain('ingest."jobId" = job."id"');
    expect(text).toContain('ingest."leaseEpoch" = job."leaseEpoch"');
    expect(text).toContain("ingest.\"status\" IN ('done', 'partial', 'failed')");
    // The latest job of the flow's feature, by the same order the plain read uses.
    expect(text).toContain('WHERE job."flowId" = ?');
    expect(text).toContain('AND job."flowFeatureId" = ?');
    expect(text).toContain('ORDER BY job."queuedAt" DESC, job."id" DESC');
    expect(text).toContain('LIMIT 1');
  });
});
