import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { CreatorAccess, IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import type { PrdEditsOutcome } from './fleet-flow-calls.service';
import type { FlowStepAction } from './flow-step-decision';
import type { PermissionService } from '../../permissions/permission.service';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { buildStepDispatch } from './flow-step-dispatch';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const NOW = new Date('2026-11-07T12:30:00Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00Z');
const EDIT = { story: 'US-001', op: 'add_ac', new: 'Cover the behavior' };
const FINDING = { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' };

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: '.nax/features/f/spec.md',
  dependsOn: [], state: 'RUNNING', currentStep: 'PRD_REVIEW', prNumber: null, ...over,
});
const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/f', specSha: 's1',
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT, features: [feature()], ...over,
});
/** The verdict a PRD_REVIEW job returns: its findings and the edits it wants applied. */
const verdict = (findings: unknown[], prdEdits: unknown[] = [EDIT]): string =>
  JSON.stringify({ findings, prdEdits });
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
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'PRD_REVIEW', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW,
  agentResult: { status: 'completed', output: verdict([]) }, ...over,
} as FleetJobRecord);

interface Options {
  flow?: Partial<FleetFlowRecord>;
  latest?: Partial<FleetJobRecord>;
  locks?: Partial<FleetFlowRecord>[];
  outcome?: PrdEditsOutcome;
  planCount?: number;
  plan?: Partial<FleetJobRecord>;
}
function build(opts: Options = {}) {
  const latest = job(opts.latest);
  const row = flow({ features: [feature({ currentStep: latest.flowStep ?? null })], ...opts.flow });
  const planJob = job({
    id: 'plan-1', command: 'PLAN', flowStep: 'PLAN', resultSha: 'plan-sha', resultBranch: 'feat/f', ...opts.plan,
  });
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
    countJobsForStepSince: vi.fn<IFleetFlowStepRepository['countJobsForStepSince']>(async (_flowId, _featureId, step) => (
      step === 'PLAN' ? (opts.planCount ?? 0) : 0
    )),
    setBranch: vi.fn(async (_id: string, branch: string) => { assertTx(); row.branch = branch; }),
    recordCalls: vi.fn<IFleetFlowStepRepository['recordCalls']>(async () => { assertTx(); }),
    recordPrdEdits: vi.fn<IFleetFlowStepRepository['recordPrdEdits']>(async () => { assertTx(); }),
    latestJobForStep: vi.fn(async () => planJob),
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
    getBranchHead: vi.fn(async () => { expect(inTransaction).toBe(false); return row.specSha; }),
  };
  const calls = {
    apply: vi.fn(async () => { throw new Error('the PRD edit pass never applies spec calls'); }),
    applyPrdEdits: vi.fn(async () => {
      expect(inTransaction).toBe(false);
      return opts.outcome ?? { kind: 'committed', sha: 'edit-sha', applied: 1, refused: [] };
    }),
  };
  const outbox = { record: vi.fn(async () => { assertTx(); }) };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never, activity as never, audit as never,
    txManager as never, jobs as never, permissions as never, flowService as never, github as never,
    {} as never, testFleetConfig(), calls as never, outbox as never,
    { ruledItemIds: vi.fn(async () => []), createForFlow: vi.fn(), commentRefused: vi.fn() } as never,
  );
  const wrote = () => [flows.stop, steps.setSpent, steps.complete, steps.markStep, steps.recordCalls,
    steps.recordPrdEdits, audit.record, activity.record, flowService.reaskLocked]
    .some((fn) => fn.mock.calls.length > 0);
  return { service, row, latest, flows, steps, calls, jobs, permissions, flowService, activity, audit, github, repos, outbox, order, wrote, txManager, planJob, inTx: () => inTransaction };
}

