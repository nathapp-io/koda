/**
 * Fleet S1b slice 2a — dispatch and requeue refuse a paused scope with 409 fleet.budgetPaused (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-enforcement.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const monthStart = (d: Date, back = 0): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));

describeIntegration('fleet budget enforcement at dispatch and requeue (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const dispatch = (feature: string, over: Record<string, unknown> = {}) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth()).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature, ...over });

  /** A policy paused in the current month (or `back` months ago: a stale pause). */
  const pausedPolicy = (scopeType: string, scopeId: string | null, over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}, back = 0) =>
    prisma.budgetPolicy.create({
      data: {
        scopeType, scopeId, scopeKey: scopeId ? `${scopeType}:${scopeId}` : 'global',
        projectId: scopeType === 'project' || scopeType === 'repo' ? world.projectId : null,
        windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(1), createdById: world.ids.root, updatedById: world.ids.root,
        pausedAt: new Date(), pausedWindowStart: monthStart(new Date(), back), ...over,
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
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
  });

  it('refuses a dispatch in a paused project with 409 naming the policy (D154)', async () => {
    const policy = await pausedPolicy('project', world.projectId);
    const res = await dispatch('e-project').expect(409);
    expect(res.body.message).toContain(policy.id);
    expect(res.body.message).toContain(`project:${world.projectId}`);
    expect(await prisma.fleetJob.count({ where: { feature: 'e-project' } })).toBe(0);
  });

  it('refuses under a paused global or repo policy and a lifetime pause', async () => {
    const global = await pausedPolicy('global', null);
    expect((await dispatch('e-global').expect(409)).body.message).toContain(global.id);
    await prisma.budgetPolicy.deleteMany();
    await pausedPolicy('repo', world.repoId);
    await dispatch('e-repo').expect(409);
    await prisma.budgetPolicy.deleteMany();
    await pausedPolicy('project', world.projectId, { windowKind: 'lifetime', pausedWindowStart: new Date(0) });
    await dispatch('e-lifetime').expect(409);
  });

  it('ignores a stale monthly pause and another repo\'s pause', async () => {
    await pausedPolicy('project', world.projectId, {}, 1);
    await pausedPolicy('repo', world.foreignRepoId, { projectId: world.opsProjectId });
    await dispatch('e-stale').expect(201);
  });

  it('refuses a dispatch pinned to a paused runner', async () => {
    const runner = await insertRunner(prisma);
    const policy = await pausedPolicy('runner', runner.id);
    expect((await dispatch('e-pinned', { pinnedRunnerId: runner.id }).expect(409)).body.message).toContain(policy.id);
  });

  it('refuses a requeue in a paused scope and leaves the job as it was', async () => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'e-requeue', profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'FAILED', finishedAt: new Date(),
      },
    });
    await pausedPolicy('project', world.projectId);
    await request(server).post(`/api/projects/web/fleet/jobs/${job.id}/requeue`).set(auth()).expect(409);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(expect.objectContaining({ state: 'FAILED', leaseEpoch: 0 }));
  });
});
