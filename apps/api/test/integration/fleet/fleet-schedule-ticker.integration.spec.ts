/**
 * Fleet S1b slice 3a — ScheduleTicker on PG with a fixed clock: the claim, coalescing, skips and the disable paths.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-ticker.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { PrismaScheduleRepository } from '../../../src/fleet/schedules/prisma-schedule.repository';
import { ScheduleTicker } from '../../../src/fleet/schedules/schedule-ticker';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

describeIntegration('schedule ticker (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let ticker: ScheduleTicker;
  let n = 0;
  const NOW = new Date('2026-10-02T03:00:30.000Z');
  const DUE = new Date('2026-10-02T03:00:00.000Z');
  const NEXT = new Date('2026-10-02T04:00:00.000Z');

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, name: `t${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `tf${n}`, ref: 'trunk',
      profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: DUE, createdById: world.ids.dev, updatedById: world.ids.dev, ...over,
    },
  });
  /** A fresh owner with the given project role (null = not a member). */
  const owner = async (role: string | null, over: Partial<Prisma.UserUncheckedCreateInput> = {}): Promise<string> => {
    const user = await prisma.user.create({ data: { email: `owner${++n}@koda.test`, passwordHash: 'x', role: 'MEMBER', ...over } });
    if (role) await prisma.projectMember.create({ data: { projectId: world.projectId, userId: user.id, role } });
    return user.id;
  };
  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });
  const jobsOf = (scheduleId: string) => prisma.fleetJob.findMany({ where: { scheduleId } });
  const skipReasons = async (id: string) => (await prisma.fleetActivity.findMany({ where: { entityId: id, action: 'schedule.tick_skipped' } }))
    .map((r) => (r.payload as { reason: string }).reason);
  const hooks = () => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: '"event":"fleet.schedule.disabled"' } } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    ticker = app.get(ScheduleTicker);
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.schedule.disabled']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('dispatches a due schedule once: a QUEUED RUN linked to it, lastJobId set, nextFireAt moved to the next fire', async () => {
    const s = await schedule();
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 1, dispatched: 1 }));
    const [job] = await jobsOf(s.id);
    expect(job).toEqual(expect.objectContaining({ command: 'RUN', feature: s.feature, ref: 'trunk', state: 'QUEUED', requestedById: world.ids.dev }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ lastJobId: job.id, nextFireAt: NEXT, lastFiredAt: NOW, enabled: true }));
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 0 }));
  });

  it('two concurrent ticks create exactly one job', async () => {
    const s = await schedule();
    const [a, b] = await Promise.all([ticker.tick(NOW), ticker.tick(NOW)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('collapses fires missed while the API was down into one job and a future nextFireAt', async () => {
    const s = await schedule({ nextFireAt: new Date('2026-09-29T03:00:00.000Z') });
    await ticker.tick(NOW);
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect((await reload(s.id)).nextFireAt).toEqual(NEXT);
  });

  it('coalesces the next tick into the still-QUEUED job', async () => {
    const s = await schedule();
    await ticker.tick(NOW);
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    expect(await ticker.tick(new Date('2026-10-02T04:00:30.000Z'))).toEqual(expect.objectContaining({ coalesced: 1, dispatched: 0 }));
    const jobs = await jobsOf(s.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ state: 'QUEUED', coalescedCount: 1 }));
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.tick_coalesced' } })).toBe(1);
  });

  it('skips while the schedule\'s job is RUNNING, and stays enabled', async () => {
    const s = await schedule();
    await ticker.tick(NOW);
    await prisma.fleetJob.updateMany({ where: { scheduleId: s.id }, data: { state: 'RUNNING' } });
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    expect(await ticker.tick(new Date('2026-10-02T04:00:30.000Z'))).toEqual(expect.objectContaining({ skipped: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect(await skipReasons(s.id)).toEqual(['job_active']);
    expect((await reload(s.id)).enabled).toBe(true);
  });

  it('a paused budget skips the tick without disabling', async () => {
    const s = await schedule();
    await prisma.budgetPolicy.create({
      data: {
        scopeType: 'global', scopeKey: 'global', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), pausedAt: NOW,
        pausedWindowStart: new Date(0), createdById: world.ids.root, updatedById: world.ids.root,
      },
    });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ skipped: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await skipReasons(s.id)).toEqual(['budget_paused']);
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, nextFireAt: NEXT }));
  });

  it('never coalesces into a manual job of the same feature: skips and stays enabled', async () => {
    const s = await schedule({ feature: 'shared' });
    await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: 'shared', profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'QUEUED',
      },
    });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ skipped: 1, dispatched: 0 }));
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await skipReasons(s.id)).toEqual(['active_job_elsewhere']);
    expect((await reload(s.id)).enabled).toBe(true);
  });

  it.each([
    ['removed from the project', () => owner(null)],
    ['demoted to VIEWER', () => owner('VIEWER')],
    ['disabled', () => owner('DEVELOPER', { disabled: true })],
  ])('owner %s: disabled once with owner_lost_access, one activity row and one webhook, and not ticked again', async (_name, makeOwner) => {
    const s = await schedule({ createdById: await makeOwner(), updatedById: world.ids.root });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ disabled: 1, dispatched: 0 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.auto_disabled' } })).toBe(1);
    expect(await hooks()).toBe(1);
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await ticker.tick(new Date('2026-10-02T05:00:30.000Z'))).toEqual(expect.objectContaining({ claimed: 0 }));
  });

  it('a global ADMIN owner with no project membership may dispatch', async () => {
    const s = await schedule({ createdById: world.ids.root });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ dispatched: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it.each(['deleted', 'disabled'] as const)('a schedule %s between findDue and the claim loses the claim: nothing is dispatched, nothing throws', async (change) => {
    const s = await schedule();
    const repo = app.get(PrismaScheduleRepository);
    const original = repo.findDue.bind(repo);
    const spy = jest.spyOn(repo, 'findDue').mockImplementationOnce(async (now, limit) => {
      const rows = await original(now, limit);
      if (change === 'deleted') await prisma.jobSchedule.delete({ where: { id: s.id } });
      else await prisma.jobSchedule.update({ where: { id: s.id }, data: { enabled: false, disabledReason: 'manual' } });
      return rows;
    });
    try {
      expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 0, failed: 0 }));
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.fleetJob.count({ where: { feature: s.feature } })).toBe(0);
  });

  it('a schedule deleted between the claim and the dispatch: the job insert fails on the schedule FK, the ticker ends as a no-op disable, nothing throws (plan D199)', async () => {
    const s = await schedule();
    const jobs = app.get(FleetJobsService);
    const original = jobs.dispatch.bind(jobs);
    const spy = jest.spyOn(jobs, 'dispatch').mockImplementationOnce(async (...args) => {
      await prisma.jobSchedule.delete({ where: { id: s.id } });
      return original(...args);
    });
    try {
      expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ failed: 0, dispatched: 0 }));
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.fleetJob.count({ where: { feature: s.feature } })).toBe(0);
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.auto_disabled' } })).toBe(0);
  });

  it('a deleted repo disables with template_invalid', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'doomed', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    const s = await schedule({ repoId: repo.id });
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ disabled: 1 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'template_invalid' }));
    expect(await hooks()).toBe(1);
  });

  it('a pinned runner that is gone disables with template_invalid', async () => {
    const s = await schedule({ pinnedRunnerId: 'runner-that-was-deleted' });
    expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ disabled: 1 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'template_invalid' }));
  });

  it('a soft-deleted project is not ticked at all', async () => {
    const s = await schedule({ projectId: world.opsProjectId, repoId: world.foreignRepoId, createdById: world.ids.root });
    await prisma.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: new Date() } });
    try {
      expect(await ticker.tick(NOW)).toEqual(expect.objectContaining({ claimed: 0 }));
      expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, nextFireAt: DUE }));
      expect(await jobsOf(s.id)).toHaveLength(0);
    } finally {
      await prisma.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: null } });
    }
  });

  it('fires a Singapore-zone cron at its local time, whatever the process zone', async () => {
    const s = await schedule({ cron: '30 8 * * *', timezone: 'Asia/Singapore', nextFireAt: new Date('2026-10-02T00:30:00.000Z') });
    await ticker.tick(new Date('2026-10-02T00:30:10.000Z'));
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect((await reload(s.id)).nextFireAt).toEqual(new Date('2026-10-03T00:30:00.000Z'));
  });
});
