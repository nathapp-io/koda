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

(canRunDbTests() ? describe : describe.skip)('Gated project approval-policy routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const path = '/api/projects/web/approval-policies';
  const post = (payload: object, token = agent.apiKey) => request(server()).post(path).set('Authorization', `Bearer ${token}`).send(payload);
  const patch = (id: string, payload: object, token = agent.apiKey) => request(server()).patch(`${path}/${id}`).set('Authorization', `Bearer ${token}`).send(payload);
  const remove = (id: string, token = agent.apiKey) => request(server()).delete(`${path}/${id}`).set('Authorization', `Bearer ${token}`);
  const approve = (id: string) => request(server()).post(`/api/approvals/${id}/decisions`).set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' });
  const makePolicy = (extra: object = {}) => ({ permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'USER' }, mode: 'agent', ...extra });
  const message = (key: string) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return catalog[key]?.['404'] ?? catalog[key]?.['400'];
  };
  const createDirect = (projectId: string) => withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({ ...makePolicy(), projectId }));

  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'approval.policy.manage'], world.projectId);
  });

  it('AC-1/AC-2: creates a project policy only after approval', async () => {
    const pending = await post(makePolicy()).expect(202);
    expect(pending.body.data.projectId).toBe(world.projectId);
    expect(await db.approvalPolicy.count()).toBe(0);
    await approve(pending.body.data.id).expect(200);
    expect(await db.approvalPolicy.count({ where: { projectId: world.projectId } })).toBe(1);
  });

  it('AC-3: updates a project policy only after approval', async () => {
    const policy = await createDirect(world.projectId);
    const pending = await patch(policy.id, { mode: 'human' }).expect(202);
    await approve(pending.body.data.id).expect(200);
    expect((await db.approvalPolicy.findUniqueOrThrow({ where: { id: policy.id } })).mode).toBe('human');
  });

  it('AC-4: deletes a project policy only after approval', async () => {
    const policy = await createDirect(world.projectId);
    const pending = await remove(policy.id).expect(202);
    expect(await db.approvalPolicy.findUnique({ where: { id: policy.id } })).not.toBeNull();
    await approve(pending.body.data.id).expect(200);
    expect(await db.approvalPolicy.findUnique({ where: { id: policy.id } })).toBeNull();
  });

  it('AC-5: refuses a policy from another project before opening a request', async () => {
    const policy = await createDirect(world.opsProjectId);
    const result = await patch(policy.id, { mode: 'human' }).expect(404);
    expect(result.body.message).toBe(message('policyNotFound'));
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-6: refuses empty patches before opening a request', async () => {
    const policy = await createDirect(world.projectId);
    const result = await patch(policy.id, {}).expect(400);
    expect(result.body.message).toBe(message('emptyPolicyPatch'));
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-7: root project policy creation remains immediate', async () => {
    await post(makePolicy(), world.tokens.root).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-11: failed execution if the policy changes project after request creation', async () => {
    const policy = await createDirect(world.projectId);
    const pending = await patch(policy.id, { mode: 'human' }).expect(202);
    await db.approvalPolicy.update({ where: { id: policy.id }, data: { projectId: world.opsProjectId } });
    const decided = await approve(pending.body.data.id).expect(200);
    expect(decided.body.data.status).toBe('failed');
    expect(decided.body.data.result).toMatchObject({ name: 'ApprovalPolicyNotFoundError' });
  });

  it('rejects a missing policy before opening a request', async () => {
    await remove(randomUUID()).expect(404);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
