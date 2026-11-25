import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S1b slice 3a — ScheduleTicker on PG with a fixed clock: the claim, coalescing, skips and the disable paths.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-ticker.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { ROLE_KEY_FOR_LEGACY_ROLE, type LegacyProjectRole } from '../../../src/permissions/legacy-project-roles';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { PrismaScheduleRepository } from '../../../src/fleet/schedules/prisma-schedule.repository';
import { ScheduleTicker } from '../../../src/fleet/schedules/schedule-ticker';
import { ProjectsService } from '../../../src/projects/projects.service';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { createTestPrismaClient } from '../../helpers/test-prisma';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

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
  const owner = async (role: string | null, over: Partial<Prisma.UserUncheckedCreateInput> = {}, projectId = world.projectId): Promise<string> => {
    const user = await prisma.user.create({ data: { email: `owner${++n}@koda.test`, passwordHash: 'x',  ...over } });
    await grantBaseline(prisma, { type: 'USER', id: user.id });
    if (role) await grantRole(prisma, { type: 'USER', id: user.id }, ROLE_KEY_FOR_LEGACY_ROLE[role as LegacyProjectRole], projectId);
    return user.id;
  };
  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });
  const jobsOf = (scheduleId: string) => prisma.fleetJob.findMany({ where: { scheduleId } });
  const skipReasons = async (id: string) => (await prisma.fleetActivity.findMany({ where: { entityId: id, action: 'schedule.tick_skipped' } }))
    .map((r) => (r.payload as { reason: string }).reason);
  const hooks = () => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: '"event":"fleet.schedule.disabled"' } } });
  /** One timer round as `runOnce` runs it: the ticker is the `schedule` system component. */
  const tick = (now: Date) => withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => ticker.tick(now));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
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

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });

  it('dispatches a due schedule once: a QUEUED RUN linked to it, lastJobId set, nextFireAt moved to the next fire', async () => {
    const s = await schedule();
    expect(await tick(NOW)).toEqual(expect.objectContaining({ claimed: 1, dispatched: 1 }));
    const [job] = await jobsOf(s.id);
    expect(job).toEqual(expect.objectContaining({ command: 'RUN', feature: s.feature, ref: 'trunk', state: 'QUEUED', requestedById: world.ids.dev }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ lastJobId: job.id, nextFireAt: NEXT, lastFiredAt: NOW, enabled: true }));
    expect(await tick(NOW)).toEqual(expect.objectContaining({ claimed: 0 }));
  });

  it('two concurrent ticks create exactly one job', async () => {
    const s = await schedule();
    const [a, b] = await Promise.all([tick(NOW), tick(NOW)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('collapses fires missed while the API was down into one job and a future nextFireAt', async () => {
    const s = await schedule({ nextFireAt: new Date('2026-09-29T03:00:00.000Z') });
    await tick(NOW);
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect((await reload(s.id)).nextFireAt).toEqual(NEXT);
  });

  it('coalesces the next tick into the still-QUEUED job', async () => {
    const s = await schedule();
    await tick(NOW);
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    expect(await tick(new Date('2026-10-02T04:00:30.000Z'))).toEqual(expect.objectContaining({ coalesced: 1, dispatched: 0 }));
    const jobs = await jobsOf(s.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ state: 'QUEUED', coalescedCount: 1 }));
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.tick_coalesced' } })).toBe(1);
  });

  it('skips while the schedule\'s job is RUNNING, and stays enabled', async () => {
    const s = await schedule();
    await tick(NOW);
    await prisma.fleetJob.updateMany({ where: { scheduleId: s.id }, data: { state: 'RUNNING' } });
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    expect(await tick(new Date('2026-10-02T04:00:30.000Z'))).toEqual(expect.objectContaining({ skipped: 1 }));
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
    expect(await tick(NOW)).toEqual(expect.objectContaining({ skipped: 1 }));
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
    expect(await tick(NOW)).toEqual(expect.objectContaining({ skipped: 1, dispatched: 0 }));
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
    expect(await tick(NOW)).toEqual(expect.objectContaining({ disabled: 1, dispatched: 0 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.auto_disabled' } })).toBe(1);
    expect(await hooks()).toBe(1);
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await tick(new Date('2026-10-02T05:00:30.000Z'))).toEqual(expect.objectContaining({ claimed: 0 }));
  });

  it('a global ADMIN owner with no project membership may dispatch', async () => {
    const s = await schedule({ createdById: world.ids.root });
    expect(await tick(NOW)).toEqual(expect.objectContaining({ dispatched: 1 }));
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it.each(['deleted', 'disabled'] as const)('a schedule %s between findDue and the claim loses the claim: nothing is dispatched, nothing throws', async (change) => {
    const s = await schedule();
    const repo = app.get(PrismaScheduleRepository);
    const original = repo.findDue.bind(repo);
    const spy = vi.spyOn(repo, 'findDue').mockImplementationOnce(async (now, limit) => {
      const rows = await original(now, limit);
      if (change === 'deleted') await prisma.jobSchedule.delete({ where: { id: s.id } });
      else await prisma.jobSchedule.update({ where: { id: s.id }, data: { enabled: false, disabledReason: 'manual' } });
      return rows;
    });
    try {
      expect(await tick(NOW)).toEqual(expect.objectContaining({ claimed: 0, failed: 0 }));
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.fleetJob.count({ where: { feature: s.feature } })).toBe(0);
  });

  it('a schedule deleted between the claim and the dispatch: the job insert fails on the schedule FK, the ticker ends as a no-op disable, nothing throws (plan D199)', async () => {
    const s = await schedule();
    const jobs = app.get(FleetJobsService);
    const original = jobs.dispatch.bind(jobs);
    const spy = vi.spyOn(jobs, 'dispatch').mockImplementationOnce(async (...args) => {
      await prisma.jobSchedule.delete({ where: { id: s.id } });
      return original(...args);
    });
    try {
      expect(await tick(NOW)).toEqual(expect.objectContaining({ failed: 0, dispatched: 0 }));
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
    expect(await tick(NOW)).toEqual(expect.objectContaining({ disabled: 1 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'template_invalid' }));
    expect(await hooks()).toBe(1);
  });

  it('a pinned runner that is gone disables with template_invalid', async () => {
    const s = await schedule({ pinnedRunnerId: 'runner-that-was-deleted' });
    expect(await tick(NOW)).toEqual(expect.objectContaining({ disabled: 1 }));
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'template_invalid' }));
  });

  it('a soft-deleted project is not ticked at all', async () => {
    const s = await schedule({ projectId: world.opsProjectId, repoId: world.foreignRepoId, createdById: world.ids.root });
    await prisma.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: new Date() } });
    try {
      expect(await tick(NOW)).toEqual(expect.objectContaining({ claimed: 0 }));
      expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, nextFireAt: DUE }));
      expect(await jobsOf(s.id)).toHaveLength(0);
    } finally {
      await prisma.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: null } });
    }
  });

  it('fires a Singapore-zone cron at its local time, whatever the process zone', async () => {
    const s = await schedule({ cron: '30 8 * * *', timezone: 'Asia/Singapore', nextFireAt: new Date('2026-10-02T00:30:00.000Z') });
    await tick(new Date('2026-10-02T00:30:10.000Z'));
    expect(await jobsOf(s.id)).toHaveLength(1);
    expect((await reload(s.id)).nextFireAt).toEqual(new Date('2026-10-03T00:30:00.000Z'));
  });

  /**
   * US-008 (review finding 4) — the reviewed controls put the two sides of this race side by side; these tests
   * run its interleaving on disposable PostgreSQL, with two connections and no runner attached.
   *
   * Each test owns its project, repo and schedule: the delete under test must not touch the shared world.
   */
  describe('US-008 project-deletion fence', () => {
    let observer: PrismaClient;
    let projects: ProjectsService;
    let jobRepo: PrismaFleetJobRepository;

    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    };

    /** Awaits `promise`, failing loudly instead of hanging the whole file when the interleaving never happens. */
    const within = async <T>(promise: Promise<T>, what: string, ms = 5_000): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      });
      try {
        return await Promise.race([promise, deadline]);
      } finally {
        clearTimeout(timer);
      }
    };

    /** A live project with a repo of its own and a developer owner, so the tick and its delete are its own. */
    const ownProject = async (): Promise<{ projectId: string; repoId: string; createdById: string }> => {
      const slug = `fence${++n}`;
      const project = await prisma.project.create({ data: { name: slug, slug, key: `F${n}` } });
      const repo = await prisma.fleetRepo.create({
        data: {
          projectId: project.id, provider: 'github', owner: 'acme', name: slug, defaultBranch: 'main',
          githubInstallationId: BigInt(90), createdById: world.ids.root,
        },
      });
      return { projectId: project.id, repoId: repo.id, createdById: await owner('DEVELOPER', {}, project.id) };
    };

    /** The delete under test: the application's own soft-delete path, and the listener it announces to. */
    const softDelete = (projectId: string) =>
      withTestActor({ type: 'USER', id: world.ids.root }, () => projects.softDeleteById(projectId));

    /** Committed state, read on a connection of the observer's own — what a fresh request would see. */
    const committedJobs = (scheduleId: string) => observer.fleetJob.count({ where: { scheduleId } });
    const committedAssigns = (scheduleId: string) => observer.fleetCommand.count({ where: { type: 'ASSIGN', job: { scheduleId } } });

    /** Non-granted lock requests in this database: a statement PostgreSQL is holding on a lock for. */
    const lockWaits = async (): Promise<number> => (await observer.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database()`)[0].n;

    const waitForLockWait = async (timeoutMs = 4_000): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const waits = await lockWaits();
        if (waits > 0 || Date.now() > deadline) return waits;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    /**
     * The AC-3/AC-4 interleaving: the tick's insertion transaction pauses right after its in-transaction
     * live-project read — so it holds the project's row lock — and the application's delete then starts on
     * another connection and blocks on that lock until the insert is released.
     */
    const insertAgainstDelete = async () => {
      const own = await ownProject();
      const s = await schedule({ projectId: own.projectId, repoId: own.repoId, createdById: own.createdById, updatedById: world.ids.root });
      const original = jobRepo.lockLiveProject.bind(jobRepo);
      const locked = deferred();
      const release = deferred();
      const spy = vi.spyOn(jobRepo, 'lockLiveProject').mockImplementation(async (projectId: string) => {
        const live = await original(projectId);   // the real SELECT … FOR NO KEY UPDATE, inside the transaction
        locked.resolve();
        await release.promise;
        return live;
      });
      const ticked = tick(NOW);
      try {
        await within(locked.promise, 'the insertion transaction to read the live project under its lock');
      } catch (error) {
        spy.mockRestore();
        void ticked.catch(() => undefined);
        throw error;
      }
      let settled = false;
      const deletion = softDelete(s.projectId).then((deleted) => { settled = true; return deleted; });
      return {
        ...own, scheduleId: s.id, deletion,
        deleteSettled: () => settled,
        /** Lets the insert commit; the delete's own wait then ends. */
        releaseInsert: async () => { release.resolve(); await ticked; spy.mockRestore(); },
      };
    };

    beforeAll(() => {
      observer = createTestPrismaClient();
      projects = app.get(ProjectsService);
      jobRepo = app.get(PrismaFleetJobRepository);
    });

    afterAll(async () => {
      await observer.$disconnect();
    });

    it('US-008 AC-1: a delete committed while the tick waits after owner authorization leaves zero jobs for the schedule', async () => {
      const own = await ownProject();
      const s = await schedule({ projectId: own.projectId, repoId: own.repoId, createdById: own.createdById, updatedById: world.ids.root });
      const jobs = app.get(FleetJobsService);
      const original = jobs.dispatch.bind(jobs);
      const authorized = deferred();
      const resume = deferred();
      const spy = vi.spyOn(jobs, 'dispatch').mockImplementationOnce(async (...args) => {
        authorized.resolve();   // the tick's owner authorization already succeeded
        await resume.promise;   // … and the tick waits here, before its insertion transaction opens
        return original(...args);
      });
      let result: Awaited<ReturnType<ScheduleTicker['tick']>>;
      try {
        const ticked = tick(NOW);
        await within(authorized.promise, 'the tick to finish owner authorization');
        await softDelete(own.projectId);
        resume.resolve();
        result = await ticked;
      } finally {
        resume.resolve();   // never leave a paused tick behind, even when an expectation above failed
        spy.mockRestore();
      }

      expect(result).toEqual(expect.objectContaining({ claimed: 1, dispatched: 0 }));
      expect(await committedJobs(s.id)).toBe(0);
      expect(await observer.fleetJob.count({ where: { projectId: own.projectId } })).toBe(0);
    });

    it('US-008 AC-2: the resumed tick leaves no assignment command for the schedule it could not dispatch', async () => {
      const own = await ownProject();
      const s = await schedule({ projectId: own.projectId, repoId: own.repoId, createdById: own.createdById, updatedById: world.ids.root });
      const jobs = app.get(FleetJobsService);
      const original = jobs.dispatch.bind(jobs);
      const authorized = deferred();
      const resume = deferred();
      const spy = vi.spyOn(jobs, 'dispatch').mockImplementationOnce(async (...args) => {
        authorized.resolve();
        await resume.promise;
        return original(...args);
      });
      try {
        const ticked = tick(NOW);
        await within(authorized.promise, 'the tick to finish owner authorization');
        await softDelete(own.projectId);
        resume.resolve();
        await ticked;
      } finally {
        resume.resolve();
        spy.mockRestore();
      }

      expect(await committedAssigns(s.id)).toBe(0);
      expect(await observer.fleetCommand.count()).toBe(0);
      // …because the refused tick dispatched nothing at all: no linked job, no dispatch activity.
      expect((await observer.jobSchedule.findUniqueOrThrow({ where: { id: s.id } })).lastJobId).toBeNull();
      expect(await observer.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.tick_dispatched' } })).toBe(0);
    });

    it('US-008 AC-3: a soft deletion started while the authorized insert holds the project lock waits for it', async () => {
      const race = await insertAgainstDelete();
      let waits = 0;
      try {
        // The delete was started before this observation and has not finished: a waiting statement is what
        // is left in PostgreSQL's lock table.
        expect(race.deleteSettled()).toBe(false);
        waits = await waitForLockWait();
        expect(race.deleteSettled()).toBe(false);
      } finally {
        await race.releaseInsert();
      }
      expect(waits).toBeGreaterThan(0);
      await race.deletion;
      expect(await observer.fleetJob.count({ where: { projectId: race.projectId } })).toBe(1);
    });

    it('US-008 AC-4: the delete that waited for the insert cancels the queued job through its listener', async () => {
      const race = await insertAgainstDelete();
      try {
        expect(await waitForLockWait()).toBeGreaterThan(0);
      } finally {
        await race.releaseInsert();
      }
      await race.deletion;

      const jobs = await observer.fleetJob.findMany({ where: { projectId: race.projectId } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual(expect.objectContaining({
        state: 'CANCELLED', stateReason: 'project_deleted', cancelReason: 'project_deleted',
      }));
      expect(jobs[0].scheduleId).toBe(race.scheduleId);
    });

    it('US-008 AC-5: a live project with an authorized owner still dispatches one job, including two tickers racing for one occurrence', async () => {
      const live = await ownProject();
      const s = await schedule({ projectId: live.projectId, repoId: live.repoId, createdById: live.createdById, updatedById: world.ids.root });
      expect(await tick(NOW)).toEqual(expect.objectContaining({ dispatched: 1 }));
      expect(await committedJobs(s.id)).toBe(1);

      const raced = await ownProject();
      const r = await schedule({ projectId: raced.projectId, repoId: raced.repoId, createdById: raced.createdById, updatedById: world.ids.root });
      const [a, b] = await Promise.all([tick(NOW), tick(NOW)]);
      expect(a.claimed + b.claimed).toBe(1);
      expect(await committedJobs(r.id)).toBe(1);
    });
  });
});
