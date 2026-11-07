import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { buildStepDispatch } from './flow-step-dispatch';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { FleetActivityService } from '../activity/fleet-activity.service';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord, IFleetFlowRepository } from './domain/fleet-flow.domain';
import type { CreatorAccess, IFleetFlowStepRepository, LatestFlowJob } from './domain/fleet-flow-step.domain';
import type { PermissionService } from '../../permissions/permission.service';
import type { PrincipalRef } from '../../permissions/permissions.types';
import type { FlowStepInput } from './flow-step-decision';
import { FLOW_STOP_DETAIL_MAX } from './flow-steps';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';

/** Observe decision inputs while still exercising the real decision engine on every pass. */
const decisions = vi.hoisted(() => ({ inputs: [] as FlowStepInput[] }));
vi.mock('./flow-step-decision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flow-step-decision')>();
  return {
    ...actual,
    decideFlowStep: (input: FlowStepInput) => {
      decisions.inputs.push(input);
      return actual.decideFlowStep(input);
    },
  };
});

const NOW = new Date('2026-11-07T12:30:00.000Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00.000Z');
const RUN_PR = 'https://github.com/o/r/pull/12';

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: '.nax/features/f/spec.md',
  dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/f', specSha: 'a'.repeat(40),
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'APPROVED', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT, features: [feature()], ...over,
});

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'feat/f', command: 'RUN', feature: 'f',
  planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date('2026-11-07T12:05:00.000Z'), assignedAt: null, startedAt: null,
  finishedAt: new Date('2026-11-07T12:20:00.000Z'), cancelRequestedAt: null,
  naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', costCarriedUsd: '0.0000', firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: 'feat/f', resultSha: 'b'.repeat(40),
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'RUN', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW, ...over,
} as FleetJobRecord);

interface HarnessOptions {
  /** The row the unlocked read returns. */
  flow?: Partial<FleetFlowRecord>;
  /** The row the flow lock returns; the unlocked row when absent, null for a flow deleted meanwhile. */
  locked?: Partial<FleetFlowRecord> | null;
  /** The pair the decide phase reads: the flow's latest job with the ingest status of its own lease. */
  snapshot?: LatestFlowJob | null;
  /** Rows a separate, unlocked job read would return — the stale snapshots the regression probes model. */
  staleRows?: FleetJobRecord[];
  /** What a separate ingest-status read would answer. */
  settledApart?: boolean;
  sum?: string;
  threadMissing?: boolean;
  repoMissing?: boolean;
  reviewRepo?: { owner: string; name: string } | null;
  creatorAccess?: CreatorAccess;
  creatorKeys?: ReadonlySet<string>;
}

