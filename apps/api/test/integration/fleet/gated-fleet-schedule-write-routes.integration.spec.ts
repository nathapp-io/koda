import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Decision { status: string }

describeIntegration('gated fleet schedule write routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let keyed: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let ownOnly: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let reader: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const path = '/api/projects/web/fleet/schedules';
  const name = 'nightly';
  const make = async (token = world.tokens.dev, scheduleName = name) => data<{ id: string }>(await request(server()).post(path).set(auth(token)).send({
    name: scheduleName, repoId: world.repoId, feature: 'gated', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 5,
  }).expect(201));
  const pending = async (res: request.Response, key: string): Promise<Pending> => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: key, projectId: world.projectId });
    return result;
  };
  const approve = async (id: string) => data<Decision>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    keyed = await seedFleetHttpAgent(server(), world.tokens.root);
    ownOnly = await seedFleetHttpAgent(server(), world.tokens.root);
    reader = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: keyed.id }, ['project.read', 'fleet.schedule.create', 'fleet.schedule.update'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: ownOnly.id }, ['project.read', 'fleet.schedule.update.own'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: reader.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.jobSchedule.deleteMany();
  });

  it('AC-1/AC-2: create waits and approval creates exactly one agent-owned schedule', async () => {
    await seedWaitPolicy(db, 'fleet.schedule.create', world.projectId);
    const ask = await pending(await request(server()).post(path).set(auth(keyed.apiKey)).send({
      name, repoId: world.repoId, feature: 'gated', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 5,
    }), 'fleet.schedule.create');
    expect(await db.jobSchedule.count({ where: { name } })).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    const rows = await db.jobSchedule.findMany({ where: { name } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdById).toBe(keyed.id);
  });

  it('AC-3/AC-4: update waits and approved update changes cost', async () => {
    const row = await make(world.tokens.dev, 'update-me');
    await seedWaitPolicy(db, 'fleet.schedule.update', world.projectId);
    const ask = await pending(await request(server()).patch(`${path}/${row.id}`).set(auth(keyed.apiKey)).send({ maxCostUsd: 7 }), 'fleet.schedule.update');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(String((await db.jobSchedule.findUniqueOrThrow({ where: { id: row.id } })).maxCostUsd)).toBe('7');
  });

  it('AC-5/AC-6: disable and enable each wait and execute after approval', async () => {
    const row = await make(world.tokens.dev, 'toggle-me');
    await seedWaitPolicy(db, 'fleet.schedule.update', world.projectId);
    const disable = await pending(await request(server()).post(`${path}/${row.id}/disable`).set(auth(keyed.apiKey)), 'fleet.schedule.update');
    expect((await approve(disable.id)).status).toBe('executed');
    expect((await db.jobSchedule.findUniqueOrThrow({ where: { id: row.id } })).enabled).toBe(false);
    const enable = await pending(await request(server()).post(`${path}/${row.id}/enable`).set(auth(keyed.apiKey)), 'fleet.schedule.update');
    expect((await approve(enable.id)).status).toBe('executed');
    expect((await db.jobSchedule.findUniqueOrThrow({ where: { id: row.id } })).enabled).toBe(true);
  });

  it('AC-7: own-only update of another owner fails at execution without changing the row', async () => {
    const row = await make(world.tokens.dev, 'other-owner');
    await seedWaitPolicy(db, 'fleet.schedule.update', world.projectId);
    const ask = await pending(await request(server()).patch(`${path}/${row.id}`).set(auth(ownOnly.apiKey)).send({ maxCostUsd: 7 }), 'fleet.schedule.update');
    expect((await approve(ask.id)).status).toBe('failed');
    expect(String((await db.jobSchedule.findUniqueOrThrow({ where: { id: row.id } })).maxCostUsd)).toBe('5');
  });

  it('AC-8: human create executes immediately without an approval request', async () => {
    await seedWaitPolicy(db, 'fleet.schedule.create', world.projectId);
    const result = await request(server()).post(path).set(auth(world.tokens.dev)).send({
      name: 'human-create', repoId: world.repoId, feature: 'gated', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 5,
    }).expect(201);
    expect(data<{ name: string }>(result).name).toBe('human-create');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-9: missing update permission is forbidden before approval opens', async () => {
    const row = await make(world.tokens.dev, 'forbidden-update');
    await request(server()).patch(`${path}/${row.id}`).set(auth(reader.apiKey)).send({ maxCostUsd: 7 }).expect(403);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
