import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Gated global approval-policy routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const post = (payload: object, token = agent.apiKey) => request(server()).post('/api/approval-policies').set('Authorization', `Bearer ${token}`).send(payload);
  const patch = (id: string, payload: object, token = agent.apiKey) => request(server()).patch(`/api/approval-policies/${id}`).set('Authorization', `Bearer ${token}`).send(payload);
  const remove = (id: string, token = agent.apiKey) => request(server()).delete(`/api/approval-policies/${id}`).set('Authorization', `Bearer ${token}`);
  const approve = async (id: string) => request(server()).post(`/api/approvals/${id}/decisions`).set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' }).expect(200);
  const decide = async (res: { body: { data: { id: string } } }) => approve(res.body.data.id);
  const makePolicy = (extra: object = {}) => ({ permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'USER' }, mode: 'agent', ...extra });
  const message = (key: string, status: string) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return catalog[key]?.[status];
  };

  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['approval.policy.manage'], null);
  });

  it('AC-1, AC-2, AC-3: creates only after approval and attributes the write to the agent', async () => {
    const opened = await post(makePolicy()).expect(202);
    expect(opened.body.data).toMatchObject({ permissionKey: 'approval.policy.manage', requiredMode: 'human', status: 'pending' });
    expect(await db.approvalPolicy.count()).toBe(0);
    const requestId = opened.body.data.id as string;
    await decide(opened);
    const policies = await db.approvalPolicy.findMany({ where: { permissionPattern: 'label.delete' } });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ projectId: null, mode: 'agent', updatedByType: 'AGENT', updatedById: agent.id });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('executed');
  });

  it('AC-4, AC-5: gates non-empty updates but refuses an empty patch before opening a request', async () => {
    const policy = await withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({ ...makePolicy(), projectId: null, appliesTo: { kind: 'type', principalType: 'USER' } }));
    const empty = await patch(policy.id, {}).expect(400);
    expect(empty.body.message).toBe(message('emptyPolicyPatch', '400'));
    expect(await db.approvalRequest.count()).toBe(0);
    const opened = await patch(policy.id, { mode: 'human' }).expect(202);
    await decide(opened);
    expect((await db.approvalPolicy.findUniqueOrThrow({ where: { id: policy.id } })).mode).toBe('human');
  });

  it('AC-6: gates deletion until an approver approves it', async () => {
    const policy = await withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({ ...makePolicy(), projectId: null, appliesTo: { kind: 'type', principalType: 'USER' } }));
    const opened = await remove(policy.id).expect(202);
    expect(await db.approvalPolicy.findUnique({ where: { id: policy.id } })).not.toBeNull();
    await decide(opened);
    expect(await db.approvalPolicy.findUnique({ where: { id: policy.id } })).toBeNull();
  });

  it('AC-7: approved self-applying policy settles failed with the domain error name', async () => {
    const opened = await post(makePolicy({ appliesTo: { kind: 'all' } })).expect(202);
    const decided = await approve(opened.body.data.id as string);
    expect(decided.body.data.status).toBe('failed');
    expect(decided.body.data.result).toMatchObject({ name: 'ApprovalPolicySelfApplicationError' });
  });

  it('AC-8: human root creation remains immediate', async () => {
    const created = await post(makePolicy(), world.tokens.root).expect(201);
    expect(created.body.data).toMatchObject({ permissionPattern: 'label.delete', projectId: null, mode: 'agent' });
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-13: missing deletion returns 404 and does not open a request', async () => {
    const missing = await remove(randomUUID()).expect(404);
    expect(missing.body.message).toBe(message('policyNotFound', '404'));
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-15: global update of a project policy returns 404 before gating', async () => {
    const projectPolicy = await withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({
      permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'USER' }, mode: 'agent', projectId: world.projectId,
    }));
    const result = await patch(projectPolicy.id, { mode: 'human' }).expect(404);
    expect(result.body.message).toBe(message('policyNotFound', '404'));
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
