import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { FlowStepInput } from './flow-step-decision';
import { FLOW_STOP_DETAIL_MAX } from './flow-steps';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';

/**
 * The decide phase's boundary is `decideFlowStep`, so the pass's input is what these tests can check
 * for the parts a decision does not write (US-012 writes stops and completions only). The wrapper
 * records the input and delegates, so every other assertion still runs the real decision engine.
 */
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
  latest?: FleetJobRecord | null;
  sum?: string;
  ingestSettled?: boolean;
  threadMissing?: boolean;
  repoMissing?: boolean;
  reviewRepo?: { owner: string; name: string } | null;
}

function build(opts: HarnessOptions = {}) {
  const record = flow(opts.flow);
  const order: string[] = [];
  const flows = {
    findById: vi.fn(async () => record),
    lockById: vi.fn(async () => {
      order.push('flow');
      return opts.locked === null ? null : flow({ ...opts.flow, ...opts.locked });
    }),
    stop: vi.fn(async () => record),
  };
  const steps = {
    latestJob: vi.fn(async () => opts.latest ?? null),
    sumCost: vi.fn(async () => opts.sum ?? record.spentUsd),
    setSpent: vi.fn(async () => undefined),
    ingestSettled: vi.fn(async () => opts.ingestSettled ?? false),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => undefined),
    creatorAccess: vi.fn(),
    listAdvanceable: vi.fn(async () => []),
    latestJobForStep: vi.fn(async () => null),
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
  const activity = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => fn()) };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never,
    activity as never, audit as never, txManager as never,
  );
  /** Every write the pass could make; each AC's "writes nothing" claim holds over all of them. */
  const wrote = (): boolean => [
    flows.stop, steps.setSpent, steps.complete, steps.markStep, activity.record, audit.record,
  ].some((fn) => fn.mock.calls.length > 0);

  return { service, flows, steps, threads, repos, activity, audit, txManager, order, record, wrote };
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

    expect(h.order).toEqual(['thread', 'flow']);
    expect(h.threads.lockForFlowTransition).toHaveBeenCalledWith('p1', 'thread-1');
    expect(h.repos.lockById).not.toHaveBeenCalled();
  });

  it('AC-4: locks the repo before the flow for a nax-entry flow', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.order).toEqual(['repo', 'flow']);
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
    const h = build({ flow: { state: 'RUNNING' }, sum: '3.7500', latest: job({ state: 'RUNNING' }) });
    h.steps.setSpent.mockImplementation(async () => {
      reasons.push(currentBookkeepingReason());
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setSpent).toHaveBeenCalledWith('flow-1', '3.7500');
    expect(reasons).toEqual(['fleet.flow-bookkeeping']);
  });

  it('AC-7: leaves an unchanged spend total alone', async () => {
    const h = build({ flow: { state: 'RUNNING', spentUsd: '3.7500' }, sum: '3.7500', latest: job({ state: 'RUNNING' }) });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.sumCost).toHaveBeenCalledWith('flow-1');
    expect(h.steps.setSpent).not.toHaveBeenCalled();
  });

  it('AC-8: reads the repo and hands the PR number of a RUN result to the decision', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      latest: job({ resultPrUrl: 'https://github.com/o/r/pull/12' }),
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.repos.findReviewRepo).toHaveBeenCalledWith('repo-1');
    expect(decisions.inputs.at(-1)?.latestJob?.prNumber).toBe(12);
  });

  it('AC-8: a RUN whose PR number cannot be read still stops once its ingest settles', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      latest: job({ resultPrUrl: 'https://github.com/other/repo/pull/12' }),
      reviewRepo: { owner: 'o', name: 'r' },
      ingestSettled: true,
    });

    await h.service.advance('flow-1', NOW);

    expect(decisions.inputs.at(-1)?.latestJob?.prNumber).toBeNull();
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'run_no_pr', NOW, 'RUN ended without a PR');
  });

  it('AC-9/AC-10/AC-11: a stop decision writes the stop, its activity and its audit entry', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      latest: job({ flowStep: 'PLAN', command: 'PLAN', state: 'FAILED', stateReason: 'checkout failed' }),
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
      latest: job({ flowStep: 'PLAN', command: 'PLAN', state: 'FAILED', stateReason: 'x'.repeat(FLOW_STOP_DETAIL_MAX + 500) }),
    });

    await h.service.advance('flow-1', NOW);

    const detail: string = h.flows.stop.mock.calls[0][3] as string;
    expect(detail).toHaveLength(FLOW_STOP_DETAIL_MAX);
  });

  it('AC-12/AC-13: a complete decision completes the flow with its activity and audit entry', async () => {
    const h = build({
      flow: { state: 'RUNNING' },
      latest: job({ flowStep: 'FIX', command: 'FIX', fixReady: { markedReady: true } }),
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
    const h = build({ flow: { state: 'RUNNING' }, latest: job({ state: 'RUNNING' }) });

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
    const h = build({ latest: job({ flowStep: 'PLAN', command: 'PLAN', state: 'FAILED' }), locked: { state: 'STOPPED' } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it('builds the decision input from the locked flow and its latest job', async () => {
    const h = build({
      flow: { state: 'RUNNING', features: [feature({ prNumber: 7 })] },
      latest: job({ flowStep: 'RUN', state: 'COMPLETED', resultPrUrl: 'https://github.com/o/r/pull/12', resultSha: 'c'.repeat(40) }),
      reviewRepo: { owner: 'o', name: 'r' },
    });

    await h.service.advance('flow-1', NOW);

    expect(decisions.inputs.at(-1)).toMatchObject({
      state: 'RUNNING', featureCount: 1, approvedAt: APPROVED_AT, now: NOW, featurePrNumber: 7,
      latestJob: {
        id: 'job-1', step: 'RUN', state: 'COMPLETED', prNumber: 12, resultSha: 'c'.repeat(40),
        stateReason: null, agentOutput: null, fixReady: null,
      },
    });
    expect(decisions.inputs.at(-1)?.prWaitMs).toBeGreaterThan(0);
    expect(h.steps.ingestSettled).toHaveBeenCalledWith('job-1', 2);
  });
});
