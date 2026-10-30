import { Logger } from '@nestjs/common';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { FleetBudgetOverrideCommand } from '../../../src/fleet/approvals/commands/fleet-budget-override.command';
import { budgetReason } from '../../../src/fleet/budgets/budget-rules';
import { Prisma } from '../../../src/generated/prisma/client';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval request command details HTTP', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  const server = () => app.getHttpServer();
  const get = (id: string) => request(server()).get(`/api/approvals/${id}`).set('Authorization', `Bearer ${world.tokens.root}`);
  const bash = () => seedFleetAsk(db, { kind: 'bash', projectId: null, input: { jobId: 'J', leaseEpoch: 1, naxAskId: 'ask', payload: {} }, link: { jobId: 'J' } });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => resetThrottle(app));
  it('AC-1: pending bash details name its job', async () => {
    const { requestId } = await bash();
    expect(data<{ details: unknown }>(await get(requestId).expect(200)).details).toEqual({ kind: 'bash', jobId: 'J', resolvedBy: null, outcome: null });
  });
  it('AC-6: agent.create redeem has no details hook', async () => {
    const registry = app.get(ApprovalCommandRegistry);
    expect(registry.get('agent.create', 'rest:agents.create')).toBeDefined();
    const row = await db.approvalRequest.create({ data: {
      permissionKey: 'agent.create', variant: 'rest:agents.create', redeem: true, actorType: 'AGENT', actorId: 'a', origin: 'rest', correlationId: 'c',
      input: { name: 'redacted' }, inputHash: 'hash', requiredMode: 'human', onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false, expiresAt: new Date(Date.now() + 60000),
    } });
    expect(data<{ details: unknown }>(await get(row.id).expect(200)).details).toBeNull();
  });
  it('AC-10: a missing fleet link remains readable', async () => {
    const { requestId } = await bash();
    await db.fleetApprovalAsk.delete({ where: { requestId } });
    expect(data<{ details: unknown }>(await get(requestId).expect(200)).details).toBeNull();
  });
  it('AC-11: throwing enrichment remains HTTP 200 and warns', async () => {
    const { requestId } = await seedFleetAsk(db, { kind: 'budget', projectId: null, input: {}, link: { budgetPolicyId: 'missing' } });
    const hook = vi.spyOn(app.get(FleetBudgetOverrideCommand), 'details').mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    warn.mockClear();
    try {
      expect(data<{ details: unknown }>(await get(requestId).expect(200)).details).toBeNull();
      expect(warn.mock.calls.filter(call => JSON.stringify(call).includes(requestId))).toHaveLength(1);
    } finally { hook.mockRestore(); warn.mockRestore(); }
  });
  const budget = async () => {
    const project = await db.project.create({ data: { name: 'Details budget', slug: `details-${crypto.randomUUID()}`, key: crypto.randomUUID() } });
    const userId = world.ids.root;
    const repo = await db.fleetRepo.create({ data: { projectId: project.id, provider: 'github', owner: 'acme', name: crypto.randomUUID(), defaultBranch: 'main', createdById: userId } });
    const policy = await db.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: project.id, scopeKey: `project:${project.id}`, projectId: project.id, windowKind: 'lifetime', amountUsd: new Prisma.Decimal(10),
      pausedAt: new Date(), pausedWindowStart: new Date(0), createdById: userId, updatedById: userId,
    } });
    const opened = new Date(Date.now() - 60000);
    const job = await db.fleetJob.create({ data: {
      projectId: project.id, repoId: repo.id, ref: 'main', command: 'RUN', feature: 'details', profiles: [], selectorLabels: [], requestedById: userId,
      maxCostUsd: new Prisma.Decimal(5), state: 'CANCELLED', cancelReason: budgetReason(policy.id), finishedAt: opened,
    } });
    const { requestId } = await seedFleetAsk(db, { kind: 'budget', projectId: project.id, input: {
      policyId: policy.id, scopeType: 'project', scopeId: project.id, windowKind: 'lifetime', windowStart: new Date(0).toISOString(), spentUsd: '10', amountUsd: '10', requestedAt: opened.toISOString(),
    }, link: { budgetPolicyId: policy.id } });
    return { requestId, policy, job };
  };
  it('AC-2/9: pending candidates feed the existing decision route and requeue after commit', async () => {
    const { requestId, policy, job } = await budget();
    const detail = data<{ details: { requeueCandidates: Array<{ jobId: string }> } }>(await get(requestId).expect(200));
    expect(detail.details).toEqual({ kind: 'budget', policyId: policy.id, resolvedBy: null, outcome: null,
      requeueCandidates: [{ jobId: job.id, projectId: job.projectId, feature: job.feature, queuedAt: job.queuedAt.toISOString() }], requeueCandidatesTruncated: false });
    const hook = vi.spyOn(app.get(FleetBudgetOverrideCommand), 'details');
    hook.mockClear();
    try {
      const res = await request(server()).post(`/api/approvals/${requestId}/decisions`).set('Authorization', `Bearer ${world.tokens.root}`)
        .send({ decision: 'approve', params: { amountUsd: 20, requeueJobIds: detail.details.requeueCandidates.map(c => c.jobId) } }).expect(200);
      expect(data<{ details: unknown; status: string }>(res)).toMatchObject({ details: null, status: 'executed' });
      expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe('QUEUED');
      expect(hook).not.toHaveBeenCalled();
    } finally { hook.mockRestore(); }
  });
  it('AC-4: window-reset cancellation omits candidate fields', async () => {
    const { requestId, policy } = await budget();
    await db.approvalRequest.update({ where: { id: requestId }, data: { status: 'cancelled' } });
    await db.fleetApprovalAsk.update({ where: { requestId }, data: { resolvedBy: 'window_reset' } });
    expect(data<{ details: unknown }>(await get(requestId).expect(200)).details).toEqual({ kind: 'budget', policyId: policy.id, resolvedBy: 'window_reset', outcome: null });
  });
});
