/**
 * Fleet S1 slice 2 — job tables, the active (repoId, feature) index and the migration (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20260930090000_fleet_jobs';

describeIntegration('fleet job schema (PG)', () => {
  const prisma = new PrismaClient();
  let ids: { projectId: string; repoId: string; userId: string };

  const job = (feature: string, state = 'QUEUED') => prisma.fleetJob.create({
    data: {
      projectId: ids.projectId, repoId: ids.repoId, ref: 'main', command: 'RUN', feature, profiles: [],
      maxCostUsd: new Prisma.Decimal('5.5'), selectorLabels: [], requestedById: ids.userId, state,
    },
  });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    ids = { projectId: project.id, repoId: repo.id, userId: user.id };
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('allows one active job per (repo, feature) and any number of finished ones', async () => {
    await job('feat-a', 'COMPLETED');
    await job('feat-a', 'CANCELLED');
    const active = await job('feat-a');
    await expect(job('feat-a')).rejects.toMatchObject({ code: 'P2002' });
    await expect(job('feat-a', 'RUNNING')).rejects.toMatchObject({ code: 'P2002' });
    await job('feat-b');
    await prisma.fleetJob.update({ where: { id: active.id }, data: { state: 'FAILED' } });
    await expect(job('feat-a')).resolves.toBeDefined();
  });

  it('keeps Decimal cost and dedups runner events per (job, epoch, runnerSeq) but not server events', async () => {
    const j = await job('feat-events');
    expect(j.maxCostUsd.toString()).toBe('5.5');
    expect(j.costSpentUsd.toString()).toBe('0');
    const ev = (seq: number, leaseEpoch: number, runnerSeq: number | null) =>
      prisma.fleetJobEvent.create({ data: { jobId: j.id, seq, leaseEpoch, runnerSeq, type: 'log', payload: {} } });
    await ev(1, 1, 1);
    await ev(2, 1, null);
    await ev(3, 1, null);
    await ev(4, 2, 1); // a new epoch restarts runner seq
    await expect(ev(5, 1, 1)).rejects.toMatchObject({ code: 'P2002' });
    await expect(ev(4, 3, 9)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades events, commands and artifacts with the job, and nulls runner references on runner delete', async () => {
    const runner = await prisma.runner.create({
      data: {
        name: 'r1', apiKeyHash: 'h1', os: 'linux', arch: 'x64', labels: [], capabilities: {}, daemonVersion: '0.1.0',
        protocolVersion: 1, bootId: 'b1', lastSeenAt: new Date(), createdById: ids.userId,
      },
    });
    const j = await job('feat-cascade', 'CANCELLED');
    await prisma.fleetJob.update({ where: { id: j.id }, data: { runnerId: runner.id, pinnedRunnerId: runner.id } });
    await prisma.fleetCommand.create({ data: { runnerId: runner.id, jobId: j.id, type: 'ASSIGN', leaseEpoch: 1, payload: {} } });
    await prisma.fleetJobArtifact.create({
      data: { jobId: j.id, leaseEpoch: 1, kind: 'bundle', storageKey: `jobs/${j.id}/1.tar.gz`, sizeBytes: BigInt(10), sha256: 'a'.repeat(64) },
    });
    await prisma.runner.delete({ where: { id: runner.id } });
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } });
    expect([after.runnerId, after.pinnedRunnerId]).toEqual([null, null]);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id } })).toBe(0);

    await prisma.fleetJob.delete({ where: { id: j.id } });
    expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(0);
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'fleet_jobs_mig', MIGRATION);
      await applyMigration(scratch.db, MIGRATION);
    });
    afterAll(async () => {
      await scratch.drop();
    });

    it('creates the partial unique index', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'fleet_jobs_mig' AND indexname = 'FleetJob_active_repo_feature_key'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
      expect(rows[0].indexdef).toMatch(/WHERE/);
    });
  });
});
