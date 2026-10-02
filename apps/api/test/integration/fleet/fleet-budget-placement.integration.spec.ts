/**
 * Fleet S1b slice 2a — both placement entry points honour budget pauses (spec §2.3) (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-placement.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

describeIntegration('fleet budget placement (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let placement: PlacementService;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let other: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;

  const queue = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `bp${++n}`, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });
  const pause = (scopeType: string, scopeId: string, projectId: string | null = null) => prisma.budgetPolicy.create({
    data: {
      scopeType, scopeId, scopeKey: `${scopeType}:${scopeId}`, projectId, windowKind: 'calendar_month_utc',
      amountUsd: new Prisma.Decimal(1), createdById: base.adminId, updatedById: base.adminId,
      pausedAt: new Date(), pausedWindowStart: monthStart(new Date()),
    },
  });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    placement = app.get(PlacementService);
    base = await seedFleetBase(prisma);
    other = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('placeJob cancels a QUEUED job whose project paused after it was queued', async () => {
    await insertRunner(prisma);
    const job = await queue();
    const policy = await pause('project', base.projectId, base.projectId);
    const outcome = await placement.placeJob(job.id);
    expect(outcome.assigned).toBe(false);
    expect(await reload(job.id)).toEqual(expect.objectContaining({
      state: 'CANCELLED', stateReason: `budget:${policy.id}`, cancelReason: `budget:${policy.id}`,
    }));
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('fillRunner cancels a job in a paused repo and still assigns an unaffected one', async () => {
    const runner = await insertRunner(prisma, { capacity: 2 });
    const blocked = await queue();
    const free = await queue({ projectId: other.projectId, repoId: other.repoId });
    const policy = await pause('repo', base.repoId, base.projectId);
    expect(await placement.fillRunner(runner.id, 2)).toBe(1);
    expect(await reload(blocked.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
    expect(await reload(free.id)).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId: runner.id }));
  });

  it('skips a paused runner with budget_paused and assigns to another', async () => {
    const paused = await insertRunner(prisma);
    const open = await insertRunner(prisma);
    await pause('runner', paused.id);
    const job = await queue();
    const outcome = await placement.placeJob(job.id);
    expect(outcome).toEqual(expect.objectContaining({ assigned: true, runnerId: open.id }));
    expect(outcome.misfits).toEqual([expect.objectContaining({ runnerId: paused.id, reason: 'budget_paused' })]);
  });

  it('ignores a stale monthly pause from an earlier month (S1b §2.3)', async () => {
    const runner = await insertRunner(prisma);
    const job = await queue();
    const now = new Date();
    await prisma.budgetPolicy.create({
      data: {
        scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId,
        windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(1), createdById: base.adminId, updatedById: base.adminId,
        pausedAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)),
        pausedWindowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
      },
    });
    expect(await placement.placeJob(job.id)).toEqual(expect.objectContaining({ assigned: true, runnerId: runner.id }));
  });

  it('leaves an unpinned job queued when the only runner is paused, and cancels a job pinned to it', async () => {
    const runner = await insertRunner(prisma);
    const policy = await pause('runner', runner.id);
    const unpinned = await queue();
    const pinned = await queue({ pinnedRunnerId: runner.id });
    expect((await placement.placeJob(unpinned.id)).misfits).toEqual([expect.objectContaining({ reason: 'budget_paused' })]);
    expect(await placement.fillRunner(runner.id, 1)).toBe(0);
    expect((await reload(unpinned.id)).state).toBe('QUEUED');
    expect(await reload(pinned.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
  });
});
