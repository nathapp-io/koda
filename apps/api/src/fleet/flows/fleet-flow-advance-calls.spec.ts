import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { CreatorAccess, IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import type { FleetFlowCallsService, CallsOutcome } from './fleet-flow-calls.service';
import type { PermissionService } from '../../permissions/permission.service';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const NOW = new Date('2026-11-07T12:30:00Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00Z');
const FINDING = { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' } as const;

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: '.nax/features/f/spec.md',
  dependsOn: [], state: 'RUNNING', currentStep: 'SPEC_REVIEW', prNumber: null, ...over,
});
const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/f', specSha: 's1',
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT, features: [feature()], ...over,
});
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'repo-1', ref: 's1', command: 'AGENT', feature: 'f',
  planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date('2026-11-07T12:05:00Z'), assignedAt: null, startedAt: null,
  finishedAt: new Date('2026-11-07T12:20:00Z'), cancelRequestedAt: null,
  naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', costCarriedUsd: '0.0000', firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: 'feat/f', resultSha: 'review-sha',
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'SPEC_REVIEW', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW,
  agentResult: { status: 'completed', output: JSON.stringify({ findings: [FINDING] }) }, ...over,
} as FleetJobRecord);

interface Options {
  flow?: Partial<FleetFlowRecord>;
  latest?: Partial<FleetJobRecord>;
  locks?: Partial<FleetFlowRecord>[];
  outcome?: CallsOutcome;
  planCount?: number;
  head?: string;
}
function build(opts: Options = {}) {
  const latest = job(opts.latest);
  const row = flow({ features: [feature({ currentStep: latest.flowStep ?? null })], ...opts.flow });
  let inTransaction = false;
  let lockIndex = 0;
  const order: string[] = [];
  const assertTx = () => { expect(inTransaction).toBe(true); };
  const flows = {
    findById: vi.fn(async () => row),
    lockById: vi.fn(async () => {
      assertTx(); order.push('flow');
      return flow({ ...row, ...opts.locks?.[lockIndex++] });
    }),
    stop: vi.fn(async () => { assertTx(); return row; }),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => ({ job: latest, ingestSettled: true })),
    sumCost: vi.fn(async () => row.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }),
    creatorAccess: vi.fn<IFleetFlowStepRepository['creatorAccess']>(async (): Promise<CreatorAccess> => {
      assertTx(); return { exists: true, disabled: false };
    }),
    countJobsForStepSince: vi.fn<IFleetFlowStepRepository['countJobsForStepSince']>(async () => opts.planCount ?? 0),
    recordCalls: vi.fn<IFleetFlowStepRepository['recordCalls']>(async () => { assertTx(); }),
    latestJobForStep: vi.fn(async () => job({ id: 'plan-1', command: 'PLAN', flowStep: 'PLAN', resultSha: 'plan-sha' })),
  };
  const repos = {
    lockById: vi.fn(async () => { assertTx(); order.push('repo'); return { id: row.repoId }; }),
    findReviewRepo: vi.fn(async () => ({ id: row.repoId, owner: 'o', name: 'r', githubInstallationId: 1n })),
  };
  const threads = { lockForFlowTransition: vi.fn(async () => { assertTx(); return { publishedSha: row.specSha }; }) };
  const activity = { record: vi.fn(async () => { assertTx(); }) };
  const audit = { record: vi.fn(async () => { assertTx(); }) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    expect(inTransaction).toBe(false);
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  }) };
  const jobs = { dispatch: vi.fn(async () => {
    expect(inTransaction).toBe(false); return { job: { id: 'next-job' } };
  }) };
  const permissions = { effectiveKeys: vi.fn<PermissionService['effectiveKeys']>(async () => {
    assertTx(); return new Set(['fleet.job.dispatch']);
  }) };
  const flowService = { reaskLocked: vi.fn(async () => { assertTx(); return row; }) };
  const github = {
    mintReadOnlyToken: vi.fn(async () => { expect(inTransaction).toBe(false); return { token: 'test-only', expiresAt: NOW }; }),
    getBranchHead: vi.fn(async () => { expect(inTransaction).toBe(false); return opts.head ?? row.specSha; }),
  };
  const calls = { apply: vi.fn<FleetFlowCallsService['apply']>(async () => {
    expect(inTransaction).toBe(false);
    return opts.outcome ?? { kind: 'committed', specSha: 's2' };
  }) };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never, activity as never, audit as never,
    txManager as never, jobs as never, permissions as never, flowService as never, github as never,
    {} as never, testFleetConfig(), calls as never, { record: vi.fn() } as never,
  );
  const wrote = () => [flows.stop, steps.setSpent, steps.complete, steps.markStep, steps.recordCalls,
    audit.record, activity.record, flowService.reaskLocked].some((fn) => fn.mock.calls.length > 0);
  return { service, row, latest, flows, steps, calls, jobs, permissions, flowService, activity, audit, github, order, wrote, txManager };
}

