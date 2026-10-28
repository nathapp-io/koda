import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalRequestQueries } from '../../../src/approvals/approval-request.queries';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Gated REST approval decisions', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let a: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let b: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let projectId: string;
  let innerId: string;
  let labelPolicyId: string;
  const labels = configurableTestCommand('label.delete');
  const server = () => app.getHttpServer();
  const post = (id: string, decision = 'approve', token = a.apiKey) => request(server())
    .post(`/api/approvals/${id}/decisions`).set('Authorization', `Bearer ${token}`).send({ decision });
  const row = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const noOuter = async () => expect(await db.approvalRequest.count({ where: { permissionKey: 'approval.decide' } })).toBe(0);
  const message = (key: string, status: string, args: Record<string, string> = {}) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return Object.entries(args).reduce((text, [name, value]) => text.replace(`{${name}}`, value), catalog[key][status]);
  };
  const policy = () => request(server()).post('/api/approval-policies')
    .set('Authorization', `Bearer ${world.tokens.root}`).send({
      permissionPattern: 'approval.decide', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human',
    }).expect(201);
  const open = async (scope = projectId, requiredMode: 'agent' | 'human' = 'agent') => {
    if (requiredMode === 'human') await request(server()).patch(`/api/approval-policies/${labelPolicyId}`)
      .set('Authorization', `Bearer ${world.tokens.root}`).send({ mode: 'human' }).expect(200);
    const outcome = await withTestActor({ type: 'AGENT', id: b.id }, () => app.get(ApprovalGate).gate('label.delete',
      { labelId: randomUUID() }, { projectId: scope }));
    if (outcome.status !== 'pending') throw new Error('expected pending inner request');
    return outcome.request.id;
  };
  const defer = async () => {
    await policy();
    return data<{ id: string; permissionKey: string }>(await post(innerId).expect(202));
  };
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get(ApprovalCommandRegistry).register(labels.command);
    a = await seedFleetHttpAgent(server(), world.tokens.root);
    b = await seedFleetHttpAgent(server(), world.tokens.root);
  }, 90_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app); labels.reset();
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    projectId = randomUUID();
    await db.project.create({ data: { id: projectId, slug: `gated-decide-${projectId}`, key: projectId, name: projectId } });
    await grantKeys(db, { type: 'AGENT', id: b.id }, ['label.delete'], projectId);
    await grantKeys(db, { type: 'AGENT', id: a.id }, ['approval.decide', 'label.delete'], projectId);
    await app.get(PermissionCache).invalidate();
    labelPolicyId = data<{ id: string }>(await request(server()).post('/api/approval-policies')
      .set('Authorization', `Bearer ${world.tokens.root}`).send({ permissionPattern: 'label.delete',
        appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'agent' }).expect(201)).id;
    innerId = await open();
  });
  it('AC-1: default none mode executes immediately with one visibility read', async () => {
    const spy = vi.spyOn(app.get(ApprovalRequestQueries), 'get');
    try {
      const response = await post(innerId).expect(200);
      expect(data<{ status: string }>(response).status).toBe('executed');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(labels.state.calls).toHaveLength(1);
      await noOuter();
    } finally { spy.mockRestore(); }
  });
  it('AC-2/3/4/5: defers the decision, then root approval executes both with agent attribution', async () => {
    const outer = await defer();
    expect(outer.permissionKey).toBe('approval.decide');
    expect((await row(innerId)).status).toBe('pending');
    expect(labels.state.calls).toHaveLength(0);
    await post(outer.id, 'approve', world.tokens.root).expect(200);
    expect(await row(innerId)).toMatchObject({ status: 'executed', approverId: a.id, approverType: 'AGENT' });
    expect(await row(outer.id)).toMatchObject({ status: 'executed', result: { id: innerId, status: 'approved' } });
    const result = (await row(outer.id)).result;
    for (const key of ['input', 'result', 'decisions']) expect(result).not.toHaveProperty(key);
    expect(labels.state.calls).toHaveLength(1);
  });
  it('AC-6: cancellation while waiting fails only the outer decision request', async () => {
    const outer = await defer();
    await request(server()).post(`/api/approvals/${innerId}/cancel`).set('Authorization', `Bearer ${b.apiKey}`).send({}).expect(200);
    await post(outer.id, 'approve', world.tokens.root).expect(200);
    expect(await row(outer.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'DeferredDecisionRefusedError' } });
    expect((await row(innerId)).status).toBe('cancelled');
    expect(labels.state.calls).toHaveLength(0);
  });
  it('AC-7: an inner command failure does not undo the committed outer execution', async () => {
    const outer = await defer(); labels.state.executeThrows = true;
    await post(outer.id, 'approve', world.tokens.root).expect(200);
    expect((await row(outer.id)).status).toBe('executed');
    expect(await row(innerId)).toMatchObject({ status: 'failed', approverId: a.id });
  });
  it('AC-8: invisible requests are hidden before opening a decision approval', async () => {
    await policy();
    const other = randomUUID();
    await db.project.create({ data: { id: other, slug: `hidden-${other}`, key: other, name: other } });
    await grantKeys(db, { type: 'AGENT', id: b.id }, ['label.delete'], other);
    await app.get(PermissionCache).invalidate();
    const response = await post(await open(other)).expect(404);
    expect(response.body.message).toBe(message('requestNotFound', '404'));
    await noOuter();
  });
  it.each([false, true])('AC-9/15: tier-too-low stays 403 before the gate (policy=%s)', async (withPolicy) => {
    if (withPolicy) await policy();
    const id = await open(projectId, 'human');
    const response = await post(id).expect(403);
    expect(response.body.message).toBe(message('decideForbidden', '403', { reason: 'tier-too-low' }));
    expect((await row(id)).status).toBe('pending');
    await noOuter();
  });
  it('a narrowed-only decider passes both the route gate and the deferred execution recheck', async () => {
    const narrowed = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: narrowed.id }, ['approval.decide@label.*', 'label.delete'], projectId);
    await app.get(PermissionCache).invalidate();
    await policy();
    const outer = data<{ id: string }>(await post(innerId, 'approve', narrowed.apiKey).expect(202));
    await post(outer.id, 'approve', world.tokens.root).expect(200);
    expect(await row(innerId)).toMatchObject({ status: 'executed', approverId: narrowed.id });
    expect((await row(outer.id)).status).toBe('executed');
  });
  it('a deferred reject records rejection without executing the inner command', async () => {
    await policy();
    const outer = data<{ id: string }>(await post(innerId, 'reject').expect(202));
    expect((await row(innerId)).status).toBe('pending');
    await post(outer.id, 'approve', world.tokens.root).expect(200);
    expect((await row(outer.id)).status).toBe('executed');
    expect((await row(innerId)).status).toBe('rejected');
    expect(labels.state.calls).toHaveLength(0);
  });
  it('an expired inner request fails its deferred decision rather than leaving it approved', async () => {
    const outer = await defer();
    await db.approvalRequest.update({ where: { id: innerId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await post(outer.id, 'approve', world.tokens.root).expect(200);
    expect(await row(outer.id)).toMatchObject({ status: 'failed', result: { name: 'DeferredDecisionRefusedError' } });
    expect(labels.state.calls).toHaveLength(0);
  });
  it('AC-14: an immediate decision on a rejected request keeps the localized 409', async () => {
    await post(innerId, 'reject').expect(200);
    const response = await post(innerId).expect(409);
    expect(response.body.message).toBe(message('notPending', '409', { status: 'rejected' }));
    await noOuter();
  });
});