function build(opts: HarnessOptions = {}) {
  const row = flow(opts.flow);
  // Existing RUNNING fixtures represent already-recorded jobs unless a test supplies feature progress.
  const record = opts.flow?.state === 'RUNNING' && opts.flow.features === undefined && opts.snapshot
    ? flow({ ...opts.flow, features: [feature({ state: 'RUNNING', currentStep: opts.snapshot.job.flowStep ?? null })] })
    : row;
  const order: string[] = [];
  const staleRows = [...(opts.staleRows ?? [])];
  const flows = {
    findById: vi.fn<IFleetFlowRepository['findById']>(async () => record),
    lockById: vi.fn<IFleetFlowRepository['lockById']>(async () => {
      order.push('flow');
      return opts.locked === null ? null : flow({ ...record, ...opts.locked });
    }),
    stop: vi.fn<IFleetFlowRepository['stop']>(async () => record),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => opts.snapshot ?? null),
    latestJob: vi.fn(async () => staleRows.shift() ?? opts.snapshot?.job ?? null),
    ingestSettled: vi.fn(async () => opts.settledApart ?? opts.snapshot?.ingestSettled ?? false),
    sumCost: vi.fn(async () => opts.sum ?? record.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => undefined),
    creatorAccess: vi.fn(async () => opts.creatorAccess ?? { exists: true, disabled: false }),
    listAdvanceable: vi.fn(async () => []),
    latestJobForStep: vi.fn<IFleetFlowStepRepository['latestJobForStep']>(async () => null),
  };
  const threads = {
    lockForFlowTransition: vi.fn(async () => {
      order.push('thread');
      return opts.threadMissing === true ? null : { id: 'thread-1', projectId: 'p1' };
    }),
  };
  const repos = {
    lockById: vi.fn(async () => {
      order.push('repo');
      return opts.repoMissing === true ? null : { id: 'repo-1', projectId: 'p1' };
    }),
    findReviewRepo: vi.fn(async () =>
      opts.reviewRepo === undefined ? { id: 'repo-1', projectId: 'p1', owner: 'o', name: 'r', githubInstallationId: 1n } : opts.reviewRepo),
  };
  const activity = { record: vi.fn<FleetActivityService['record']>(async () => undefined) };
  const audit = { record: vi.fn<AuditRecorder['record']>(async () => undefined) };
  let inTransaction = false;
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  }) };
  const jobs = { dispatch: vi.fn<(...args: Parameters<FleetJobsService['dispatch']>) => Promise<{ job: { id: string } }>>(async () => {
    expect(inTransaction).toBe(false);
    return { job: { id: 'j1' } };
  }), cancel: vi.fn() };
  const permissions = {
    effectiveKeys: vi.fn<PermissionService['effectiveKeys']>(async () => opts.creatorKeys ?? new Set(['fleet.job.dispatch'])),
  };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never,
    activity as never, audit as never, txManager as never, jobs as never, permissions as never,
  );
  /** Every write the pass could make; each AC's "writes nothing" claim holds over all of them. */
  const wrote = (): boolean => [
    flows.stop, steps.setSpent, steps.complete, steps.markStep, activity.record, audit.record,
  ].some((fn) => fn.mock.calls.length > 0);

  return { service, flows, steps, threads, repos, activity, audit, txManager, jobs, permissions, order, record, wrote,
    inTransaction: () => inTransaction };
}