describe('FleetFlowAdvanceService PRD edit dispatch', () => {
  it('AC-7: sends the PRD_REVIEW body with edits enabled for a NAX flow', async () => {
    const flowRecord = {
      id: 'flow-1', projectId: 'project-1', repoId: 'repo-1', entry: 'NAX', branch: 'feature/one',
      specSha: 'spec-sha', reviewerRole: 'reviewer', pinnedRunnerId: null, createdById: 'user-1',
      features: [{ feature: 'one', specPath: '.nax/features/one/spec.md' }],
    } as unknown as FleetFlowRecord;
    const featureRecord = flowRecord.features[0];
    const plan = { resultSha: 'plan-sha', resultBranch: 'plan/branch' } as FleetJobRecord;
    const dispatch = vi.fn(async () => ({ job: { id: 'next-job' } }));
    const service = new FleetFlowAdvanceService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      { dispatch } as never, {} as never, {} as never, {} as never, {} as never, testFleetConfig(),
      {} as never, {} as never, {} as never,
    );
    const invoke = service as unknown as {
      dispatchStep(pass: {
        flow: FleetFlowRecord;
        feature: FleetFlowFeatureRecord;
        action: FlowStepAction;
        plan: FleetJobRecord;
        remainingCapUsd: string;
      }): Promise<string>;
    };

    await expect(invoke.dispatchStep({
      flow: flowRecord,
      feature: featureRecord,
      action: { kind: 'dispatch', step: 'PRD_REVIEW' },
      plan,
      remainingCapUsd: '10.0000',
    })).resolves.toBe('next-job');

    expect(dispatch).toHaveBeenCalledWith('user-1', 'project-1', buildStepDispatch({
      flow: flowRecord, feature: featureRecord, step: 'PRD_REVIEW', remainingCapUsd: '10.0000', reviewAgent: 'Explore', plan, prdEdits: true,
    }), expect.any(Object));
  });
});

