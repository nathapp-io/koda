import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import request from 'supertest';
import { ApprovalAskService } from '../../../src/approvals/approval-ask.service';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { WebhookDispatcherService } from '../../../src/webhook/webhook-dispatcher.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpAgent, seedFleetHttpWorld, syncBody, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

interface Delivery { webhookId: string; event: string; payload: Record<string, unknown> }

(canRunDbTests() ? describe : describe.skip)('Transactional all-key approval webhooks (HTTP/PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const subscribe = (events: string[] | string) => db.webhook.create({ data: {
    projectId: world.projectId, url: 'https://hooks.example.com/approvals', secret: 's'.repeat(32),
    events: typeof events === 'string' ? events : JSON.stringify(events), active: true,
  } });
  const deliveries = async (webhookId: string, requestId?: string) => {
    const rows = await db.outboxEvent.findMany({ where: { type: 'webhook_delivery', projectId: world.projectId }, orderBy: { createdAt: 'asc' } });
    return rows.map(row => JSON.parse(row.payload) as Delivery).filter(body => body.webhookId === webhookId && (requestId === undefined || body.payload.requestId === requestId));
  };
  const approve = (id: string, status = 200) => request(server()).post(`/api/approvals/${id}/decisions`)
    .auth(world.tokens.root, { type: 'bearer' }).send({ decision: 'approve' }).expect(status);
  const waitPolicy = async (key: string) => {
    const policy = await seedWaitPolicy(db, key, world.projectId);
    await db.approvalPolicy.update({ where: { id: policy.id }, data: { mode: 'human' } });
  };
  const openLabel = async () => {
    await waitPolicy('label.delete');
    const label = await db.label.create({ data: { projectId: world.projectId, name: randomUUID(), color: '#ffffff' } });
    const res = await request(server()).delete(`/api/projects/web/labels/${label.id}`).auth(agent.apiKey, { type: 'bearer' }).expect(202);
    const { id } = data<{ id: string }>(res);
    return db.approvalRequest.findUniqueOrThrow({ where: { id } });
  };

  beforeAll(async () => {
    await resetDb();
    const savedWait = process.env.FLEET_SYNC_WAIT_MS;
    process.env.FLEET_SYNC_WAIT_MS = '100';
    try { app = await bootHttpApp({ registrationEnabled: true }); }
    finally {
      if (savedWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
      else process.env.FLEET_SYNC_WAIT_MS = savedWait;
    }
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'label.delete', 'project.update'], world.projectId);
    await app.get(PermissionCache).invalidate();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.webhook.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.outboxEvent.deleteMany();
  });

  it('AC-1: gated label.delete records exactly the content-free pending payload', async () => {
    const hook = await subscribe(['approval.requested']);
    const opened = await openLabel();
    expect(await deliveries(hook.id, opened.id)).toEqual([{ webhookId: hook.id, event: 'approval.requested', payload: {
      requestId: opened.id, permissionKey: 'label.delete', status: 'pending', projectId: world.projectId,
      requiredMode: 'human', actorType: 'AGENT', actorId: agent.id, onBehalfOfType: null, onBehalfOfId: null,
      expiresAt: opened.expiresAt.toISOString(), path: `/approvals?id=${opened.id}`,
    } }]);
  });

  it('AC-2: a deferred approval dispatches approved then executed, once each', async () => {
    const hook = await subscribe(['approval.resolved']);
    const opened = await openLabel();
    expect(data<{ status: string }>(await approve(opened.id)).status).toBe('executed');
    const rows = await deliveries(hook.id, opened.id);
    expect(rows.map(row => row.payload.status)).toEqual(['approved', 'executed']);
    expect(rows.map(row => row.event)).toEqual(['approval.resolved', 'approval.resolved']);
    expect(rows.every(row => row.payload.actorId === agent.id)).toBe(true);
  });

  it('AC-3: a redeem approval emits executed only after the original action is redeemed', async () => {
    const hook = await subscribe(['approval.resolved']);
    await waitPolicy('project.update');
    const patch = { ciWebhookToken: 't'.repeat(32) };
    const path = '/api/projects/web';
    const opened = data<{ id: string; redeem: boolean }>(await request(server()).patch(path).auth(agent.apiKey, { type: 'bearer' }).send(patch).expect(202));
    expect(opened.redeem).toBe(true);
    expect(data<{ status: string }>(await approve(opened.id)).status).toBe('approved');
    expect((await deliveries(hook.id, opened.id)).map(row => row.payload.status)).toEqual(['approved']);
    await request(server()).patch(path).auth(agent.apiKey, { type: 'bearer' }).set('X-Koda-Approval-Request', opened.id).send(patch).expect(200);
    expect((await deliveries(hook.id, opened.id)).map(row => row.payload.status)).toEqual(['approved', 'executed']);
  });

  it('AC-4: runner relay retains fleet requested and adds engine requested subscriptions', async () => {
    const oldHook = await subscribe(['fleet.approval.requested']);
    const hook = await subscribe(['approval.requested']);
    const runner = await enrollRunner(server(), world.tokens.root, `hooks-${randomUUID()}`);
    const sync = async (over: Partial<SyncRequest>) => data<SyncResponse>(await request(server()).post('/api/fleet/runner/sync')
      .auth(runner.apiKey, { type: 'bearer' }).send(syncBody({ protocolVersion: 2, ...over })).expect(200));
    await sync({ capabilities: { ...FLEET_CAPS, approvals: { relay: true } } });
    const jobId = data<{ job: { id: string } }>(await request(server()).post('/api/projects/web/fleet/jobs').auth(world.tokens.dev, { type: 'bearer' })
      .send({ repoId: world.repoId, command: 'RUN', feature: 'approval-hooks', maxCostUsd: 5, bashMode: 'escalate', pinnedRunnerId: runner.runnerId }).expect(201)).job.id;
    const assign = (await sync({ freeSlots: 1 })).commands.find(command => command.type === 'ASSIGN' && command.jobId === jobId);
    expect(assign).toBeDefined();
    if (!assign) throw new Error('expected ASSIGN');
    const leaseEpoch = assign.leaseEpoch;
    try {
      await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch, result: 'ok' }], jobs: [{ jobId, leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
      await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: {
        naxAskId: 'ask-004a', deadlineAt: new Date(Date.now() + 300_000).toISOString(), command: 'bun run test', commandTruncated: false,
        maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'story', featureName: 'hooks', reason: 'ask rule', options: ['allow', 'deny'],
      } }] }] });
      const link = await db.fleetApprovalAsk.findFirstOrThrow({ where: { jobId } });
      const opened = await db.approvalRequest.findUniqueOrThrow({ where: { id: link.requestId } });
      expect(opened.status).toBe('pending');
      expect(await deliveries(hook.id, opened.id)).toEqual([expect.objectContaining({ event: 'approval.requested', payload: expect.objectContaining({ permissionKey: 'fleet.job.shell.escalate', status: 'pending' }) })]);
      expect(await deliveries(oldHook.id)).toEqual([expect.objectContaining({ event: 'fleet.approval.requested' })]);
    } finally {
      await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 3, type: 'state', payload: { to: 'UPLOADING' } }, { seq: 4, type: 'state', payload: { to: 'COMPLETED' } }] }] });
    }
  });

  it('AC-5: a global budget ask commits pending without any requested delivery', async () => {
    const hook = await subscribe(['approval.requested']);
    const now = new Date().toISOString();
    const opened = await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => app.get<ITransactionManager>(TRANSACTION_MANAGER).run(() => app.get(ApprovalAskService).open({
      key: 'fleet.budget.override', projectId: null, component: 'budget', onBehalfOf: null, origin: 'system', deadline: null,
      input: { policyId: 'global-policy', scopeType: 'global', scopeId: null, windowKind: 'lifetime', windowStart: now, spentUsd: '11', amountUsd: '10', requestedAt: now },
    })));
    expect(opened.status).toBe('pending');
    if (opened.status !== 'pending') throw new Error('expected pending');
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: opened.request.id } })).toMatchObject({ status: 'pending', projectId: null });
    expect(await deliveries(hook.id)).toEqual([]);
    expect(await db.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: 'approval.requested' } } })).toBe(0);
  });

  it('AC-6: unrelated subscriptions never receive approval statuses', async () => {
    const hook = await subscribe(['ticket.created']);
    const control = await subscribe(['approval.requested', 'approval.resolved']);
    const opened = await openLabel();
    await approve(opened.id);
    expect(await deliveries(hook.id)).toEqual([]);
    expect((await deliveries(control.id, opened.id)).map(row => row.payload.status)).toEqual(['pending', 'approved', 'executed']);
  });

  it('AC-10: shared dispatcher failure returns 500 and rolls back the decision and status', async () => {
    await subscribe(['approval.resolved']);
    const opened = await openLabel();
    const spy = vi.spyOn(app.get(WebhookDispatcherService, { strict: false }), 'dispatch').mockRejectedValue(new Error('boom'));
    try {
      await approve(opened.id, 500);
      expect(spy).toHaveBeenCalledWith(world.projectId, 'approval.resolved', expect.objectContaining({ status: 'approved' }));
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: opened.id } })).status).toBe('pending');
      expect(await db.approvalDecision.count({ where: { requestId: opened.id } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { type: 'approval_request_changed', eventId: `${opened.id}:approved` } })).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('AC-12: malformed subscriptions warn and skip without rolling back pending status', async () => {
    const hook = await subscribe('{broken');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    try {
      const opened = await openLabel();
      expect(opened.status).toBe('pending');
      expect(await deliveries(hook.id)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(`Webhook ${hook.id} has malformed events JSON; skipping`);
    } finally { warn.mockRestore(); }
  });
});
