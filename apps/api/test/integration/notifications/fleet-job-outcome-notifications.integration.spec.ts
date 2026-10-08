/**
 * Fleet S4a §2.4 — fleet_job_outcome end to end on PG: enqueue in the transition transaction, no duplicate on
 * redelivery, a new lease notifies again, CANCELLED never notifies.
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-job-outcome-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { JobTransitionsService } from '../../../src/fleet/jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('fleet job outcome notifications (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let tx: ITransactionManager;
  let jobs: IFleetJobRepository;
  let transitions: JobTransitionsService;
  let publisher: FanOutPublisher;
  let runnerId: string;
  let n = 0;

  const uploading = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `out${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'UPLOADING', runnerId, leaseEpoch: 1, ...over,
    },
  });
  const finish = (jobId: string, to: 'ESCALATED' | 'FAILED' | 'CANCELLED') => tx.run(async () => {
    const job = await jobs.lockById(jobId);
    return transitions.apply({ job, to, by: 'runner', now: new Date(), actor: { type: 'RUNNER', id: runnerId } });
  });
  const deliverAll = async (): Promise<void> => {
    for (const row of await prisma.outboxEvent.findMany({ where: { type: 'fleet_job_outcome' }, orderBy: { createdAt: 'asc' } })) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), { id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId } }));
    }
  };
  const devNotes = () => prisma.notification.findMany({ where: { userId: world.ids.dev }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    tx = app.get(TRANSACTION_MANAGER);
    jobs = app.get(FLEET_JOB_REPOSITORY);
    transitions = app.get(JobTransitionsService);
    publisher = app.get(FanOutPublisher);
    runnerId = (await insertRunner(prisma, { createdById: world.ids.root })).id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('enqueues one event per terminal transition, keyed by job and epoch, and none for CANCELLED', async () => {
    const escalated = await uploading();
    const cancelled = await uploading();
    await finish(escalated.id, 'ESCALATED');
    await finish(cancelled.id, 'CANCELLED');
    const rows = await prisma.outboxEvent.findMany({ where: { type: 'fleet_job_outcome' } });
    expect(rows.map((r) => ({ projectId: r.projectId, eventId: r.eventId }))).toEqual([{ projectId: world.projectId, eventId: `${escalated.id}:1` }]);
  });

  it('a rolled-back transition leaves no event', async () => {
    const job = await uploading();
    await expect(tx.run(async () => {
      await transitions.apply({ job: await jobs.lockById(job.id), to: 'FAILED', by: 'runner', now: new Date(), actor: { type: 'RUNNER', id: runnerId } });
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_job_outcome' } })).toBe(0);
  });

  it('redelivery creates no duplicate; a requeued attempt that fails again notifies again', async () => {
    const job = await uploading();
    await finish(job.id, 'FAILED');
    await deliverAll();
    await deliverAll();
    expect((await devNotes()).map((x) => [x.kind, x.sourceId])).toEqual([['job_failed', `${job.id}:1`]]);
    // the next attempt (requeue bumps the epoch; seeded directly here)
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'UPLOADING', leaseEpoch: 2, finishedAt: null } });
    await finish(job.id, 'FAILED');
    await deliverAll();
    const notes = await devNotes();
    expect(notes.map((x) => x.sourceId)).toEqual([`${job.id}:1`, `${job.id}:2`]);
    expect(notes[0]).toMatchObject({ category: 'FLEET_NEEDS_YOU', link: `/web/fleet/jobs/${job.id}`, projectId: world.projectId, readAt: null });
  });

  it('a requester who lost project membership is not notified', async () => {
    const job = await uploading({ requestedById: world.ids.outsider });
    await finish(job.id, 'ESCALATED');
    await deliverAll();
    expect(await prisma.notification.count({ where: { userId: world.ids.outsider } })).toBe(0);
  });
});
