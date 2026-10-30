import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; redeem: boolean }
interface InviteResult { invitePath: string; outcome?: string; emailed?: boolean; invite: { id: string } }
interface Settled { status: string; result: unknown }

describeIntegration('gated invite create and resend secret routes (US-005)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const email = () => `${randomUUID()}@koda.test`;
  const createAsAgent = (address: string, headers: Record<string, string> = {}) => request(server()).post('/api/projects/web/invites')
    .auth(agent.apiKey, { type: 'bearer' }).set(headers).send({ email: address, roleKey: 'viewer' });
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`)
    .auth(world.tokens.root, { type: 'bearer' }).send({ decision: 'approve' }).expect(200));
  const decidePending = async (response: request.Response) => {
    const pending = data<Pending>(response);
    expect(pending).toMatchObject({ permissionKey: expect.any(String), redeem: true });
    await approve(pending.id);
    return pending;
  };
  const rootCreate = async (address = email()) => data<InviteResult>(await request(server()).post('/api/projects/web/invites')
    .auth(world.tokens.root, { type: 'bearer' }).send({ email: address, roleKey: 'viewer' }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'viewer', world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'invite.create', 'invite.resend'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1: create waits under policy without writing an invite', async () => {
    const address = email();
    await seedWaitPolicy(db, 'invite.create', world.projectId);
    const pending = data<Pending>(await createAsAgent(address).expect(202));
    expect(pending).toMatchObject({ permissionKey: 'invite.create', redeem: true });
    expect(await db.projectInvite.count({ where: { email: address } })).toBe(0);
  });

  it('AC-2/3/4: redemption exposes its link once, stores redacted result/input, and ignores locale', async () => {
    const address = email();
    await seedWaitPolicy(db, 'invite.create', world.projectId);
    const pending = await decidePending(await createAsAgent(address).expect(202));
    const redeemed = data<InviteResult>(await createAsAgent(address, { 'X-Koda-Approval-Request': pending.id, 'Accept-Language': 'zh-CN' }).expect(201));
    expect(redeemed.outcome).toBe('INVITED');
    expect(redeemed.invitePath).toMatch(/^\/invite\//);
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.input).toMatchObject({ invite: { email: address } });
    expect(row.input).not.toHaveProperty('locale');
    expect(row.result).toMatchObject({ outcome: 'INVITED' });
    expect(row.result).not.toHaveProperty('invitePath');
  });

  it('AC-5: a mismatched create redemption conflicts and writes nothing', async () => {
    const emailA = email();
    const emailB = email();
    await seedWaitPolicy(db, 'invite.create', world.projectId);
    const pending = await decidePending(await createAsAgent(emailA).expect(202));
    const response = await createAsAgent(emailB, { 'X-Koda-Approval-Request': pending.id }).expect(409);
    expect(response.body.ret).toBe(409);
    expect(await db.projectInvite.count({ where: { email: { in: [emailA, emailB] } } })).toBe(0);
  });

  it('AC-6: resend waits, then returns a new raw link without storing it', async () => {
    const created = await rootCreate();
    await seedWaitPolicy(db, 'invite.resend', world.projectId);
    const path = `/api/projects/web/invites/${created.invite.id}/resend`;
    const pending = data<Pending>(await request(server()).post(path).auth(agent.apiKey, { type: 'bearer' }).expect(202));
    await approve(pending.id);
    const response = data<InviteResult>(await request(server()).post(path).auth(agent.apiKey, { type: 'bearer' })
      .set('X-Koda-Approval-Request', pending.id).expect(200));
    expect(response.invitePath).toMatch(/^\/invite\//);
    expect(response.invitePath).not.toBe(created.invitePath);
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.result).not.toHaveProperty('invitePath');
  });

  it('AC-7: approved resend after cancellation fails the request', async () => {
    const created = await rootCreate();
    await seedWaitPolicy(db, 'invite.resend', world.projectId);
    const path = `/api/projects/web/invites/${created.invite.id}/resend`;
    const pending = data<Pending>(await request(server()).post(path).auth(agent.apiKey, { type: 'bearer' }).expect(202));
    await approve(pending.id);
    await request(server()).delete(`/api/projects/web/invites/${created.invite.id}`).auth(world.tokens.root, { type: 'bearer' }).expect(200);
    const failed = await request(server()).post(path).auth(agent.apiKey, { type: 'bearer' }).set('X-Koda-Approval-Request', pending.id).expect(409);
    expect(failed.body.ret).toBe(409);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('failed');
  });

  it('AC-8/12: default-none create and resend execute immediately without approval rows', async () => {
    const created = data<InviteResult>(await createAsAgent(email()).expect(201));
    expect(created.invitePath).toMatch(/^\/invite\//);
    const rootCreated = await rootCreate();
    const result = data<InviteResult>(await request(server()).post(`/api/projects/web/invites/${rootCreated.invite.id}/resend`)
      .auth(agent.apiKey, { type: 'bearer' }).expect(200));
    expect(result.invitePath).toMatch(/^\/invite\//);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
