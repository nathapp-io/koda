import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { ConflictAppException } from '../../../src/common/exceptions/conflict-app.exception';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const keys = ['fleet.budget.create', 'fleet.budget.update', 'fleet.budget.delete', 'fleet.budget.resume'];
interface Pending { id: string; permissionKey: string; requiredMode: string; projectId: string | null }
interface Decided { status: string; result: unknown }

describeIntegration('gated budget routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let stranger: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = (project: boolean) => project ? '/api/projects/web/fleet/budgets' : '/api/fleet/budgets';
  const body = (project: boolean) => ({ scopeType: project ? 'project' : 'global', windowKind: 'lifetime', amountUsd: 10 });
  const pending = (res: request.Response) => {
    expect(res.status).toBe(202);
    return data<Pending>(res);
  };
  const approve = async (id: string) => data<Decided>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const create = async (project: boolean) => data<{ id: string }>(await request(server()).post(base(project)).set(auth(world.tokens.root)).send(body(project)).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    stranger = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, keys, null);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [...keys, 'project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.budgetPolicy.deleteMany();
  });

  for (const project of [false, true]) {
    const prefix = project ? 'project' : 'global';
    it(`${prefix} create (AC-1/AC-5): waits without writing, approval creates once and stores DTO`, async () => {
      const summary = pending(await request(server()).post(base(project)).set(auth(agent.apiKey)).send(body(project)));
      expect(summary).toMatchObject({ permissionKey: 'fleet.budget.create', requiredMode: 'agent', projectId: project ? world.projectId : null });
      expect(await db.budgetPolicy.count()).toBe(0);
      expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { scopeType: prefix } });
      expect(await db.budgetPolicy.count()).toBe(1);
      const policy = await db.budgetPolicy.findFirstOrThrow();
      expect(policy).toMatchObject({ scopeType: prefix, projectId: project ? world.projectId : null });
      expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).toMatchObject({ result: { id: policy.id, scopeType: prefix } });
    });
    it(`${prefix} update (AC-2/AC-6): waits and approval changes amount`, async () => {
      const policy = await create(project);
      const summary = pending(await request(server()).patch(`${base(project)}/${policy.id}`).set(auth(agent.apiKey)).send({ amountUsd: 42 }));
      expect(String((await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).amountUsd)).toBe('10');
      expect((await approve(summary.id)).status).toBe('executed');
      expect(String((await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).amountUsd)).toBe('42');
    });
    it(`${prefix} delete (AC-3/AC-7): waits and approval removes policy`, async () => {
      const policy = await create(project);
      const summary = pending(await request(server()).delete(`${base(project)}/${policy.id}`).set(auth(agent.apiKey)));
      expect(await db.budgetPolicy.findUnique({ where: { id: policy.id } })).not.toBeNull();
      expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
      expect(await db.budgetPolicy.findUnique({ where: { id: policy.id } })).toBeNull();
    });
    it(`${prefix} resume (AC-4/AC-8): waits and approval clears pause`, async () => {
      const policy = await create(project);
      await db.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: new Date(), pausedWindowStart: new Date(0) } });
      const summary = pending(await request(server()).post(`${base(project)}/${policy.id}/resume`).set(auth(agent.apiKey)).send({}));
      expect((await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).not.toBeNull();
      expect((await approve(summary.id)).status).toBe('executed');
      expect((await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).toBeNull();
    });
  }
  it('AC-9: a resume made stale by root settles failed with the service error name', async () => {
    const policy = await create(false);
    await db.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: new Date(), pausedWindowStart: new Date(0) } });
    const summary = pending(await request(server()).post(`${base(false)}/${policy.id}/resume`).set(auth(agent.apiKey)).send({}));
    await request(server()).post(`${base(false)}/${policy.id}/resume`).set(auth(world.tokens.root)).send({}).expect(200);
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new ConflictAppException({}, 'fleet.budgetNotPaused').name } });
  });
  it('AC-10: root creates immediately with 201 and no request', async () => {
    const policy = await create(false);
    expect(await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).toMatchObject({ scopeType: 'global' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-11: a keyless agent cannot delete or open a request', async () => {
    const policy = await create(false);
    const res = await request(server()).delete(`${base(false)}/${policy.id}`).set(auth(stranger.apiKey)).expect(403);
    expect(res.body.ret).toBe(40003);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.budgetPolicy.findUnique({ where: { id: policy.id } })).not.toBeNull();
  });
});
