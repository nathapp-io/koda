/**
 * Fleet S1 slice 2 — activity scoping and delete guards (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-admin-guards.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet activity scope and delete guards (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const job = (repoId: string, projectId: string, feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
  });

  it('shows members only their projects\' job activity; admins see everything', async () => {
    await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev'))
      .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 1, feature: 'act' }).expect(201);
    await request(server).post('/api/fleet/enrollments').set(auth('root')).send({ labels: [] }).expect(201);
    await prisma.fleetActivity.create({ data: { actorType: 'SYSTEM', actorId: 'system', action: 'job.dispatched', entityType: 'job', entityId: 'x', jobId: 'x', projectId: world.opsProjectId, payload: {} } });

    const mine = data<{ records: Array<{ projectId: string | null; entityType: string }> }>(await request(server).get('/api/fleet/activity').set(auth('viewer')).expect(200));
    expect(mine.records.length).toBeGreaterThan(0);
    expect(mine.records.every((r) => r.projectId === world.projectId && r.entityType === 'job')).toBe(true);
    const none = data<{ records: unknown[] }>(await request(server).get('/api/fleet/activity').set(auth('outsider')).expect(200));
    expect(none.records).toEqual([]);
    const all = data<{ records: Array<{ entityType: string }> }>(await request(server).get('/api/fleet/activity?size=100').set(auth('root')).expect(200));
    expect(all.records.map((r) => r.entityType)).toEqual(expect.arrayContaining(['job', 'enrollment']));
    const one = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'act' } });
    const byJob = data<{ records: Array<{ jobId: string }> }>(await request(server).get(`/api/fleet/activity?jobId=${one.id}`).set(auth('dev')).expect(200));
    expect(byJob.records.every((r) => r.jobId === one.id)).toBe(true);
  });

  it('refuses to delete a runner with an unfinished or pinned job, then allows it once all are finished', async () => {
    const r = await insertRunner(prisma);
    const running = await job(world.repoId, world.projectId, 'del-r', { state: 'RUNNING', runnerId: r.id, leaseEpoch: 1 });
    await request(server).delete(`/api/fleet/runners/${r.id}`).set(auth('root')).expect(409);
    await prisma.fleetJob.update({ where: { id: running.id }, data: { state: 'COMPLETED' } });
    const pinned = await job(world.repoId, world.projectId, 'del-pin', { pinnedRunnerId: r.id });
    await request(server).delete(`/api/fleet/runners/${r.id}`).set(auth('root')).expect(409);
    await prisma.fleetJob.update({ where: { id: pinned.id }, data: { state: 'CANCELLED' } });
    await request(server).delete(`/api/fleet/runners/${r.id}`).set(auth('root')).expect(204);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: running.id } })).runnerId).toBeNull();
  });

  it('refuses to delete a repo with an unfinished job; a finished history is deleted with it', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    const j = await job(repo.id, world.projectId, 'del-repo');
    await request(server).delete(`/api/fleet/repos/${repo.id}`).set(auth('root')).expect(409);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'FAILED' } });
    await request(server).delete(`/api/fleet/repos/${repo.id}`).set(auth('root')).expect(204);
    expect(await prisma.fleetJob.count({ where: { id: j.id } })).toBe(0);
  });
});
