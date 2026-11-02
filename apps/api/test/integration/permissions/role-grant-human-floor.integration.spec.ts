import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('role-granting permission human floor (US-002)', () => {
  let app: NathApplication;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const email = () => `${randomUUID()}@koda.test`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    const db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'project-admin', world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    resetThrottle(app);
    const db = fixtureDb(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('no-policy agent member, invite-create, and invite-resend actions wait without mutating targets', async () => {
    const db = fixtureDb(app);
    const address = email();
    const target = data<{ id: string }>(await request(server()).post('/api/admin/users')
      .auth(world.tokens.root, { type: 'bearer' })
      .send({ email: address, name: 'Approval target', password: TEST_PASSWORD }).expect(201));

    const memberPending = data<{ permissionKey: string }>(await request(server()).post('/api/projects/web/members')
      .auth(agent.apiKey, { type: 'bearer' }).send({ email: address, roleKey: 'project-admin' }).expect(202));
    expect(memberPending.permissionKey).toBe('member.add');
    expect(await db.roleBinding.findMany({ where: { principalType: 'USER', principalId: target.id, projectId: world.projectId } })).toEqual([]);

    const inviteAddress = email();
    const invitePending = data<{ permissionKey: string }>(await request(server()).post('/api/projects/web/invites')
      .auth(agent.apiKey, { type: 'bearer' }).send({ email: inviteAddress, roleKey: 'project-admin' }).expect(202));
    expect(invitePending.permissionKey).toBe('invite.create');
    expect(await db.projectInvite.count({ where: { email: inviteAddress } })).toBe(0);

    const rootInvite = data<{ invite: { id: string } }>(await request(server()).post('/api/projects/web/invites')
      .auth(world.tokens.root, { type: 'bearer' }).send({ email: email(), roleKey: 'viewer' }).expect(201));
    const before = await db.projectInvite.findUniqueOrThrow({ where: { id: rootInvite.invite.id }, select: { tokenHash: true, expiresAt: true, updatedAt: true } });
    const resendPending = data<{ permissionKey: string }>(await request(server()).post(`/api/projects/web/invites/${rootInvite.invite.id}/resend`)
      .auth(agent.apiKey, { type: 'bearer' }).expect(202));
    expect(resendPending.permissionKey).toBe('invite.resend');
    expect(await db.projectInvite.findUniqueOrThrow({ where: { id: rootInvite.invite.id }, select: { tokenHash: true, expiresAt: true, updatedAt: true } })).toEqual(before);
    expect(await db.approvalRequest.count()).toBe(3);
  });
});
