import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../src/common/exceptions/conflict-app.exception';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string }
interface Settled { status: string; result: unknown }

describeIntegration('gated member addition and invite cancellation', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let member: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let inviter: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const email = () => `${randomUUID()}@koda.test`;
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`)
    .auth(world.tokens.root, { type: 'bearer' }).send({ decision: 'approve' }).expect(200));
  const cancel = (id: string, token = inviter.apiKey) => request(server()).delete(`/api/projects/web/invites/${id}`).auth(token, { type: 'bearer' });
  const invite = async (slug = 'web') => data<{ invite: { id: string }; invitePath: string }>(await request(server()).post(`/api/projects/${slug}/invites`)
    .auth(world.tokens.root, { type: 'bearer' }).send({ email: email(), roleKey: 'viewer' }).expect(201));
  const waitingCancel = async (id: string) => {
    await seedWaitPolicy(db, 'invite.cancel', world.projectId);
    const pending = data<Pending>(await cancel(id).expect(202));
    expect(pending.permissionKey).toBe('invite.cancel');
    return pending;
  };
  const waitingMember = async (roleKey?: string) => {
    const address = email();
    await request(server()).post('/api/admin/users').auth(world.tokens.root, { type: 'bearer' })
      .send({ email: address, name: 'New member', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    const user = await db.user.findUniqueOrThrow({ where: { email: address } });
    await seedWaitPolicy(db, 'member.add', world.projectId);
    const pending = data<Pending>(await request(server()).post('/api/projects/web/members').auth(member.apiKey, { type: 'bearer' })
      .send({ email: address, ...(roleKey ? { roleKey } : {}) }).expect(202));
    expect(pending.permissionKey).toBe('member.add');
    expect(await db.roleBinding.count({ where: { principalType: 'USER', principalId: user.id, projectId: world.projectId } })).toBe(0);
    return { pending, user };
  };
  const status = async (id: string) => (await db.projectInvite.findUniqueOrThrow({ where: { id } })).status;
  const failed = (name: string) => ({ status: 'failed', result: { error: 'execution-failed', name } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    member = await seedFleetHttpAgent(server(), world.tokens.root);
    inviter = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantRole(db, { type: 'AGENT', id: member.id }, 'viewer', world.projectId);
    await grantKeys(db, { type: 'AGENT', id: member.id }, ['member.add', 'project.read'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: inviter.id }, ['invite.cancel', 'project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  it('AC-1: member addition waits under the route-key policy', async () => { await waitingMember(); });
  it('AC-2: approval grants the default viewer role', async () => {
    const { pending, user } = await waitingMember();
    expect((await approve(pending.id)).status).toBe('executed');
    const binding = await db.roleBinding.findFirstOrThrow({ where: { principalType: 'USER', principalId: user.id, projectId: world.projectId }, include: { role: true } });
    expect(binding.role.key).toBe('viewer');
  });
  it('AC-3: approval cannot escalate to developer', async () => {
    const { pending, user } = await waitingMember('developer');
    expect(await approve(pending.id)).toMatchObject(failed(new ForbiddenAppException({}, 'permissions').name));
    expect(await db.roleBinding.count({ where: { principalType: 'USER', principalId: user.id, projectId: world.projectId } })).toBe(0);
  });
  it('AC-4: cancellation waits and does not mutate the invite', async () => {
    const { invite: target } = await invite();
    await waitingCancel(target.id);
    expect(await status(target.id)).toBe('PENDING');
  });
  it('AC-5: approval cancels and stores null', async () => {
    const { invite: target } = await invite();
    const pending = await waitingCancel(target.id);
    expect(await approve(pending.id)).toMatchObject({ status: 'executed', result: null });
    expect(await status(target.id)).toBe('CANCELLED');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).result).toBeNull();
  });
  it('AC-6: an already cancelled invite fails on approval', async () => {
    const { invite: target } = await invite();
    const pending = await waitingCancel(target.id);
    await cancel(target.id, world.tokens.root).expect(200);
    expect(await approve(pending.id)).toMatchObject(failed(new ConflictAppException({}, 'invites.final').name));
    expect(await status(target.id)).toBe('CANCELLED');
  });
  it('AC-7: a foreign project invite cannot be cancelled', async () => {
    const { invite: target } = await invite('ops');
    const pending = await waitingCancel(target.id);
    expect(await approve(pending.id)).toMatchObject(failed(new NotFoundAppException({}, 'invites').name));
    expect(await status(target.id)).toBe('PENDING');
  });
  it('AC-8: root cancellation keeps the empty envelope and creates no request', async () => {
    const { invite: target } = await invite();
    await seedWaitPolicy(db, 'invite.cancel', world.projectId);
    expect(data(await cancel(target.id, world.tokens.root).expect(200))).toEqual({});
    expect(await status(target.id)).toBe('CANCELLED');
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-12: acceptance while waiting makes cancellation fail', async () => {
    const target = await invite();
    const pending = await waitingCancel(target.invite.id);
    await request(server()).post(`/api/invites/${target.invitePath.split('/').pop()}/accept`)
      .send({ name: 'Accepted', password: TEST_PASSWORD }).expect(201);
    expect(await approve(pending.id)).toMatchObject(failed(new ConflictAppException({}, 'invites.final').name));
    expect(await status(target.invite.id)).toBe('ACCEPTED');
  });
});
