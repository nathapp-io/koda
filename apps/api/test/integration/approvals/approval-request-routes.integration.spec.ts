import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
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

(canRunDbTests() ? describe : describe.skip)('Approval request REST visibility', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let approverToken: string;
  let outsiderToken: string;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let otherAgent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: string;
  let q: string;
  let pId: string;
  let qId: string;
  let frozenInput: { labelId: string };
  const labels = configurableTestCommand('label.delete');
  const server = () => app.getHttpServer();
  const get = (path = '', query = {}, token = approverToken) => request(server()).get(`/api/approvals${path}`)
    .query(query).set('Authorization', `Bearer ${token}`);
  const ids = (res: request.Response) => data<{ records: { id: string }[] }>(res).records.map((row) => row.id).sort();
  const open = async (projectId: string, actorId: string, input = { labelId: randomUUID() }) => {
    const result = await withTestActor({ type: 'AGENT', id: actorId }, () => app.get(ApprovalGate).gate('label.delete', input, { projectId }));
    if (result.status !== 'pending') throw new Error('expected pending request');
    return result.request.id;
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get(ApprovalCommandRegistry).register(labels.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    labels.reset();
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    const createUser = async () => {
      const email = `${randomUUID()}@koda.test`;
      const res = await request(server()).post('/api/admin/users').set('Authorization', `Bearer ${world.tokens.root}`)
        .send({ email, name: 'Approval reader', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      return { id: data<{ id: string }>(res).id, token: await loginToken(server(), email) };
    };
    const approver = await createUser();
    const outsider = await createUser();
    approverToken = approver.token; outsiderToken = outsider.token;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    otherAgent = await seedFleetHttpAgent(server(), world.tokens.root);
    p = randomUUID(); q = randomUUID();
    for (const id of [p, q]) await db.project.create({ data: { id, slug: `routes-${id}`, key: id, name: id } });
    await grantRole(db, { type: 'USER', id: approver.id }, 'approver', p);
    for (const id of [agent.id, otherAgent.id]) for (const projectId of [p, q]) {
      await grantKeys(db, { type: 'AGENT', id }, ['label.delete'], projectId);
    }
    await app.get(PermissionCache).invalidate();
    frozenInput = { labelId: randomUUID() };
    pId = await open(p, agent.id, frozenInput);
    qId = await open(q, otherAgent.id);
  });
  it('AC-1: P approver gets exactly the P requests with Q present', async () => {
    const second = await open(p, otherAgent.id);
    expect(await db.approvalRequest.findUnique({ where: { id: qId } })).not.toBeNull();
    expect(ids(await get().expect(200))).toEqual([pId, second].sort());
  });
  it('AC-2: summaries omit input and result', async () => {
    const rows = data<{ records: object[] }>(await get().expect(200)).records;
    expect(rows).toHaveLength(1);
    for (const row of rows) { expect(row).not.toHaveProperty('input'); expect(row).not.toHaveProperty('result'); }
  });
  it('AC-3: invalid status is 400', async () => { await get('', { status: 'bogus' }).expect(400); });
  it('AC-4: invalid mine is 400', async () => { await get('', { mine: 'yes' }).expect(400); });
  it('AC-5: mine=true admits the REST agent and selects only its request', async () => {
    await open(p, otherAgent.id);
    expect(ids(await get('', { mine: 'true' }, agent.apiKey).expect(200))).toEqual([pId]);
  });
  it('AC-6: detail includes frozen input and decisions', async () => {
    const decision = await db.approvalDecision.create({ data: {
      requestId: pId, deciderType: 'USER', deciderId: world.ids.root, decision: 'approve', comment: 'Reviewed',
    } });
    expect(data(await get(`/${pId}`).expect(200))).toMatchObject({
      id: pId, input: frozenInput, result: null,
      decisions: [{ id: decision.id, deciderType: 'USER', deciderId: world.ids.root, decision: 'approve', comment: 'Reviewed', decidedAt: decision.decidedAt.toISOString() }],
    });
  });
  it('AC-7: invisible request is a localized 404', async () => {
    const res = await get(`/${pId}`, {}, outsiderToken).expect(404);
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8'));
    expect(catalog.requestNotFound['404']).toBe('Approval request not found');
    expect(res.body.message).toBe(catalog.requestNotFound['404']);
  });
  it('AC-10: no credentials is 401', async () => { await request(server()).get('/api/approvals').expect(401); });
  it('AC-11: Q filter cannot widen visibility', async () => {
    expect(await db.approvalRequest.findUnique({ where: { id: qId } })).not.toBeNull();
    expect(ids(await get('', { projectId: q }).expect(200))).toEqual([]);
  });
});
