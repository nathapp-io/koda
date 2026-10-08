/**
 * Fleet S1b slice 2a — budget management over HTTP: both prefixes, B3 permissions, resume (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Row { id: string; scopeType: string; scopeId: string | null; paused: boolean; spentUsd: string; warnPercent: number | null; amountUsd: string; windowStart: string; hardStop: boolean; runningJobs: string; warnReached: boolean }

describeIntegration('fleet budgets API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let padmin: string;
  let padminId: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const ADMIN = '/api/fleet/budgets';
  const PROJECT = '/api/projects/web/fleet/budgets';
  const month = { windowKind: 'calendar_month_utc' };

  const spend = (usd: number) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `api${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', costSpentUsd: usd, firstStartedAt: new Date(),
    },
  });
  const waitPaused = async (id: string): Promise<boolean> => {
    for (let i = 0; i < 40; i += 1) {
      if ((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id } })).pausedAt) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // A project ADMIN of web who is not a global admin (fourth login: within the 5/min throttle).
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'padmin@koda.test', name: 'padmin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'padmin@koda.test', role: 'ADMIN' }).expect(201);
    padmin = await loginToken(server, 'padmin@koda.test');
    padminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'padmin@koda.test' } })).id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('admin creates a global policy with the defaults; a duplicate is 409; null warnPercent means no warn', async () => {
    const row = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201));
    expect(row).toEqual(expect.objectContaining({ scopeType: 'global', scopeId: null, warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, spentUsd: '0', amountUsd: '50' }));
    expect(new Date(row.windowStart).getUTCDate()).toBe(1);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 60 }).expect(409);
    const lifetime = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', windowKind: 'lifetime', amountUsd: 500, warnPercent: null }).expect(201));
    expect(lifetime.warnPercent).toBeNull();
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { entityType: 'budget', entityId: row.id, action: 'budget.created' } });
    expect(activity).toEqual(expect.objectContaining({ actorType: 'USER', actorId: world.ids.root, projectId: null }));
  });

  it('validates scopes per route: runner must exist, project scopes are not on the admin route', async () => {
    const runner = await insertRunner(prisma);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'runner', scopeId: runner.id, ...month, amountUsd: 5 }).expect(201);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'runner', scopeId: 'nope', ...month, amountUsd: 5 }).expect(404);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'project', ...month, amountUsd: 5 }).expect(400);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', scopeId: 'x', windowKind: 'lifetime', amountUsd: 5 }).expect(400);
    await request(server).post(ADMIN).set(tok('dev')).send({ scopeType: 'global', ...month, amountUsd: 5 }).expect(403);
  });

  it('project ADMIN and global ADMIN manage project and repo policies; developers and viewers cannot (B3)', async () => {
    const project = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201));
    expect(project).toEqual(expect.objectContaining({ scopeType: 'project', scopeId: world.projectId }));
    await request(server).post(PROJECT).set(tok('root')).send({ scopeType: 'repo', scopeId: world.repoId, ...month, amountUsd: 5 }).expect(201);
    await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'repo', scopeId: world.foreignRepoId, windowKind: 'lifetime', amountUsd: 5 }).expect(404);
    await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'global', windowKind: 'lifetime', amountUsd: 5 }).expect(400);
    await request(server).post(PROJECT).set(tok('dev')).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 5 }).expect(403);
    await request(server).post(PROJECT).set(tok('viewer')).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 5 }).expect(403);
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { entityId: project.id, action: 'budget.created' } });
    expect(activity.projectId).toBe(world.projectId);
  });

  it('members list their project\'s policies plus the global ones; admins list everything', async () => {
    const runner = await insertRunner(prisma);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'runner', scopeId: runner.id, ...month, amountUsd: 5 }).expect(201);
    await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201);
    await request(server).post('/api/projects/ops/fleet/budgets').set(tok('root')).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201);
    await spend(3);
    const member = data<Row[]>(await request(server).get(PROJECT).set(tok('viewer')).expect(200));
    expect(member.map((r) => r.scopeType).sort()).toEqual(['global', 'project']);
    expect(member.find((r) => r.scopeType === 'project')?.spentUsd).toBe('3');
    await request(server).get(PROJECT).set(tok('outsider')).expect(403);
    expect(data<Row[]>(await request(server).get(ADMIN).set(tok('root')).expect(200))).toHaveLength(4);
    await request(server).get(ADMIN).set(tok('dev')).expect(403);
  });

  it('acts only on policies the route owns (D162) and keeps omitted fields on update', async () => {
    const global = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201));
    const project = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20, warnPercent: 70 }).expect(201));
    await request(server).patch(`${ADMIN}/${project.id}`).set(tok('root')).send({ amountUsd: 30 }).expect(404);
    await request(server).patch(`${PROJECT}/${global.id}`).set(as(padmin)).send({ amountUsd: 30 }).expect(404);
    await request(server).delete(`${PROJECT}/${global.id}`).set(tok('root')).expect(404);
    const updated = data<Row>(await request(server).patch(`${PROJECT}/${project.id}`).set(as(padmin)).send({ hardStop: false }).expect(200));
    expect(updated).toEqual(expect.objectContaining({ hardStop: false, warnPercent: 70, amountUsd: '20' }));
    const noWarn = data<Row>(await request(server).patch(`${PROJECT}/${project.id}`).set(as(padmin)).send({ warnPercent: null }).expect(200));
    expect(noWarn.warnPercent).toBeNull();
    await request(server).patch(`${PROJECT}/${project.id}`).set(tok('dev')).send({ amountUsd: 1 }).expect(403);
    const updatedRows = await prisma.fleetActivity.findMany({ where: { entityId: project.id, action: 'budget.updated' } });
    expect(updatedRows).toHaveLength(2);
    expect(updatedRows[0]).toEqual(expect.objectContaining({ actorId: padminId, projectId: world.projectId }));
  });

  it('shows members the activity of their project\'s budgets only; admins see global ones too', async () => {
    await prisma.fleetActivity.deleteMany();
    const global = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201));
    const project = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201));
    const ids = async (who: string) =>
      data<{ records: Array<{ entityId: string }> }>(await request(server).get('/api/fleet/activity').query({ entityType: 'budget' }).set(as(who)).expect(200))
        .records.map((r) => r.entityId);
    expect(await ids(world.tokens.dev)).toEqual([project.id]);
    expect((await ids(world.tokens.root)).sort()).toEqual([global.id, project.id].sort());
  });

  it('a lowered amount pauses within a second; resume needs an amount above spend, then stops again later (review focus 4)', async () => {
    await spend(5);
    const policy = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201));
    await request(server).patch(`${PROJECT}/${policy.id}`).set(as(padmin)).send({ amountUsd: 4 }).expect(200);
    expect(await waitPaused(policy.id)).toBe(true);
    const listed = data<Row[]>(await request(server).get(PROJECT).set(tok('dev')).expect(200)).find((r) => r.id === policy.id);
    expect(listed?.paused).toBe(true);
    const refused = await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({}).expect(400);
    expect(refused.body.message).toContain('5');
    await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({ amountUsd: 5 }).expect(400);
    const resumed = data<Row>(await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({ amountUsd: 8 }).expect(200));
    expect(resumed).toEqual(expect.objectContaining({ paused: false, amountUsd: '8' }));
    const incident = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } });
    expect(incident.actorId).toBe(padminId);
    expect(await prisma.fleetActivity.count({ where: { entityId: policy.id, action: 'budget.resumed' } })).toBe(1);
    await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({}).expect(409);
    await spend(4);
    expect((await app.get(BudgetEvaluator).evaluate(policy.id)).stopped).toBe(true);
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(2);
  });

  it('deleting a paused policy lifts the pause', async () => {
    const policy = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 1 }).expect(201));
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: new Date(), pausedWindowStart: new Date(0) } });
    await request(server).post('/api/projects/web/fleet/jobs').set(tok('dev')).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature: 'blocked' }).expect(409);
    await request(server).delete(`${PROJECT}/${policy.id}`).set(as(padmin)).expect(204);
    await request(server).post('/api/projects/web/fleet/jobs').set(tok('dev')).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature: 'unblocked' }).expect(201);
    expect(await prisma.fleetActivity.count({ where: { entityId: policy.id, action: 'budget.deleted' } })).toBe(1);
  });
});