describe('FleetFlowAdvanceService.advance, decide phase', () => {
  beforeEach(() => {
    decisions.inputs.length = 0;
  });

  it('AC-1: writes nothing for a PENDING flow', async () => {
    const h = build({ flow: { state: 'PENDING', approvedAt: null, approvalMode: null, approverId: null } });

    await h.service.advance('flow-1', NOW);

    expect(h.wrote()).toBe(false);
    expect(decisions.inputs).toEqual([]);
  });

  it('AC-2: writes nothing for a STOPPED flow', async () => {
    const h = build({ flow: { state: 'STOPPED', stopReason: 'human_stop', endedAt: NOW } });

    await h.service.advance('flow-1', NOW);

    expect(h.wrote()).toBe(false);
    expect(decisions.inputs).toEqual([]);
  });

  it('AC-3: locks the thread before the flow for a thread-entry flow', async () => {
    const h = build({ flow: { entry: 'THREAD', threadId: 'thread-1' } });

    await h.service.advance('flow-1', NOW);

    expect(h.order.slice(0, 2)).toEqual(['thread', 'flow']);
    expect(h.threads.lockForFlowTransition).toHaveBeenCalledWith('p1', 'thread-1');
    expect(h.repos.lockById).not.toHaveBeenCalled();
  });

  it('AC-4: locks the repo before the flow for a nax-entry flow', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.order.slice(0, 2)).toEqual(['repo', 'flow']);
    expect(h.repos.lockById).toHaveBeenCalledWith('repo-1');
    expect(h.threads.lockForFlowTransition).not.toHaveBeenCalled();
  });

  it('AC-5: writes nothing when the thread lock returns null', async () => {
    const h = build({ flow: { entry: 'THREAD', threadId: 'thread-1' }, threadMissing: true });

    await h.service.advance('flow-1', NOW);

    expect(h.wrote()).toBe(false);
    expect(h.flows.lockById).not.toHaveBeenCalled();
  });

  it('AC-6: stores a changed spend total inside fleet.flow-bookkeeping', async () => {
    const reasons: Array<string | undefined> = [];
    const h = build({ flow: { state: 'RUNNING' }, sum: '3.7500', snapshot: { job: job({ state: 'RUNNING' }), ingestSettled: false } });
    h.steps.setSpent.mockImplementation(async () => {
      reasons.push(currentBookkeepingReason());
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setSpent).toHaveBeenCalledWith('flow-1', '3.7500');
    expect(reasons).toEqual(['fleet.flow-bookkeeping']);
  });

  it('AC-7: leaves an unchanged spend total alone', async () => {
    const h = build({
      flow: { state: 'RUNNING', spentUsd: '3.7500' }, sum: '3.7500',
      snapshot: { job: job({ state: 'RUNNING' }), ingestSettled: false },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.sumCost).toHaveBeenCalledWith('flow-1');
    expect(h.steps.setSpent).not.toHaveBeenCalled();
  });

  it('AC-8: reads the repo and hands the PR number of a RUN result to the decision', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      snapshot: { job: job({ resultPrUrl: RUN_PR }), ingestSettled: false },
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.repos.findReviewRepo).toHaveBeenCalledWith('repo-1');
    expect(decisions.inputs.at(-1)?.latestJob?.prNumber).toBe(12);
  });

  it('AC-8: a RUN whose PR number cannot be read still stops once its ingest settles', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      snapshot: { job: job({ resultPrUrl: 'https://github.com/other/repo/pull/12' }), ingestSettled: true },
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(decisions.inputs.at(-1)?.latestJob?.prNumber).toBeNull();
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'run_no_pr', NOW, 'RUN ended without a PR');
  });

  it('F1: reads the repo for the authoritative RUN row, not for an unlocked snapshot', async () => {
    const withPr = job({ resultPrUrl: RUN_PR });
    // The interleaving the finding describes: an unlocked read before ingest filled the URL, an
    // authoritative read after it. Only the latter may drive the decision.
    const h = build({
      flow: { state: 'RUNNING' },
      staleRows: [job({ resultPrUrl: null })],
      snapshot: { job: withPr, ingestSettled: true },
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.latestJob).not.toHaveBeenCalled();
    expect(h.repos.findReviewRepo).toHaveBeenCalledWith('repo-1');
    expect(decisions.inputs.at(-1)?.latestJob?.prNumber).toBe(12);
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('F2: pairs the ingest status with a job row read in the same statement', async () => {
    const withPr = job({ resultPrUrl: RUN_PR });
    // A separate status read would answer "settled" while a separate row read still lacks the URL —
    // the pair that stopped a flow whose PR had just been recorded.
    const h = build({
      flow: { state: 'RUNNING' },
      staleRows: [job({ resultPrUrl: null })],
      settledApart: true,
      snapshot: { job: withPr, ingestSettled: true },
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.ingestSettled).not.toHaveBeenCalled();
    expect(h.steps.latestJob).not.toHaveBeenCalled();
    expect(h.steps.latestJobWithIngest).toHaveBeenCalledTimes(1);
    expect(decisions.inputs.at(-1)).toMatchObject({ ingestSettled: true, latestJob: { prNumber: 12 } });
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-9/AC-10/AC-11: a stop decision writes the stop, its activity and its audit entry', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      snapshot: {
        job: job({ flowStep: 'PLAN', command: 'PLAN', state: 'FAILED', stateReason: 'checkout failed' }),
        ingestSettled: false,
      },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'step_failed', NOW, 'PLAN job job-1 FAILED: checkout failed');
    expect(h.activity.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.stopped', entityType: 'flow', entityId: 'flow-1',
      projectId: 'p1',
      payload: {
        flowId: 'flow-1', stopReason: 'step_failed', detail: 'PLAN job job-1 FAILED: checkout failed',
        step: 'PLAN', jobId: 'job-1',
      },
    });
    expect(h.audit.record).toHaveBeenCalledWith({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: 'flow-1', projectId: 'p1',
      summary: expect.any(String),
    });
    expect(h.steps.complete).not.toHaveBeenCalled();
  });

  it('AC-9: keeps a stop detail within FLOW_STOP_DETAIL_MAX', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      snapshot: {
        job: job({ flowStep: 'PLAN', command: 'PLAN', state: 'FAILED', stateReason: 'x'.repeat(FLOW_STOP_DETAIL_MAX + 500) }),
        ingestSettled: false,
      },
    });

    await h.service.advance('flow-1', NOW);

    const detail: string = h.flows.stop.mock.calls[0][3] as string;
    expect(detail).toHaveLength(FLOW_STOP_DETAIL_MAX);
  });

  it('AC-12/AC-13: a complete decision completes the flow with its activity and audit entry', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      snapshot: { job: job({ flowStep: 'FIX', command: 'FIX', fixReady: { markedReady: true } }), ingestSettled: false },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.complete).toHaveBeenCalledWith('flow-1', NOW);
    expect(h.activity.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.completed', entityType: 'flow', entityId: 'flow-1',
      projectId: 'p1', payload: { flowId: 'flow-1', step: 'FIX', jobId: 'job-1' },
    });
    expect(h.audit.record).toHaveBeenCalledWith({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: 'flow-1', projectId: 'p1',
      summary: expect.any(String),
    });
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-14: a wait decision writes no step, stop or audit entry', async () => {
    const h = build({ flow: { state: 'RUNNING' }, snapshot: { job: job({ state: 'RUNNING' }), ingestSettled: false } });

    await h.service.advance('flow-1', NOW);

    expect(h.wrote()).toBe(false);
    expect(decisions.inputs.at(-1)).toMatchObject({ state: 'RUNNING', featureCount: 1 });
  });

  it('AC-15: writes nothing when the nax-entry repo row is gone at lock time', async () => {
    const h = build({ repoMissing: true });

    await h.service.advance('flow-1', NOW);

    expect(h.wrote()).toBe(false);
    expect(h.flows.lockById).not.toHaveBeenCalled();
  });

  it('writes nothing for a flow that no longer exists', async () => {
    const h = build();
    h.flows.findById.mockResolvedValue(null);

    await h.service.advance('flow-1', NOW);

    expect(h.wrote()).toBe(false);
    expect(h.txManager.run).not.toHaveBeenCalled();
  });

  it('re-reads the state under the flow lock and stops writing when the flow left the live states', async () => {
    const h = build({
      snapshot: { job: job({ flowStep: 'PLAN', command: 'PLAN', state: 'FAILED' }), ingestSettled: false },
      locked: { state: 'STOPPED' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it('builds the decision input from the locked flow and its latest job', async () => {
    const h = build({
      flow: { state: 'RUNNING', features: [feature({ prNumber: 7 })] },
      snapshot: {
        job: job({ flowStep: 'RUN', state: 'COMPLETED', resultPrUrl: RUN_PR, resultSha: 'c'.repeat(40) }),
        ingestSettled: true,
      },
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(decisions.inputs.at(-1)).toMatchObject({
      state: 'RUNNING', featureCount: 1, approvedAt: APPROVED_AT, now: NOW, featurePrNumber: 7, ingestSettled: true,
      latestJob: {
        id: 'job-1', step: 'RUN', state: 'COMPLETED', prNumber: 12, resultSha: 'c'.repeat(40),
        stateReason: null, agentOutput: null, fixReady: null,
      },
    });
    expect(decisions.inputs.at(-1)?.prWaitMs).toBeGreaterThan(0);
    expect(h.steps.latestJobWithIngest).toHaveBeenCalledWith('flow-1');
  });
});

function planPass() {
  return build({
    flow: { state: 'RUNNING', features: [feature({ state: 'RUNNING', currentStep: 'SPEC_REVIEW' })] },
    snapshot: { job: job({ flowStep: 'SPEC_REVIEW', ref: 'a'.repeat(40), agentResult: { status: 'completed', output: '{"findings":[]}' } }), ingestSettled: false },
  });
}

describe('FleetFlowAdvanceService.advance, dispatch and record', () => {
  it.each(['QUEUED', 'COMPLETED', 'FAILED'] as const)('F1/AC-14: does not recover stale spec A inserted after spec B reapproval (%s)', async (state) => {
    const h = build();
    const specA = h.record.specSha;
    const specB = 'd'.repeat(40);
    let current = h.record;
    let latest: LatestFlowJob | null = null;
    h.flows.findById.mockImplementation(async () => current);
    h.flows.lockById.mockImplementation(async () => current);
    h.steps.latestJobWithIngest.mockImplementation(async () => latest);
    h.steps.markStep.mockImplementation(async () => {
      current = flow({ ...current, state: 'RUNNING', features: [feature({ state: 'RUNNING', currentStep: 'SPEC_REVIEW' })] });
    });
    h.jobs.dispatch.mockImplementation(async (_actor, _project, body) => {
      expect(h.inTransaction()).toBe(false);
      if (body.ref === specA) {
        // Re-ask and approval happen during A's preflight, before its durable insert.
        current = flow({ specSha: specB, approvedAt: NOW });
        latest = { job: job({
          id: 'jA', command: 'AGENT', flowStep: 'SPEC_REVIEW', ref: specA,
          queuedAt: new Date(NOW.getTime() + 1), state,
          agentResult: { status: 'completed', output: '{"findings":[]}' },
        }), ingestSettled: false };
        return { job: { id: 'jA' } };
      }
      latest = { job: job({
        id: 'jB', command: 'AGENT', flowStep: 'SPEC_REVIEW', ref: specB,
        queuedAt: new Date(NOW.getTime() + 2), state: 'QUEUED',
      }), ingestSettled: false };
      return { job: { id: 'jB' } };
    });

    await h.service.advance('flow-1', NOW);
    expect(current).toMatchObject({ state: 'APPROVED', specSha: specB });
    expect(h.wrote()).toBe(false); // A's record phase must skip the new approval.

    await h.service.advance('flow-1', new Date(NOW.getTime() + 3));
    expect(h.jobs.dispatch.mock.calls.map(([, , body]) => body.ref)).toEqual([specA, specB]);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.step', payload: { step: 'SPEC_REVIEW', jobId: 'jB' },
    }));
    expect(h.activity.record).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.step', payload: { step: 'SPEC_REVIEW', jobId: 'jA' },
    }));
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.jobs.cancel).not.toHaveBeenCalled();

    // Even A's successful verdict must not start PLAN while B's review remains queued.
    await h.service.advance('flow-1', new Date(NOW.getTime() + 4));
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(['STOPPED', 'PENDING'] as const)('does not overwrite a concurrent %s when dispatch refuses', async (state) => {
    const h = planPass();
    h.jobs.dispatch.mockImplementation(async () => {
      h.flows.lockById.mockResolvedValue(flow({ state }));
      throw new ConflictAppException({}, 'fleet.jobs');
    });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(h.wrote()).toBe(false);
  });

  it.each(['missing parent', 'missing flow', 'new approval', 'new sha'] as const)('skips record for a %s', async (change) => {
    const h = build();
    h.jobs.dispatch.mockImplementation(async () => {
      if (change === 'missing parent') h.repos.lockById.mockResolvedValue(null);
      if (change === 'missing flow') h.flows.lockById.mockResolvedValue(null);
      if (change === 'new approval') h.flows.lockById.mockResolvedValue(flow({ approvedAt: NOW }));
      if (change === 'new sha') h.flows.lockById.mockResolvedValue(flow({ specSha: 'd'.repeat(40) }));
      return { job: { id: 'j1' } };
    });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(h.wrote()).toBe(false);
    expect(h.jobs.cancel).not.toHaveBeenCalled();
  });

  it('bounds a dispatch refusal in both the row and activity', async () => {
    const h = planPass();
    h.jobs.dispatch.mockRejectedValue(new ValidationAppException({ reason: 'x'.repeat(3000) }, 'fleet'));
    await h.service.advance('flow-1', NOW);
    const detail = `PLAN: ${'x'.repeat(3000)}`.slice(0, FLOW_STOP_DETAIL_MAX);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, detail);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ detail }) }));
  });

  it('never dispatches an unclaimed REVIEW', async () => {
    const h = build({ flow: { state: 'RUNNING' }, snapshot: { job: job({ resultPrUrl: RUN_PR }), ingestSettled: true } });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it('leaves multi-feature flows alone', async () => {
    const h = build({ flow: { features: [feature(), feature({ id: 'feature-2', position: 1 })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it('dispatch AC-1: sends exactly buildStepDispatch output on behalf of the creator outside a transaction', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', buildStepDispatch({
      flow: h.record, feature: h.record.features[0], step: 'SPEC_REVIEW',
      remainingCapUsd: '10.0000', reviewAgent: 'Explore',
    }), expect.any(Object));
  });

  it('dispatch AC-2: supplies the durable flow link and system audit key', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch.mock.calls[0]?.[3]).toEqual({
      flowId: 'flow-1', flowStep: 'SPEC_REVIEW', auditKey: 'system.flow.advance',
    });
  });

  it('dispatch AC-3: marks SPEC_REVIEW RUNNING inside the record transaction', async () => {
    const h = build();
    h.steps.markStep.mockImplementation(async () => { expect(h.inTransaction()).toBe(true); });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'SPEC_REVIEW', { flowState: 'RUNNING' });
    expect(h.order).toEqual(['repo', 'flow', 'repo', 'flow']);
  });

  it('dispatch AC-4: records flow.started with approval attribution as SYSTEM flow', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.activity.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.started', entityType: 'flow', entityId: 'flow-1',
      projectId: 'p1', payload: { approvalMode: 'REQUEST', approverId: 'u1' },
    });
  });

  it('dispatch AC-5: records the exact flow.step payload in the transaction', async () => {
    const h = build();
    h.activity.record.mockImplementation(async () => { expect(h.inTransaction()).toBe(true); });
    await h.service.advance('flow-1', NOW);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.step', payload: { step: 'SPEC_REVIEW', jobId: 'j1' },
    }));
  });

  it('dispatch AC-6: audits the flow write in the record transaction', async () => {
    const h = build();
    h.audit.record.mockImplementation(async () => { expect(h.inTransaction()).toBe(true); });
    await h.service.advance('flow-1', NOW);
    expect(h.audit.record).toHaveBeenCalledWith({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: 'flow-1', projectId: 'p1', summary: expect.any(String),
    });
  });

  it('dispatch AC-7: a RUNNING flow dispatches PLAN and records only flow.step', async () => {
    const h = planPass();
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', buildStepDispatch({
      flow: h.record, feature: h.record.features[0], step: 'PLAN', remainingCapUsd: '10.0000', reviewAgent: 'Explore',
    }), { flowId: 'flow-1', flowStep: 'PLAN', auditKey: 'system.flow.advance' });
    expect(h.activity.record.mock.calls.map(([entry]) => entry.action)).toEqual(['flow.step']);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ payload: { step: 'PLAN', jobId: 'j1' } }));
  });

  it.each([
    ['AC-8', new BudgetPausedException({ id: 'b1', scopeType: 'GLOBAL', scopeId: null, scopeKey: 'global' }), 'budget_paused', 'PLAN: BudgetPausedException'],
    ['AC-9', new ValidationAppException({ reason: 'specMissing' }, 'fleet'), 'dispatch_refused', 'PLAN: specMissing'],
    ['AC-10', new FleetDispatchException('tools'), 'dispatch_refused', 'PLAN: FleetDispatchException'],
    ['AC-11', new ConflictAppException({}, 'fleet.jobs'), 'dispatch_refused', 'PLAN: ConflictAppException'],
    ['AC-15 not-found', new NotFoundAppException({}, 'fleet.repos'), 'dispatch_refused', 'PLAN: NotFoundAppException'],
    ['AC-15 no reason', new ValidationAppException({}, 'fleet'), 'dispatch_refused', 'PLAN: ValidationAppException'],
    ['AC-15 non-string reason', new ValidationAppException({ reason: 42 }, 'fleet'), 'dispatch_refused', 'PLAN: ValidationAppException'],
  ])('dispatch %s: stops a known refusal with bounded detail', async (_ac, error, reason, detail) => {
    const h = planPass();
    h.jobs.dispatch.mockRejectedValue(error);
    h.flows.stop.mockImplementation(async () => { expect(h.inTransaction()).toBe(true); return h.record; });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', reason, NOW, detail);
    expect(h.steps.markStep).not.toHaveBeenCalled();
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.stopped' }));
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'system.flow.advance', resourceType: 'flow' }));
  });

  it('dispatch AC-12/AC-13: propagates unexpected errors without stopping', async () => {
    const h = planPass();
    const error = new Error('unavailable');
    h.jobs.dispatch.mockRejectedValue(error);
    await expect(h.service.advance('flow-1', NOW)).rejects.toBe(error);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it.each(['STOPPED', 'PENDING'] as const)('dispatch AC-14: leaves the job running when record sees %s', async (state) => {
    const h = build();
    h.jobs.dispatch.mockImplementation(async () => {
      h.flows.lockById.mockResolvedValue(flow({ state }));
      return { job: { id: 'j1' } };
    });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(h.flows.lockById).toHaveBeenCalledTimes(2);
    expect(h.wrote()).toBe(false);
    expect(h.jobs.cancel).not.toHaveBeenCalled();
  });

  it.each(['QUEUED', 'COMPLETED'] as const)('recovers an APPROVED SPEC_REVIEW at approvedAt (%s) without redispatch', async (state) => {
    const h = build({ snapshot: { job: job({ id: 'j1', flowStep: 'SPEC_REVIEW', ref: 'a'.repeat(40), queuedAt: APPROVED_AT, state }), ingestSettled: false } });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'SPEC_REVIEW', { flowState: 'RUNNING' });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.started' }));
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.step', payload: { step: 'SPEC_REVIEW', jobId: 'j1' } }));
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'system.flow.advance', resourceType: 'flow' }));
  });

  it('does not adopt a SPEC_REVIEW from an earlier approval', async () => {
    const h = build({ snapshot: { job: job({ flowStep: 'SPEC_REVIEW', ref: 'a'.repeat(40), queuedAt: new Date(APPROVED_AT.getTime() - 1) }), ingestSettled: false } });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('recovers missing RUNNING progress and does not duplicate the recovered activity on the next pass', async () => {
    const h = build({ flow: { state: 'RUNNING', features: [feature()] }, snapshot: { job: job({ id: 'j1', flowStep: 'PLAN', state: 'QUEUED' }), ingestSettled: false } });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'PLAN', { flowState: 'RUNNING' });
    h.flows.lockById.mockResolvedValue(flow({ state: 'RUNNING', features: [feature({ currentStep: 'PLAN', state: 'RUNNING' })] }));
    await h.service.advance('flow-1', NOW);
    expect(h.steps.markStep).toHaveBeenCalledTimes(1);
    expect(h.activity.record.mock.calls.map(([entry]) => entry.action)).toEqual(['flow.step']);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it.each(['PRD_REVIEW', 'RUN', 'FIX'] as const)('dispatches the exact %s body using durable PLAN/feature data', async (step) => {
    const plan = job({ flowStep: 'PLAN', resultBranch: 'plan/branch', resultSha: 'c'.repeat(40) });
    const previous = step === 'PRD_REVIEW' ? plan : step === 'RUN'
      ? job({ flowStep: 'PRD_REVIEW', agentResult: { status: 'completed', output: '{"findings":[]}' } })
      : job({ flowStep: 'REVIEW' });
    const h = build({
      flow: { state: 'RUNNING', pinnedRunnerId: 'pinned', features: [feature({ state: 'RUNNING', currentStep: previous.flowStep ?? null, prNumber: 12 })] },
      snapshot: { job: previous, ingestSettled: false },
    });
    h.steps.latestJobForStep.mockResolvedValue(plan);
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', buildStepDispatch({
      flow: h.record, feature: h.record.features[0], step, remainingCapUsd: '10.0000', reviewAgent: 'Explore',
      plan, ...(step === 'FIX' ? { pr: { number: 12 } } : {}),
    }), { flowId: 'flow-1', flowStep: step, auditKey: 'system.flow.advance' });
    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', step,
      { flowState: 'RUNNING', ...(step === 'FIX' ? { prNumber: 12 } : {}) });
  });

  it('US-014 AC-1/AC-2: stops at an exhausted cap without dispatching', async () => {
    const h = build({ flow: { costCapUsd: '5.0000', spentUsd: '0.0000' }, sum: '5.0000' });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'cost_cap', NOW, 'spent 5.0000 of cap 5.0000');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('US-014 AC-3: dispatches with the freshly recomputed remaining cap', async () => {
    const h = build({ flow: { costCapUsd: '5' }, sum: '3.5000' });
    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch.mock.calls[0]?.[2].maxCostUsd).toBe(1.5);
  });

  it.each([
    ['disabled creator', { exists: true, disabled: true }],
    ['missing creator', { exists: false, disabled: false }],
  ] as const)('US-014 %s: stops without dispatch', async (_label, creatorAccess) => {
    const h = build({ creatorAccess });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'creator_lost_access', NOW, expect.any(String));
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('US-014 AC-6/AC-7: stops when the creator lacks the project dispatch key', async () => {
    const h = build({ creatorKeys: new Set(['project.read']) });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'creator_lost_access', NOW, expect.any(String));
    expect(h.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('US-014 AC-8: checks cap before creator access', async () => {
    const h = build({ flow: { costCapUsd: '5.0000' }, sum: '5.0000', creatorAccess: { exists: true, disabled: true } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'cost_cap', NOW, 'spent 5.0000 of cap 5.0000');
    expect(h.steps.creatorAccess).not.toHaveBeenCalled();
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });
});
