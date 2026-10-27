import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
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

(canRunDbTests() ? describe : describe.skip)('Approval request REST cancellation', () => {
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
  const cancel = (id: string, token = agent.apiKey) => request(server()).post(`/api/approvals/${id}/cancel`).set('Authorization', `Bearer ${token}`).send({});
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
  it('AC-2/3/13: opener cancels with exact audit attribution and cannot subsequently decide', async () => {
    const res = await cancel(projectRequestId).expect(200);
    expect(data<{ status: string; decisions: unknown[] }>(res)).toMatchObject({ status: 'cancelled', decisions: [] });
    expect(await db.auditEntry.findMany({ where: { resourceType: 'approval-request', resourceId: projectRequestId }, select: { key: true, actorType: true, summary: true }, take: 20 })).toEqual([
      { key: 'approval.request.cancel', actorType: 'AGENT', summary: 'cancelled label.delete' },
    ]);
    const conflict = await post(projectRequestId, { decision: 'approve' }).expect(409);
    expect(conflict.body.message).toBe(message('notPending', '409', { status: 'cancelled' }));
    expect(labels.state.calls).toHaveLength(0);
  });
  it('AC-6/7: approver cannot cancel another actor request and leaves it pending', async () => {
    const res = await cancel(projectRequestId, approverToken).expect(403);
    expect(res.body.message).toBe(message('cancelForbidden', '403'));
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: projectRequestId } })).status).toBe('pending');
    expect(await db.auditEntry.count({ where: { resourceId: projectRequestId } })).toBe(0);
  });
  it.each(['invisible', 'missing'] as const)('AC-8/10/15: %s request answers localized 404 without mutation or writes', async kind => {
    const mutation = vi.spyOn(app.get(ApprovalDecisionService), 'cancel');
    const before = { audits: await db.auditEntry.count(), decisions: await db.approvalDecision.count(), events: await db.outboxEvent.count() };
    try {
      const res = await cancel(kind === 'missing' ? randomUUID() : projectRequestId, kind === 'missing' ? agent.apiKey : outsiderToken).expect(404);
      expect(res.body.message).toBe(message('requestNotFound', '404'));
      expect(mutation).not.toHaveBeenCalled();
      expect(await db.auditEntry.count()).toBe(before.audits);
      expect(await db.approvalDecision.count()).toBe(before.decisions);
      expect(await db.outboxEvent.count()).toBe(before.events);
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: projectRequestId } })).status).toBe('pending');
    } finally { mutation.mockRestore(); }
  });
  it('AC-9: cancelling executed request answers localized 409', async () => {
    await post(projectRequestId, { decision: 'approve' }).expect(200);
    const res = await cancel(projectRequestId).expect(409);
    expect(res.body.message).toBe(message('notPending', '409', { status: 'executed' }));
  });
  it('AC-14: opener may cancel an expired request still pending', async () => {
    await db.approvalRequest.update({ where: { id: projectRequestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(data<{ status: string }>(await cancel(projectRequestId).expect(200)).status).toBe('cancelled');
  });
});
