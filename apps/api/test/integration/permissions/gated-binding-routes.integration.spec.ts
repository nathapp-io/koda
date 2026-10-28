import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface PendingSummary { id: string; permissionKey: string; projectId: string | null; }
interface DecidedRequest { status: string; result: unknown; }

describeIntegration('gated role-binding routes (US-005)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let projectId: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let devId: string;
  const server = () => app.getHttpServer();
  const agentAuth = () => ({ Authorization: `Bearer ${agent.apiKey}` });
  const rootAuth = () => ({ Authorization: `Bearer ${world.tokens.root}` });
  const postBinding = (body: object, auth = agentAuth()) => request(server()).post('/api/role-bindings').set(auth).send(body);
  const deleteBinding = (id: string, auth = agentAuth()) => request(server()).delete(`/api/role-bindings/${id}`).set(auth);
  const pending = (res: request.Response): PendingSummary => {
    expect(res.status).toBe(202);
    return data<PendingSummary>(res);
  };
  const approve = async (id: string): Promise<DecidedRequest> => {
    const res = await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200);
    return data<DecidedRequest>(res);
  };
  const roleId = async (key: string) => (await db.role.findUniqueOrThrow({ where: { key } })).id;
  const seedBinding = async (principalId: string, roleKey: string, scope: string | null) => db.roleBinding.create({
    data: { principalType: 'USER', principalId, roleId: await roleId(roleKey), projectId: scope, grantedByType: 'SYSTEM', grantedById: 'test' },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    const project = await db.project.create({ data: { name: 'Approval P', slug: 'approval-p', key: 'AP' } });
    projectId = project.id;
    const dev = await db.user.create({ data: { email: 'binding-dev@example.test', name: 'Binding Dev', passwordHash: 'not-a-real-hash' } });
    devId = dev.id;
    await grantRole(db, { type: 'USER', id: devId }, 'member');
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'agent', projectId);
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'viewer', projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['role.binding.manage'], projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['role.binding.global'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalId: devId, role: { key: 'viewer' } } });
    await app.get(PermissionCache).invalidate();
  });

  it('AC-1: project binding create returns a pending request for role.binding.manage', async () => {
    const summary = pending(await postBinding({ principalType: 'USER', principalId: devId, roleKey: 'viewer', projectId }));
    expect(summary).toMatchObject({ permissionKey: 'role.binding.manage', projectId });
    expect(await db.roleBinding.count({ where: { principalId: devId, projectId, role: { key: 'viewer' } } })).toBe(0);
  });
  it('AC-2: approved project binding create writes the target binding', async () => {
    const { id } = pending(await postBinding({ principalType: 'USER', principalId: devId, roleKey: 'viewer', projectId }));
    expect((await approve(id)).status).toBe('executed');
    expect(await db.roleBinding.count({ where: { principalId: devId, projectId, role: { key: 'viewer' } } })).toBe(1);
  });
  it('AC-3: global binding request selects the global key and null project', async () => {
    const summary = pending(await postBinding({ principalType: 'USER', principalId: devId, roleKey: 'admin' }));
    expect(summary).toMatchObject({ permissionKey: 'role.binding.global', projectId: null });
  });
  it('AC-4: an agent cannot request an owner binding', async () => {
    const res = await postBinding({ principalType: 'USER', principalId: devId, roleKey: 'owner' });
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-5: deleting a project binding selects the stored project key', async () => {
    const binding = await seedBinding(devId, 'viewer', projectId);
    const summary = pending(await deleteBinding(binding.id));
    expect(summary.permissionKey).toBe('role.binding.manage');
  });
  it('AC-6: approving a pending binding delete removes the binding', async () => {
    const binding = await seedBinding(devId, 'viewer', projectId);
    const { id } = pending(await deleteBinding(binding.id));
    expect((await approve(id)).status).toBe('executed');
    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toBeNull();
  });
  it('AC-7: a missing delete target is 404 and creates no approval request', async () => {
    const res = await deleteBinding('missing-binding-id');
    expect(res.status).toBe(404);
    expect(res.body.message).toContain('binding');
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-8: approved self-binding settles failed and writes nothing', async () => {
    const before = await db.roleBinding.count({ where: { principalId: agent.id, projectId, role: { key: 'viewer' } } });
    const body = { principalType: 'AGENT', principalId: agent.id, roleKey: 'viewer', projectId };
    const summary = pending(await postBinding(body));
    const result = await approve(summary.id);
    expect(result.status).toBe('failed');
    expect(result.result).toMatchObject({ name: 'ForbiddenAppException' });
    expect(await db.roleBinding.count({ where: { principalId: agent.id, projectId, role: { key: 'viewer' } } })).toBe(before);
  });
  it('AC-9: root binding creation remains an immediate 201', async () => {
    const res = await postBinding({ principalType: 'USER', principalId: devId, roleKey: 'viewer', projectId: null }, rootAuth());
    expect(res.status).toBe(201);
    expect(data<{ roleKey: string }>(res).roleKey).toBe('viewer');
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-14: an unknown role fails during approved command execution', async () => {
    const summary = pending(await postBinding({ principalType: 'USER', principalId: devId, roleKey: 'unknown-role' }));
    const result = await approve(summary.id);
    expect(result.status).toBe('failed');
    expect(result.result).toMatchObject({ error: 'execution-failed', name: 'NotFoundAppException' });
  });
  it('AC-15: self-binding failure is recorded as execution-failed', async () => {
    const summary = pending(await postBinding({ principalType: 'AGENT', principalId: agent.id, roleKey: 'viewer', projectId }));
    const result = await approve(summary.id);
    expect(result.status).toBe('failed');
    expect(result.result).toMatchObject({ error: 'execution-failed', name: 'ForbiddenAppException' });
  });
});