describe('FleetFlowAdvanceService.advance calls', () => {
  it('AC-1: applies SPEC_REVIEW calls once outside a transaction, without dispatch', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [FINDING],
    }, 's1');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });
  it('AC-2: records committed calls under parent then flow locks', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.steps.recordCalls).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', 'j1', 's2');
    expect(h.order).toEqual(['repo', 'flow', 'repo', 'flow']);
  });
  it('AC-3: records flow.calls activity in the record transaction', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.calls', entityType: 'flow', entityId: 'flow-1', projectId: 'p1',
      payload: { step: 'SPEC_REVIEW', jobId: 'j1', specSha: 's2', count: 1 },
    });
  });
  it('AC-4: audits the calls commit in the record transaction', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: 'flow-1', projectId: 'p1', summary: 'flow calls SPEC_REVIEW',
    });
  });
  it('AC-5: a retry writes nothing', async () => {
    const h = build({ outcome: { kind: 'retry' } });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.wrote()).toBe(false);
    expect(h.txManager.run).toHaveBeenCalledOnce();
  });
  it('AC-6: a stale head re-asks under the locks', async () => {
    const h = build({ outcome: { kind: 'stale', head: 'h9' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flowService.reaskLocked).toHaveBeenCalledExactlyOnceWith(h.row, 'h9', NOW);
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
  });
  it('AC-7: PRD_REVIEW calls use the latest PLAN result sha', async () => {
    const h = build({ latest: { flowStep: 'PRD_REVIEW' }, planCount: 1 });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.latestJobForStep).toHaveBeenCalledWith('flow-1', 'PLAN');
    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'PRD_REVIEW', jobId: 'j1', findings: [FINDING],
    }, 'plan-sha');
  });
  it('AC-8: a failure stops with calls_failed and the step detail', async () => {
    const h = build({ outcome: { kind: 'failed', detail: 'spec write refused' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledExactlyOnceWith('flow-1', 'calls_failed', NOW, 'SPEC_REVIEW: spec write refused');
  });
  it('AC-9: lost dispatch access stops before applying calls', async () => {
    const h = build();
    h.permissions.effectiveKeys.mockResolvedValue(new Set());
    await h.service.advance('flow-1', NOW);
    expect(h.steps.creatorAccess).toHaveBeenCalledWith({ type: 'USER', id: 'u1' });
    expect(h.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'creator_lost_access', NOW, 'flow creator lost dispatch access');
    expect(h.calls.apply).not.toHaveBeenCalled();
  });
  it('AC-10: a stop between apply and record receives no calls progress', async () => {
    const h = build({ locks: [{}, { state: 'STOPPED' }] });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.flows.lockById).toHaveBeenCalledTimes(2);
    expect(h.wrote()).toBe(false);
  });
  it('AC-11: retains the applied SPEC_REVIEW despite its old ref and dispatches PLAN', async () => {
    const h = build({ flow: { specSha: 's2', features: [feature({ callsJobId: 'j1' })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'PLAN' }),
      expect.objectContaining({ flowStep: 'PLAN' }));
    expect(h.flowService.reaskLocked).not.toHaveBeenCalled();
    expect(h.calls.apply).not.toHaveBeenCalled();
  });
  it('AC-12: applied PRD_REVIEW preflights the head and re-plans', async () => {
    const h = build({ latest: { flowStep: 'PRD_REVIEW' }, planCount: 1,
      flow: { specSha: 's2', features: [feature({ currentStep: 'PRD_REVIEW', callsJobId: 'j1' })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.github.getBranchHead).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'PLAN' }),
      expect.objectContaining({ flowStep: 'PLAN' }));
    expect(h.flowService.reaskLocked).not.toHaveBeenCalled();
  });
  it('AC-13: clean PRD_REVIEW dispatches RUN without forge reads', async () => {
    const h = build({ latest: { flowStep: 'PRD_REVIEW', agentResult: { status: 'completed', output: '{"findings":[]}' } } });
    await h.service.advance('flow-1', NOW);
    expect(h.github.getBranchHead).not.toHaveBeenCalled();
    expect(h.github.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'RUN' }),
      expect.objectContaining({ flowStep: 'RUN' }));
  });
  it('AC-14: counts PLAN jobs since approval to stop second-round findings', async () => {
    const h = build({ latest: { flowStep: 'PRD_REVIEW' }, planCount: 2 });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.countJobsForStepSince).toHaveBeenCalledWith('flow-1', 'PLAN', APPROVED_AT);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'review_findings', NOW, expect.stringContaining('Missing AC'));
    expect(h.calls.apply).not.toHaveBeenCalled();
  });
  it('AC-15: thread-entry findings stop rather than applying calls', async () => {
    const h = build({ flow: { entry: 'THREAD', threadId: 'thread-1' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'review_findings', NOW, expect.stringContaining('Missing AC'));
    expect(h.calls.apply).not.toHaveBeenCalled();
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('calls bypass exhausted cap and the dispatch spec-sha guard', async () => {
    const h = build({ flow: { spentUsd: '10.0000' }, head: 'h9' });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.flowService.reaskLocked).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
  });
  it.each([{ specSha: 'new-spec' }, { approvedAt: NOW }])('does not record across an approval generation change: %j', async (changed) => {
    const h = build({ locks: [{}, changed] });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.wrote()).toBe(false);
  });
  it.each(['SPEC_REVIEW', 'PRD_REVIEW'] as const)('a later external push after %s calls still re-asks', async (step) => {
    const h = build({ latest: { flowStep: step }, planCount: 1, head: 'external',
      flow: { specSha: 's2', features: [feature({ currentStep: step, callsJobId: 'j1' })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.flowService.reaskLocked).toHaveBeenCalledWith(h.row, 'external', NOW);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });
  it('does not retain an applied SPEC_REVIEW from before this approval', async () => {
    const h = build({ latest: { queuedAt: new Date(APPROVED_AT.getTime() - 1) },
      flow: { specSha: 's2', features: [feature({ callsJobId: 'j1' })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.any(Object), expect.objectContaining({ flowStep: 'SPEC_REVIEW' }));
  });
});
