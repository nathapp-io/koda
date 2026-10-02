/**
 * Fleet S1 slice 2a — cancel and requeue over HTTP (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet job cancel and requeue (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let projectId: string;
  let repoId: string;
  let ids: FleetHttpWorld['ids'];
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    ({ projectId, repoId, ids } = world);
  });
  afterAll(async () => {
    await app.close();
  });

  const insertJob = async (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [], maxCostUsd: 5, selectorLabels: [],
        requestedById: ids.dev, ...over,
      },
    });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const post = (who: keyof FleetHttpWorld['tokens'], id: string, action: 'cancel' | 'requeue') =>
    request(server).post(`/api/projects/web/fleet/jobs/${id}/${action}`).set(auth(who));

  it('cancels a QUEUED job on the server', async () => {
    const job = await insertJob('c-queued');
    await post('dev', job.id, 'cancel').expect(200);
    expect(await reload(job.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', leaseEpoch: 0 }));
  });

  it('cancels an ASSIGNED job whose assign was never acked: withdraws the ASSIGN and bumps the epoch', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('c-unacked', { state: 'ASSIGNED', runnerId: runner.id, leaseEpoch: 1 });
    const assign = await prisma.fleetCommand.create({ data: { runnerId: runner.id, jobId: job.id, type: 'ASSIGN', leaseEpoch: 1, payload: {} } });
    await post('dev', job.id, 'cancel').expect(200);
    expect(await reload(job.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', leaseEpoch: 2 }));
    expect(await prisma.fleetCommand.findUniqueOrThrow({ where: { id: assign.id } })).toEqual(expect.objectContaining({ ackResult: 'withdrawn' }));
  });

  it('asks the runner to cancel a RUNNING job exactly once', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('c-running', { state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    await post('dev', job.id, 'cancel').expect(200);
    await post('dev', job.id, 'cancel').expect(200);
    expect((await reload(job.id)).cancelRequestedAt).not.toBeNull();
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id, type: 'CANCEL', ackedAt: null } })).toBe(1);
  });

  it('refuses to cancel a finished job with 409, lets a requester cancel, and forbids other viewers', async () => {
    const done = await insertJob('c-done', { state: 'COMPLETED' });
    await post('dev', done.id, 'cancel').expect(409);
    const mine = await insertJob('c-mine', { requestedById: ids.viewer });
    await post('viewer', mine.id, 'cancel').expect(200);
    const theirs = await insertJob('c-theirs');
    await post('viewer', theirs.id, 'cancel').expect(403);
  });

  it('requeues a CRASHED job: clears the run, bumps the epoch and places it again', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('rq', {
      state: 'CRASHED', runnerId: runner.id, leaseEpoch: 3, naxRunId: 'run-1', costSpentUsd: 1.5, stateReason: 'runner silent', finishedAt: new Date(),
      wipPush: 'pushed', stories: [{ id: 'US-001', title: 't', status: 'failed', attempts: 2, dependsOn: [] }], storiesTruncated: true,
    });
    const res = data<{ job: { state: string; leaseEpoch: number } }>(await post('dev', job.id, 'requeue').expect(200));
    // 3 -> 4 on requeue, 4 -> 5 on the compare-and-set assignment.
    expect(res.job).toEqual(expect.objectContaining({ state: 'ASSIGNED', leaseEpoch: 5 }));
    const after = await reload(job.id);
    expect(after).toEqual(expect.objectContaining({ naxRunId: null, finishedAt: null, ackedRunnerSeq: 0, wipPush: null, stories: null, storiesTruncated: false }));
    expect(after.costSpentUsd.toString()).toBe('0');
  });

  it('carries the attempt spend into costCarriedUsd on requeue and keeps firstStartedAt (S1b §2.1)', async () => {
    const runner = await insertRunner(prisma);
    const first = new Date('2026-10-01T08:00:00.000Z');
    const job = await insertJob('rq-carry', {
      state: 'FAILED', runnerId: runner.id, leaseEpoch: 1, costSpentUsd: 1.25, costCarriedUsd: 0.5,
      firstStartedAt: first, startedAt: new Date(), finishedAt: new Date(), cancelReason: 'budget:old',
    });
    await post('dev', job.id, 'requeue').expect(200);
    const after = await reload(job.id);
    expect(after.costSpentUsd.toString()).toBe('0');
    expect(after.costCarriedUsd.toString()).toBe('1.75');
    expect(after.firstStartedAt).toEqual(first);
    expect(after.cancelReason).toBeNull();
  });

  it('refuses requeue of a COMPLETED job, of an active duplicate, and by a viewer', async () => {
    await post('dev', (await insertJob('rq-done', { state: 'COMPLETED' })).id, 'requeue').expect(409);
    const failed = await insertJob('rq-dup', { state: 'FAILED' });
    await insertJob('rq-dup'); // QUEUED duplicate
    const res = await post('dev', failed.id, 'requeue').expect(409);
    expect(JSON.stringify(res.body)).toMatch(/active job/i);
    await post('viewer', (await insertJob('rq-viewer', { state: 'FAILED' })).id, 'requeue').expect(403);
  });

  it('withdraws pending non-ABANDON commands from the prior epoch when a CRASHED job is requeued', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('rq-withdraw', {
      state: 'CRASHED', runnerId: runner.id, leaseEpoch: 3, finishedAt: new Date(),
    });
    const cancel = await prisma.fleetCommand.create({
      data: { runnerId: runner.id, jobId: job.id, type: 'CANCEL', leaseEpoch: 3, payload: {} },
    });
    await post('dev', job.id, 'requeue').expect(200);
    expect(await prisma.fleetCommand.findUniqueOrThrow({ where: { id: cancel.id } })).toEqual(
      expect.objectContaining({ ackResult: 'withdrawn' }),
    );
    // ABANDON rows from the prior epoch are deliberately not withdrawn (plan D4).
    const abandon = await prisma.fleetCommand.create({
      data: { runnerId: runner.id, jobId: job.id, type: 'ABANDON', leaseEpoch: 3, payload: {} },
    });
    await post('dev', job.id, 'requeue').expect(409); // job is ASSIGNED now; requeue is not in the table
    expect(await prisma.fleetCommand.findUniqueOrThrow({ where: { id: abandon.id } })).toEqual(
      expect.objectContaining({ ackResult: null, ackedAt: null }),
    );
  });

  it('serves stories and wipPush over HTTP; list pages leave the stories out (S1b 1b, D149, #185)', async () => {
    const stories = [
      { id: 'US-001', title: 'first', status: 'passed', attempts: 1, dependsOn: [] },
      { id: 'US-002', title: 'second', status: 'in-progress', attempts: 0, dependsOn: ['US-001'] },
    ];
    const job = await insertJob('http-dto', { state: 'FAILED', wipPush: 'failed:diverged', stories, storiesTruncated: true, finishedAt: new Date() });
    const one = data<Record<string, unknown>>(await request(server).get(`/api/projects/web/fleet/jobs/${job.id}`).set(auth('dev')).expect(200));
    expect(one).toEqual(expect.objectContaining({ id: job.id, wipPush: 'failed:diverged', stories, storiesTruncated: true }));
    const page = data<{ records: Array<Record<string, unknown>> }>(
      await request(server).get('/api/projects/web/fleet/jobs').query({ feature: 'http-dto' }).set(auth('dev')).expect(200),
    );
    expect(page.records).toEqual([expect.objectContaining({ id: job.id, wipPush: 'failed:diverged', stories: null, storiesTruncated: false })]);
  });
});
