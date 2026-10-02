/**
 * Fleet S1b slice 3a — JobSchedule and the FleetJob schedule link (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedules-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet schedules schema (PG)', () => {
  const prisma = new PrismaClient();
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, name: `s${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `f${n}`,
      ref: 'main', profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [],
      nextFireAt: new Date('2026-10-02T04:00:00.000Z'), createdById: base.adminId, updatedById: base.adminId, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `jf${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('defaults to enabled with zeroed counters and a stall limit of 3', async () => {
    const s = await schedule();
    expect(s).toEqual(expect.objectContaining({
      enabled: true, lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, lastFiredAt: null, lastJobId: null,
    }));
  });

  it('gives a job no schedule, no coalesced ticks and no counted-at by default', async () => {
    const j = await job();
    expect(j).toEqual(expect.objectContaining({ scheduleId: null, coalescedCount: 0, scheduleCountedAt: null }));
  });

  it('allows one QUEUED job per schedule, any number of other states and any number of unscheduled QUEUED jobs', async () => {
    const s = await schedule();
    await job({ scheduleId: s.id, state: 'QUEUED' });
    await expect(job({ scheduleId: s.id, state: 'QUEUED' })).rejects.toMatchObject({ code: 'P2002' });
    await expect(job({ scheduleId: s.id, state: 'FAILED' })).resolves.toBeDefined();
    await expect(job({ scheduleId: s.id, state: 'RUNNING' })).resolves.toBeDefined();
    await job({ state: 'QUEUED' });
    await expect(job({ state: 'QUEUED' })).resolves.toBeDefined();
  });

  it('keeps a schedule\'s jobs, detached, when the schedule is deleted (plan D193)', async () => {
    const s = await schedule();
    const j = await job({ scheduleId: s.id, state: 'FAILED' });
    await prisma.jobSchedule.delete({ where: { id: s.id } });
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleId).toBeNull();
  });

  it('survives the deletion of its repo, and may name a runner that does not exist (plan D193)', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: base.projectId, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: base.adminId },
    });
    const s = await schedule({ repoId: repo.id, pinnedRunnerId: 'no-such-runner' });
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    expect(await prisma.jobSchedule.count({ where: { id: s.id } })).toBe(1);
  });
});
