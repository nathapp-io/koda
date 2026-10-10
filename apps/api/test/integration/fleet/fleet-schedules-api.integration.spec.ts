/**
 * Fleet S1b slice 3a — schedule management over HTTP: permissions, validation, enable/disable, delete (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedules-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { SchedulesService } from '../../../src/fleet/schedules/schedules.service';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

interface Row {
  id: string; name: string; cron: string; timezone: string; feature: string; ref: string; enabled: boolean; nextFireAt: string | null;
  disabledReason: string | null; lastPassedCount: number; noProgressTicks: number; noProgressLimit: number; totalCostUsd: string;
  createdById: string; pinnedRunnerId: string | null; profiles: string[];
}

describeIntegration('fleet schedules API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let dev2: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const BASE = '/api/projects/web/fleet/schedules';
  const payload = (over: Record<string, unknown> = {}) => ({
    name: 'nightly', repoId: world.repoId, feature: `api${++n}`, cron: '0 9 * * 1-5', timezone: 'asia/singapore', maxCostUsd: 5, ...over,
  });
  const create = async (who: keyof FleetHttpWorld['tokens'] = 'dev', over: Record<string, unknown> = {}) =>
    data<Row>(await request(server).post(BASE).set(tok(who)).send(payload(over)).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // A second DEVELOPER of web (fourth login: within the 5/min throttle). The root global admin stands in for a project ADMIN.
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'dev2@koda.test', name: 'dev2', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'dev2@koda.test', role: 'DEVELOPER' }).expect(201);
    dev2 = await loginToken(server, 'dev2@koda.test');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('a developer creates a schedule: normalised template, repo default branch, next fire in the future, owner recorded', async () => {
    const row = await create();
    expect(row).toEqual(expect.objectContaining({
      name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', ref: 'trunk', enabled: true, disabledReason: null,
      noProgressLimit: 3, noProgressTicks: 0, lastPassedCount: 0, totalCostUsd: '0.0000', createdById: world.ids.dev, pinnedRunnerId: null, profiles: [],
    }));
    expect(new Date(row.nextFireAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.fleetActivity.count({ where: { entityType: 'schedule', entityId: row.id, action: 'schedule.created', projectId: world.projectId } })).toBe(1);
  });

  it('a viewer reads but cannot create; an outsider cannot read', async () => {
    const row = await create();
    await request(server).post(BASE).set(tok('viewer')).send(payload()).expect(403);
    expect(data<Row[]>(await request(server).get(BASE).set(tok('viewer')).expect(200)).map((r) => r.id)).toEqual([row.id]);
    expect(data<Row>(await request(server).get(`${BASE}/${row.id}`).set(tok('viewer')).expect(200)).id).toBe(row.id);
    await request(server).get(BASE).set(tok('outsider')).expect(403);
  });

  it.each([
    ['a cron with four fields', { cron: '* * * *' }],
    ['a cron with six fields', { cron: '* * * * * *' }],
    ['an unknown timezone', { timezone: 'Mars/Base' }],
    ['a feature that is not a single path segment', { feature: '../etc' }],
    ['a reserved profile', { profiles: ['koda-job-x'] }],
    ['a zero budget', { maxCostUsd: 0 }],
    ['a stall limit of zero', { noProgressLimit: 0 }],
    ['a blank name', { name: '   ' }],
  ])('refuses %s with 400', async (_name, over) => {
    await request(server).post(BASE).set(tok('dev')).send(payload(over)).expect(400);
  });

  it('refuses a cron that fires more often than every 15 minutes, saying so', async () => {
    const res = await request(server).post(BASE).set(tok('dev')).send(payload({ cron: '*/10 * * * *' })).expect(400);
    expect(res.body.message).toContain('15 minutes');
    expect(await prisma.jobSchedule.count()).toBe(0);
  });

  it('answers 404 for a repo of another project and for an unknown pinned runner', async () => {
    await request(server).post(BASE).set(tok('dev')).send(payload({ repoId: world.foreignRepoId })).expect(404);
    await request(server).post(BASE).set(tok('dev')).send(payload({ pinnedRunnerId: 'ghost' })).expect(404);
  });

  it('the owner edits; a cron change moves nextFireAt; another developer is refused; a project ADMIN may', async () => {
    const row = await create();
    const edited = data<Row>(await request(server).patch(`${BASE}/${row.id}`).set(tok('dev')).send({ cron: '0 6 * * *', timezone: 'UTC', name: 'morning' }).expect(200));
    expect(edited).toEqual(expect.objectContaining({ cron: '0 6 * * *', timezone: 'UTC', name: 'morning', feature: row.feature }));
    expect(new Date(edited.nextFireAt as string).getUTCHours()).toBe(6);
    await request(server).patch(`${BASE}/${row.id}`).set(as(dev2)).send({ name: 'hijack' }).expect(403);
    const byAdmin = data<Row>(await request(server).patch(`${BASE}/${row.id}`).set(tok('root')).send({ noProgressLimit: 5 }).expect(200));
    expect(byAdmin.noProgressLimit).toBe(5);
    await request(server).patch(`${BASE}/${row.id}`).set(tok('viewer')).send({ name: 'x' }).expect(403);
  });

  it('disable records a manual reason and clears nextFireAt; enable resets the stall counter, keeps lastPassedCount, and sets nextFireAt', async () => {
    const row = await create();
    await prisma.jobSchedule.update({ where: { id: row.id }, data: { noProgressTicks: 2, lastPassedCount: 4 } });
    await request(server).post(`${BASE}/${row.id}/disable`).set(as(dev2)).expect(403);
    const off = data<Row>(await request(server).post(`${BASE}/${row.id}/disable`).set(tok('dev')).expect(200));
    expect(off).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual', nextFireAt: null }));
    expect(await prisma.fleetActivity.count({ where: { entityId: row.id, action: 'schedule.disabled' } })).toBe(1);
    await request(server).post(`${BASE}/${row.id}/enable`).set(as(dev2)).expect(403);
    const on = data<Row>(await request(server).post(`${BASE}/${row.id}/enable`).set(tok('root')).expect(200));
    expect(on).toEqual(expect.objectContaining({ enabled: true, disabledReason: null, noProgressTicks: 0, lastPassedCount: 4 }));
    expect(new Date(on.nextFireAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('enable is refused with 409 when the owner can no longer dispatch, and enabling a healthy schedule still works (plan D211)', async () => {
    const lost = await prisma.user.create({ data: { email: 'lost@koda.test', passwordHash: 'x', role: 'MEMBER' } });
    const off = await prisma.jobSchedule.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, name: 'orphaned', cron: '0 9 * * *', timezone: 'UTC', feature: `own${++n}`, ref: 'trunk',
        profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: new Date(), enabled: false, disabledReason: 'owner_lost_access',
        createdById: lost.id, updatedById: lost.id,
      },
    });
    const res = await request(server).post(`${BASE}/${off.id}/enable`).set(tok('root')).expect(409);
    expect(res.body.message).toContain('owner');
    expect(await prisma.jobSchedule.findUniqueOrThrow({ where: { id: off.id } })).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    await prisma.user.update({ where: { id: lost.id }, data: { disabled: true } });
    await prisma.projectMember.create({ data: { projectId: world.projectId, userId: lost.id, role: 'DEVELOPER' } });
    await request(server).post(`${BASE}/${off.id}/enable`).set(tok('root')).expect(409);
    await prisma.user.update({ where: { id: lost.id }, data: { disabled: false } });
    data<Row>(await request(server).post(`${BASE}/${off.id}/enable`).set(tok('root')).expect(200));
  });

  it('delete is refused for a stranger and keeps the schedule\'s jobs, detached', async () => {
    const row = await create();
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: row.feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
        selectorLabels: [], requestedById: world.ids.dev, scheduleId: row.id, state: 'FAILED',
      },
    });
    await request(server).delete(`${BASE}/${row.id}`).set(as(dev2)).expect(403);
    await request(server).delete(`${BASE}/${row.id}`).set(tok('dev')).expect(204);
    await request(server).get(`${BASE}/${row.id}`).set(tok('dev')).expect(404);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).scheduleId).toBeNull();
    expect(await prisma.fleetActivity.count({ where: { entityId: row.id, action: 'schedule.deleted' } })).toBe(1);
  });

  it('delete takes the job lock before the schedule lock, so it cannot deadlock with a job ending (plan D194)', async () => {
    const row = await create();
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: row.feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
        selectorLabels: [], requestedById: world.ids.dev, scheduleId: row.id, state: 'UPLOADING',
      },
    });
    const holder = createTestPrismaClient();
    let removing: Promise<void> = Promise.resolve();
    try {
      await holder.$transaction(async (tx) => {
        // What the sync path does when a job ends: the job row first, then (onJobEnded) the schedule row.
        await tx.$queryRaw`SELECT "id" FROM "FleetJob" WHERE "id" = ${job.id} FOR UPDATE`;
        removing = app.get(SchedulesService).remove(world.ids.dev, world.projectId, row.id, false);
        removing.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500)); // remove is now waiting for the job row
        await tx.$queryRaw`SELECT "id" FROM "JobSchedule" WHERE "id" = ${row.id} FOR UPDATE`;
        await tx.jobSchedule.update({ where: { id: row.id }, data: { noProgressTicks: 1 } });
      }, { timeout: 15_000 });
      await expect(removing).resolves.toBeUndefined(); // with the schedule locked first this would fail with 40P01
    } finally {
      await holder.$disconnect();
    }
    expect(await prisma.jobSchedule.count({ where: { id: row.id } })).toBe(0);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).scheduleId).toBeNull();
  });

  it('totalCostUsd adds the cost of the schedule\'s jobs', async () => {
    const row = await create();
    await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: row.feature, profiles: [], maxCostUsd: new Prisma.Decimal(5),
        selectorLabels: [], requestedById: world.ids.dev, scheduleId: row.id, state: 'FAILED', costSpentUsd: new Prisma.Decimal('1.5'), costCarriedUsd: new Prisma.Decimal('0.25'),
      },
    });
    expect(data<Row[]>(await request(server).get(BASE).set(tok('dev')).expect(200))[0].totalCostUsd).toBe('1.7500');
  });

  it('another project cannot see or touch the schedule (404)', async () => {
    const row = await create();
    await request(server).get(`/api/projects/ops/fleet/schedules/${row.id}`).set(tok('root')).expect(404);
    await request(server).post(`/api/projects/ops/fleet/schedules/${row.id}/disable`).set(tok('root')).expect(404);
  });

  it('schedule rows are readable through fleet/activity by entity type', async () => {
    const row = await create();
    const page = data<{ records: Array<{ entityId: string; action: string }> }>(
      await request(server).get('/api/fleet/activity?entityType=schedule').set(tok('root')).expect(200),
    );
    expect(page.records).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: row.id, action: 'schedule.created' })]));
  });
});