describe('FleetFlowAdvanceService.advance PRD edits', () => {
  it('AC-4: applies the PRD edits once against the PLAN result sha', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.calls.applyPrdEdits).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_prd_edits', jobId: 'j1', edits: [EDIT], accepted: [],
    }, 'plan-sha', { feature: 'f', specPath: '.nax/features/f/spec.md', branch: 'feat/f' });
  });
  it('AC-5: dispatches no job during the pass that applies the PRD edits', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.calls.applyPrdEdits).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });
  it('AC-6: records the PRD edit marker for the review job', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.steps.recordPrdEdits).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', 'j1');
  });
  it('AC-7: records one flow.prd_edits activity with the commit sha and the applied count', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.prd_edits', entityType: 'flow', entityId: 'flow-1', projectId: 'p1',
      payload: { jobId: 'j1', sha: 'edit-sha', applied: 1, refused: [], accepted: [] },
    });
  });
  it('AC-7: records the refused edits unchanged', async () => {
    const refused = [{ index: 0, story: 'US-001', op: 'add_ac', reason: 'duplicate criterion' }];
    const h = build({ outcome: { kind: 'committed', sha: 'edit-sha', applied: 1, refused } });
    await h.service.advance('flow-1', NOW);
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'flow.prd_edits', payload: expect.objectContaining({ refused }),
    }));
  });
  it('AC-8: records an unchanged outcome without a commit sha', async () => {
    const h = build({ outcome: { kind: 'unchanged', refused: [] } });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.recordPrdEdits).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', 'j1');
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.prd_edits', entityType: 'flow', entityId: 'flow-1', projectId: 'p1',
      payload: { jobId: 'j1', sha: null, applied: 0, refused: [], accepted: [] },
    });
  });
  it('AC-9: keeps an accepted finding whose summary carries a lone surrogate', async () => {
    const h = build({
      planCount: 2,
      latest: { agentResult: { status: 'completed', output: verdict([{ id: 'F1', class: 'minor', summary: 'bad \uD800 text', fix: 'fix' }]) } },
    });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.applyPrdEdits).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_prd_edits', jobId: 'j1', edits: [EDIT], accepted: [{ id: 'F1', class: 'minor', summary: 'bad \uD800 text', fix: 'fix' }],
    }, 'plan-sha', { feature: 'f', specPath: '.nax/features/f/spec.md', branch: 'feat/f' });
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'flow.prd_edits',
      payload: expect.objectContaining({ accepted: ['bad \uFFFD text'] }),
    }));
  });
  it('AC-9: keeps an accepted finding whose summary carries a NUL, and the flow still reaches RUN', async () => {
    const h = build({
      planCount: 2,
      latest: { agentResult: { status: 'completed', output: verdict([{ id: 'F1', class: 'minor', summary: 'bad \u0000 text', fix: 'fix' }]) } },
    });
    h.steps.recordPrdEdits.mockImplementation(async (_flowId, _featureId, jobId) => {
      h.row.features[0].prdEditsJobId = jobId;
    });

    await h.service.advance('flow-1', NOW);

    // The payload is a JSONB column: PostgreSQL rejects a NUL in it, and the write would roll back
    // the marker on every tick, so the flow would never reach RUN.
    const payload = h.activity.record.mock.calls[0][0].payload;
    expect(payload).toMatchObject({ accepted: ['bad \uFFFD text'] });
    expect(JSON.stringify(payload)).not.toContain('\u0000');

    await h.service.advance('flow-1', NOW);

    expect(h.calls.applyPrdEdits).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'RUN' }),
      expect.objectContaining({ flowStep: 'RUN' }));
  });
  it('AC-10: re-asks a stale head instead of recording the edits', async () => {
    const h = build({ outcome: { kind: 'stale', head: 'h9' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flowService.reaskLocked).toHaveBeenCalledExactlyOnceWith(h.row, 'h9', NOW);
    expect(h.steps.recordPrdEdits).not.toHaveBeenCalled();
  });
  it('AC-11: stops with calls_failed when the edit commit fails', async () => {
    const h = build({ outcome: { kind: 'failed', detail: 'prd.json unreadable' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledExactlyOnceWith('flow-1', 'calls_failed', NOW, 'PRD_REVIEW edits: prd.json unreadable');
    expect(h.steps.recordPrdEdits).not.toHaveBeenCalled();
  });
  it.each([{ state: 'STOPPED' }, { approvedAt: NOW }])(
    'AC-12: records nothing when the flow is no longer live after the commit: %j', async (changed) => {
      const h = build({ locks: [{}, changed] });
      await h.service.advance('flow-1', NOW);
      expect(h.calls.applyPrdEdits).toHaveBeenCalledOnce();
      expect(h.steps.recordPrdEdits).not.toHaveBeenCalled();
      expect(h.activity.record).not.toHaveBeenCalled();
    },
  );
  it('AC-13: stops a flow whose creator lost dispatch access before the edit commit', async () => {
    const h = build();
    h.permissions.effectiveKeys.mockResolvedValue(new Set());
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'creator_lost_access', NOW, 'flow creator lost dispatch access');
    expect(h.calls.applyPrdEdits).not.toHaveBeenCalled();
  });
  it('AC-14: persists the PLAN output branch before the edit commit', async () => {
    const h = build({ plan: { resultBranch: 'prd/output' } });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.setBranch).toHaveBeenCalledExactlyOnceWith('flow-1', 'prd/output');
    expect(h.steps.setBranch.mock.invocationCallOrder[0])
      .toBeLessThan(h.calls.applyPrdEdits.mock.invocationCallOrder[0]);
    expect(h.calls.applyPrdEdits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ branch: 'prd/output' }),
      expect.objectContaining({ kind: 'apply_prd_edits' }),
      'plan-sha',
      { feature: 'f', specPath: '.nax/features/f/spec.md', branch: 'prd/output' },
    );
  });
  it('AC-15: dispatches RUN on the PLAN result branch once the edits are recorded', async () => {
    const h = build({ plan: { resultBranch: 'prd/output' } });
    h.steps.recordPrdEdits.mockImplementation(async (_flowId, _featureId, jobId) => {
      expect(h.inTx()).toBe(true);
      h.row.features[0].prdEditsJobId = jobId;
    });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.applyPrdEdits).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).not.toHaveBeenCalled();

    await h.service.advance('flow-1', NOW);
    expect(h.calls.applyPrdEdits).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'RUN', ref: 'prd/output' }),
      expect.objectContaining({ flowStep: 'RUN' }));
  });
});
