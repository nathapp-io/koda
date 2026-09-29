/**
 * Fleet S1 slice 2 — dispatch, reads, permissions and live events over HTTP (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet jobs (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let projectId: string;
  let repoId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const dispatch = (who: keyof FleetHttpWorld['tokens'], body: Record<string, unknown>) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth(who)).send({ repoId, command: 'RUN', maxCostUsd: 5, ...body });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    ({ projectId, repoId } = world);
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets a DEVELOPER dispatch; with no runner the job stays QUEUED on the default branch', async () => {
    const res = data<{ job: { id: string; state: string; ref: string; maxCostUsd: string }; placement: { assigned: boolean; misfits: unknown[] } }>(
      await dispatch('dev', { feature: 'no-runner' }).expect(201),
    );
    expect(res.job).toEqual(expect.objectContaining({ state: 'QUEUED', ref: 'trunk', maxCostUsd: '5' }));
    expect(res.placement).toEqual({ assigned: false, runnerId: null, misfits: [] });
  });

  it('assigns at dispatch when a runner fits and publishes fleet_job live events', async () => {
    const seen: LiveEvent[] = [];
    const off = app.get(ProjectEventBus).subscribe(projectId, (e) => seen.push(e));
    const runner = await insertRunner(prisma);
    const res = data<{ job: { id: string; state: string; runnerId: string } }>(await dispatch('dev', { feature: 'with-runner', profiles: ['fast'] }).expect(201));
    off();
    expect(res.job).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId: runner.id }));
    expect(seen.filter((e) => e.type === 'fleet_job').map((e) => (e as { state: string }).state)).toEqual(['QUEUED', 'ASSIGNED']);
    const events = data<{ records: Array<{ type: string; payload: { to: string } }> }>(
      await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}/events`).set(auth('viewer')).expect(200),
    );
    expect(events.records.map((e) => e.payload.to)).toEqual(['QUEUED', 'ASSIGNED']);
    await prisma.runner.update({ where: { id: runner.id }, data: { enabled: false } });
  });

  it('answers 409 naming the active job for a duplicate (repo, feature)', async () => {
    const first = data<{ job: { id: string } }>(await dispatch('dev', { feature: 'dup' }).expect(201));
    const res = await dispatch('dev', { feature: 'dup' }).expect(409);
    expect(JSON.stringify(res.body)).toContain(first.job.id);
  });

  it.each([
    ['PLAN without planFrom', { feature: 'p1', command: 'PLAN' }],
    ['bashMode gated', { feature: 'p2', bashMode: 'gated' }],
    ['a reserved profile', { feature: 'p3', profiles: ['koda-job-1'] }],
    ['maxCostUsd 0', { feature: 'p4', maxCostUsd: 0 }],
    ['a bad feature', { feature: '../x' }],
  ])('answers 400 for %s', async (_label, body) => {
    await dispatch('dev', body).expect(400);
  });

  it('refuses a repo of another project (404) and viewers/outsiders (403)', async () => {
    await dispatch('dev', { feature: 'x', repoId: world.foreignRepoId }).expect(404);
    await dispatch('viewer', { feature: 'x' }).expect(403);
    await dispatch('outsider', { feature: 'x' }).expect(403);
    await request(server).get('/api/projects/web/fleet/jobs').set(auth('outsider')).expect(403);
  });

  it('handles pins: unknown 404, disabled 422, offline queues', async () => {
    await dispatch('dev', { feature: 'pin-1', pinnedRunnerId: 'nope' }).expect(404);
    const disabled = await insertRunner(prisma, { enabled: false });
    const res = await dispatch('dev', { feature: 'pin-2', pinnedRunnerId: disabled.id }).expect(422);
    expect(JSON.stringify(res.body)).toContain('disabled');
    const offline = await insertRunner(prisma, { lastSeenAt: new Date(Date.now() - 3_600_000) });
    const queued = data<{ job: { state: string } }>(await dispatch('dev', { feature: 'pin-3', pinnedRunnerId: offline.id }).expect(201));
    expect(queued.job.state).toBe('QUEUED');
  });

  it('lists with filters for any member and gets by id within the project only', async () => {
    const list = data<{ records: Array<{ feature: string }> }>(
      await request(server).get('/api/projects/web/fleet/jobs?feature=dup&state=QUEUED').set(auth('viewer')).expect(200),
    );
    expect(list.records.map((r) => r.feature)).toEqual(['dup']);
    const anyJob = await prisma.fleetJob.findFirstOrThrow({ where: { projectId } });
    await request(server).get(`/api/projects/web/fleet/jobs/${anyJob.id}`).set(auth('viewer')).expect(200);
    await request(server).get(`/api/projects/ops/fleet/jobs/${anyJob.id}`).set(auth('root')).expect(404);
  });
});
