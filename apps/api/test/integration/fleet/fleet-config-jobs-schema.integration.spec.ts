/**
 * Fleet S3 §1 — FleetJob.configResult and FleetConfigEdit (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-config-jobs-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet config jobs schema (PG)', () => {
  const prisma = new PrismaClient();
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const repo = new PrismaFleetJobRepository({ client: prisma } as never);

  const configJob = (feature = 'nax-config') => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'CONFIG_EDIT', feature, profiles: [],
      selectorLabels: [], maxCostUsd: new Prisma.Decimal(0), requestedById: base.adminId,
    },
  });

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores an edit row 1:1 with its job and cascades on job delete', async () => {
    const job = await configJob();
    const edit = await prisma.fleetConfigEdit.create({
      data: { jobId: job.id, mode: 'edit', edits: [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }], prTitle: 't', baseSha: 'a'.repeat(40) },
    });
    expect(edit.result).toBeNull();
    await expect(prisma.fleetConfigEdit.create({ data: { jobId: job.id, mode: 'drift', edits: [], baseSha: 'b'.repeat(40) } })).rejects.toThrow();
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'CANCELLED' } });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.fleetConfigEdit.findUnique({ where: { id: edit.id } })).toBeNull();
  });

  it('keeps at most one active config job per repo through the existing (repoId, feature) index', async () => {
    const first = await configJob();
    await expect(configJob()).rejects.toThrow();
    await prisma.fleetJob.update({ where: { id: first.id }, data: { state: 'COMPLETED' } });
    await expect(configJob()).resolves.toBeDefined();
  });

  it('round-trips configResult through the repository and copies it into the edit row', async () => {
    const job = await configJob('nax-config-copy');
    await prisma.fleetConfigEdit.create({ data: { jobId: job.id, mode: 'drift', edits: [], baseSha: 'c'.repeat(40) } });
    const result = { outcome: 'drift', files: ['AGENTS.md'] };
    const updated = await repo.update(job.id, { configResult: result as never });
    expect(updated.configResult).toEqual(result);
    await repo.copyConfigResult(job.id);
    expect((await prisma.fleetConfigEdit.findUniqueOrThrow({ where: { jobId: job.id } })).result).toEqual(result);
    const cleared = await repo.update(job.id, { configResult: null });
    expect(cleared.configResult).toBeNull();
  });

  it('copyConfigResult is a no-op for a job without an edit row', async () => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'plain-run', profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId,
      },
    });
    await expect(repo.copyConfigResult(job.id)).resolves.toBeUndefined();
  });
});
