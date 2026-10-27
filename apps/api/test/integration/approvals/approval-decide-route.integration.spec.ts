import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalRequestQueries } from '../../../src/approvals/approval-request.queries';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval request REST decisions', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let approverToken: string;
  let outsiderToken: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: string;
  let projectRequestId: string;
  let pInput: { labelId: string };
  const labels = configurableTestCommand('label.delete');
  const server = () => app.getHttpServer();
  const post = (id: string, body: object, token = approverToken) => request(server()).post(`/api/approvals/${id}/decisions`).set('Authorization', `Bearer ${token}`).send(body);
  const get = (id: string, token = approverToken) => request(server()).get(`/api/approvals/${id}`).set('Authorization', `Bearer ${token}`);
  const open = async (projectId: string, actorId: string, requiredMode: 'agent' | 'human' = 'agent') => {
    const result = await withTestActor({ type: 'AGENT', id: actorId }, () => app.get(ApprovalGate).gate('label.delete', pInput, { projectId, requiredMode }));
    if (result.status !== 'pending') throw new Error('expected pending request');
    return result.request.id;
  };
  const message = (key: string, status: string, args: Record<string, string> = {}) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return Object.entries(args).reduce((text, [name, value]) => text.replace(`{${name}}`, value), catalog[key][status]);
  };
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get(ApprovalCommandRegistry).register(labels.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app); labels.reset();
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    const createUser = async () => {
      const email = `${randomUUID()}@koda.test`;
      const res = await request(server()).post('/api/admin/users').set('Authorization', `Bearer ${world.tokens.root}`).send({ email, name: 'Approver', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      return { id: data<{ id: string }>(res).id, token: await loginToken(server(), email) };
    };
    const approver = await createUser(); const outsider = await createUser();
    approverToken = approver.token; outsiderToken = outsider.token;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    p = randomUUID(); await db.project.create({ data: { id: p, slug: `decide-${p}`, key: p, name: p } });
    await grantRole(db, { type: 'USER', id: approver.id }, 'approver', p);
    await grantKeys(db, { type: 'USER', id: approver.id }, ['label.delete'], p);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['label.delete'], p);
    await app.get(PermissionCache).invalidate();
    pInput = { labelId: randomUUID() }; projectRequestId = await open(p, agent.id);
  });
  it('AC-1/2: approves, executes once and returns current request decisions without a post-decision visibility check', async () => {
    const getSpy = vi.spyOn(app.get(ApprovalRequestQueries), 'get');
    try {
      const res = await post(projectRequestId, { decision: 'approve' }).expect(200);
      expect(data<{ status: string }>(res).status).toBe('executed'); expect(labels.state.calls).toHaveLength(1);
      expect(data<{ decisions: unknown[] }>(res).decisions).toHaveLength(1);
      expect(getSpy).toHaveBeenCalledTimes(1);
    } finally { getSpy.mockRestore(); }
  });
  it('US-005 AC-1/4: accepts and returns decision params in the decision DTO', async () => {
    labels.state.parseDecision = { calls: [], result: { remember: true }, throws: false };
    const res = await post(projectRequestId, { decision: 'approve', params: { remember: true } }).expect(200);
    expect(data<{ decisions: { params: unknown }[] }>(res).decisions).toMatchObject([{ params: { remember: true } }]);
    expect(await db.approvalDecision.findMany({ where: { requestId: projectRequestId } })).toMatchObject([{ params: { remember: true } }]);
    expect(data<{ decisions: { params: unknown }[] }>(await get(projectRequestId).expect(200)).decisions).toMatchObject([{ params: { remember: true } }]);
  });
  it('US-005 AC-2: returns localized not-accepted when command has no decision parser', async () => {
    const before = await db.approvalDecision.count({ where: { requestId: projectRequestId } });
    const res = await post(projectRequestId, { decision: 'approve', params: { a: 1 } }).expect(400);
    expect(res.body.message).toContain('not-accepted');
    expect(res.body.message).toBe(message('invalidDecisionParams', '400', { reason: 'not-accepted' }));
    expect(await db.approvalDecision.count({ where: { requestId: projectRequestId } })).toBe(before);
  });
  it('US-005 AC-3: rejects non-object params before creating a decision', async () => {
    const before = await db.approvalDecision.count({ where: { requestId: projectRequestId } });
    await post(projectRequestId, { decision: 'approve', params: 'x' }).expect(400);
    expect(await db.approvalDecision.count({ where: { requestId: projectRequestId } })).toBe(before);
  });
  it('AC-3/4: rejects and returns its decision comment', async () => {
    const body = data<{ status: string; decisions: { comment: string; decision: string }[] }>(await post(projectRequestId, { decision: 'reject', comment: 'no' }).expect(200));
    expect(body.status).toBe('rejected'); expect(body.decisions).toMatchObject([{ comment: 'no', decision: 'reject' }]);
  });
  it('AC-5/6: invisible user gets 404 without changing pending request', async () => {
    await post(projectRequestId, { decision: 'reject' }, outsiderToken).expect(404);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: projectRequestId } })).status).toBe('pending');
  });
  it('AC-7: REST opener below agent tier gets localized forbidden', async () => {
    const id = await open(p, agent.id, 'human');
    const res = await post(id, { decision: 'approve' }, agent.apiKey).expect(403);
    expect(res.body.message).toBe(message('decideForbidden', '403', { reason: 'tier-too-low' }));
  });
  it('AC-8: non-pending decisions answer localized conflict', async () => {
    await post(projectRequestId, { decision: 'reject' }).expect(200);
    const res = await post(projectRequestId, { decision: 'approve' }).expect(409);
    expect(res.body.message).toBe(message('notPending', '409', { status: 'rejected' }));
  });
  it('AC-9: expired request answers localized conflict', async () => {
    await db.approvalRequest.update({ where: { id: projectRequestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post(projectRequestId, { decision: 'reject' }).expect(409);
    expect(res.body.message).toBe(message('expired', '409'));
  });
  it('AC-10/11: validates decision and comment length', async () => {
    await post(projectRequestId, { decision: 'maybe' }).expect(400);
    await post(projectRequestId, { decision: 'reject', comment: 'x'.repeat(2001) }).expect(400);
  });
  it('AC-12: global non-admin decider lacking action key gets forbidden, not hidden', async () => {
    const email = `${randomUUID()}@koda.test`;
    const created = await request(server()).post('/api/admin/users').set('Authorization', `Bearer ${world.tokens.root}`).send({ email, name: 'Global', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    const globalId = data<{ id: string }>(created).id;
    await grantKeys(db, { type: 'USER', id: globalId }, ['approval.decide'], null);
    await app.get(PermissionCache).invalidate();
    const token = await loginToken(server(), email);
    const res = await post(projectRequestId, { decision: 'approve' }, token).expect(403);
    expect(res.body.message).toBe(message('decideForbidden', '403', { reason: 'missing-action-permission' }));
  });
  it('AC-13/14: missing request answers localized 404 without writes', async () => {
    const before = await db.approvalDecision.count();
    const res = await post(randomUUID(), { decision: 'approve' }).expect(404);
    expect(res.body.message).toBe(message('requestNotFound', '404')); expect(await db.approvalDecision.count()).toBe(before);
    await get(randomUUID()).expect(404);
  });
});
