/**
 * Fleet S1b slice 3a — auto-disable through the real transition path (PG): every §3.3 rule, counted once.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-progress.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import type { FleetJobState } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { JobTransitionsService } from '../../../src/fleet/jobs/job-transitions.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

describeIntegration('schedule auto-disable (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let transitions: JobTransitionsService;
  let jobsRepo: IFleetJobRepository;
  let jobs: FleetJobsService;
  let tx: ITransactionManager;
  let n = 0;
  const NOW = new Date('2026-10-02T03:00:30.000Z');

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, name: `p${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `sf${n}`, ref: 'trunk',
      profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: NOW, createdById: world.ids.dev, updatedById: world.ids.dev, ...over,
    },
  });
  /** A scheduled job in UPLOADING (the state the runner ends it from), with the progress nax reported. */
  const uploading = (scheduleId: string | null, progress: Prisma.InputJsonValue | null, feature = `jf${++n}`) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
      selectorLabels: [], requestedById: world.ids.dev, scheduleId, state: 'UPLOADING', ...(progress === null ? {} : { progress }),
    },
  });
  const end = (jobId: string, to: FleetJobState) => tx.run(async () => {
    const job = await jobsRepo.lockById(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    return transitions.apply({ job, to, by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'r1' } });
  });
  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });
  const hooks = () => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: '"event":"fleet.schedule.disabled"' } } });
  const autoDisabledRows = (id: string) => prisma.fleetActivity.count({ where: { entityType: 'schedule', entityId: id, action: 'schedule.auto_disabled' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    transitions = app.get(JobTransitionsService);
    jobsRepo = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    jobs = app.get(FleetJobsService);
    tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.schedule.disabled']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('COMPLETED disables with completed, with one activity row and one webhook', async () => {
    const s = await schedule();
    const j = await uploading(s.id, { passed: 3, total: 3 });
    await end(j.id, 'COMPLETED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'completed' }));
    expect(await autoDisabledRows(s.id)).toBe(1);
    expect(await hooks()).toBe(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleCountedAt).toEqual(NOW);
  });

  it('every story passed but the finish failed disables with finish_failed', async () => {
    const s = await schedule();
    await end((await uploading(s.id, { passed: 2, total: 2 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'finish_failed' }));
  });

  it('counts no-progress ends and disables at noProgressLimit', async () => {
    const s = await schedule({ noProgressLimit: 2 });
    await end((await uploading(s.id, { passed: 0, total: 4 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 1 }));
    await end((await uploading(s.id, { passed: 0, total: 4 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'no_progress', noProgressTicks: 2 }));
    expect(await hooks()).toBe(1);
  });

  it('progress resets the counter and raises lastPassedCount; the same count again is no progress', async () => {
    const s = await schedule({ noProgressTicks: 2, noProgressLimit: 5 });
    await end((await uploading(s.id, { passed: 2, total: 6 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ noProgressTicks: 0, lastPassedCount: 2, enabled: true }));
    await end((await uploading(s.id, { passed: 2, total: 6 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ noProgressTicks: 1, lastPassedCount: 2 }));
    await end((await uploading(s.id, { passed: 3, total: 6 })).id, 'FAILED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ noProgressTicks: 0, lastPassedCount: 3 }));
  });

  it.each([
    ['null progress', null],
    ['a string', 'garbage'],
    ['a negative passed', { passed: -1, total: 3 }],
    ['a fractional passed', { passed: 1.5, total: 3 }],
    ['total 0', { passed: 0, total: 0 }],
  ])('garbled progress (%s) counts as no progress and does not throw', async (_name, progress) => {
    const s = await schedule();
    await expect(end((await uploading(s.id, progress as Prisma.InputJsonValue | null)).id, 'FAILED')).resolves.toBeDefined();
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 1, lastPassedCount: 0 }));
  });

  it('CANCELLED changes neither counter and is not marked counted (plan D195)', async () => {
    const s = await schedule({ noProgressTicks: 1 });
    const j = await uploading(s.id, { passed: 0, total: 3 });
    await end(j.id, 'CANCELLED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 1 }));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleCountedAt).toBeNull();
  });

  it('a requeued scheduled job that ends again is counted once (plan D196)', async () => {
    const s = await schedule({ noProgressLimit: 5 });
    const j = await uploading(s.id, { passed: 0, total: 3 });
    await end(j.id, 'FAILED');
    expect((await reload(s.id)).noProgressTicks).toBe(1);
    await jobs.requeue(world.ids.dev, world.projectId, j.id);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'UPLOADING' } });
    await end(j.id, 'FAILED');
    expect((await reload(s.id)).noProgressTicks).toBe(1);
  });

  it('a manually disabled schedule keeps its reason when its job later completes, and sends no webhook (plan D197)', async () => {
    const s = await schedule({ enabled: false, disabledReason: 'manual' });
    await end((await uploading(s.id, { passed: 3, total: 3 })).id, 'COMPLETED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual' }));
    expect(await hooks()).toBe(0);
    expect(await autoDisabledRows(s.id)).toBe(0);
  });

  it('a job whose schedule was deleted just ends', async () => {
    const s = await schedule();
    const j = await uploading(s.id, { passed: 1, total: 3 });
    await prisma.jobSchedule.delete({ where: { id: s.id } });
    await expect(end(j.id, 'FAILED')).resolves.toBeDefined();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).state).toBe('FAILED');
  });

  it('an unscheduled job is untouched', async () => {
    const s = await schedule();
    const j = await uploading(null, { passed: 3, total: 3 });
    await end(j.id, 'COMPLETED');
    expect(await reload(s.id)).toEqual(expect.objectContaining({ enabled: true, noProgressTicks: 0 }));
  });
});
