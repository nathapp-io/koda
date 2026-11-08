import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { HeadClaim } from '../reviews/fleet-review-claim.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { buildStepDispatch } from './flow-step-dispatch';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * US-016: the `REVIEW` step reaches the head claim before it dispatches, adopts a head that already
 * has a job, and releases its claim on every dispatch error. The rest of `advance` is pinned by
 * `fleet-flow-advance.service.spec.ts`; this file carries only the REVIEW pass it needs.
 */
const NOW = new Date('2026-11-07T12:30:00.000Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00.000Z');
const RUN_PR = 'https://github.com/o/r/pull/12';
/** The head the `RUN` pushed: the claim key. */
const REVIEW_HEAD = 'h1';

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: '.nax/features/f/spec.md',
  dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/f', specSha: 'a'.repeat(40),
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT,
  features: [feature({ state: 'RUNNING', currentStep: 'RUN', prNumber: 12 })], ...over,
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
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: 'feat/f', resultSha: REVIEW_HEAD,
  resultPrUrl: RUN_PR, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'RUN', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW, ...over,
} as FleetJobRecord);

interface Options {
  /**
   * The row each successive flow lock returns, layered over the unlocked row: index 0 is the decide-phase
   * lock, index 1 the record-phase lock. Missing indexes fall back to the unlocked row.
   */
  locks?: ReadonlyArray<Partial<FleetFlowRecord>>;
  /** The latest job with the ingest status of its own lease. */
  latest?: FleetJobRecord;
  /** What the head claim answers. */
  claim?: HeadClaim;
}

/** A `RUNNING` flow whose `RUN` pushed PR 12 at `REVIEW_HEAD`, so the decision is `dispatch REVIEW`. */
function build(opts: Options = {}) {
  const record = flow();
  const latest = opts.latest ?? job();
  let inTransaction = false;
  let lockCount = 0;
  const order: string[] = [];
  const flows = {
    findById: vi.fn(async () => record),
    lockById: vi.fn(async () => {
      const over = opts.locks?.[lockCount] ?? {};
      lockCount += 1;
      return flow({ ...record, ...over });
    }),
    stop: vi.fn(async () => record),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => ({ job: latest, ingestSettled: true })),
    sumCost: vi.fn(async () => record.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { order.push('markStep'); }),
    creatorAccess: vi.fn(async () => ({ exists: true, disabled: false })),
    listAdvanceable: vi.fn(async () => []),
    countJobsForStepSince: vi.fn(async () => 0),
    recordCalls: vi.fn(async () => undefined),
    latestJobForStep: vi.fn(async () => null),
  };
  const threads = { lockForFlowTransition: vi.fn(async () => null) };
  const repos = {
    lockById: vi.fn(async () => ({ id: 'repo-1', projectId: 'p1' })),
    findReviewRepo: vi.fn(async () => ({ id: 'repo-1', projectId: 'p1', owner: 'o', name: 'r', githubInstallationId: 1n })),
  };
  const activity = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  }) };
  const dispatch = vi.fn(async () => {
    expect(inTransaction).toBe(false);
    return { job: { id: 'j3' } };
  });
  const adoptForFlow = vi.fn(async () => {
    expect(inTransaction).toBe(true);
    return true;
  });
  const reviews = {
    claimHead: vi.fn(async (): Promise<HeadClaim> => {
      expect(inTransaction).toBe(false);
      return opts.claim ?? { kind: 'claimed', claimId: 'c1' };
    }),
    markDispatched: vi.fn(async () => undefined),
    release: vi.fn(async () => { order.push('release'); }),
  };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never, activity as never, audit as never,
    txManager as never, { dispatch, adoptForFlow, cancel: vi.fn() } as never,
    { effectiveKeys: vi.fn(async () => new Set(['fleet.job.dispatch'])) } as never,
    { reaskLocked: vi.fn(async () => record) } as never,
    { mintReadOnlyToken: vi.fn(async () => ({ token: 'test-only-token', expiresAt: NOW })), getBranchHead: vi.fn(async () => record.specSha) } as never,
    reviews as never, testFleetConfig(), { apply: vi.fn() } as never, { record: vi.fn() } as never,
    { ruledItemIds: vi.fn(async () => []), createForFlow: vi.fn(), commentRefused: vi.fn() } as never,
  );
  /** Every write the pass could make; each "writes nothing" claim holds over all of them. */
  const wrote = (): boolean => [
    flows.stop, steps.setSpent, steps.complete, steps.markStep, activity.record, audit.record,
    reviews.markDispatched, reviews.release,
  ].some((fn) => fn.mock.calls.length > 0);
  const reviewBody = (): ReturnType<typeof buildStepDispatch> => buildStepDispatch({
    flow: record, feature: record.features[0], step: 'REVIEW', remainingCapUsd: '10.0000', reviewAgent: 'Explore',
    pr: { number: 12 },
  });

  return {
    service, flows, steps, repos, activity, audit, reviews, order, record, wrote, reviewBody,
    dispatch, adoptForFlow, inTransaction: () => inTransaction,
  };
}

const conflicted = () => new ConflictAppException({}, 'fleet.jobs');
const paused = () => new BudgetPausedException({ id: 'b1', scopeType: 'GLOBAL', scopeId: null, scopeKey: 'global' });

describe('FleetFlowAdvanceService.advance, REVIEW through the head claim', () => {
  it('AC-1: claims the RUN head outside the dispatch transaction', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.claimHead).toHaveBeenCalledWith('repo-1', 12, REVIEW_HEAD, NOW);
  });

  it('AC-2: a claimed head dispatches the REVIEW body with flowStep REVIEW', async () => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });

    await h.service.advance('flow-1', NOW);

    expect(h.dispatch).toHaveBeenCalledWith('u1', 'p1', h.reviewBody(), {
      flowId: 'flow-1', flowStep: 'REVIEW', auditKey: 'system.flow.advance',
    });
    expect(h.reviews.claimHead.mock.invocationCallOrder[0])
      .toBeLessThan(h.dispatch.mock.invocationCallOrder[0]);
  });

  it('AC-3: links the claim to the job the dispatch returned', async () => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.markDispatched).toHaveBeenCalledWith('c1', 'j3');
    expect(h.reviews.markDispatched.mock.invocationCallOrder[0])
      .toBeGreaterThan(h.dispatch.mock.invocationCallOrder[0]);
  });

  it('AC-4: records the REVIEW step with the PR number in the record transaction', async () => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });
    h.steps.markStep.mockImplementation(async () => { expect(h.inTransaction()).toBe(true); });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'REVIEW', {
      flowState: 'RUNNING', prNumber: 12,
    });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.step', payload: { step: 'REVIEW', jobId: 'j3' },
    }));
  });

  it('AC-5: an owned head adopts the existing job in the record phase and dispatches nothing', async () => {
    const h = build({ claim: { kind: 'owned', jobId: 'j9' } });

    await h.service.advance('flow-1', NOW);

    expect(h.adoptForFlow).toHaveBeenCalledWith('j9', 'flow-1', 'REVIEW');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.reviews.markDispatched).not.toHaveBeenCalled();
  });

  it('AC-6: after the adoption it records the step, flow.step and the audit entry', async () => {
    const h = build({ claim: { kind: 'owned', jobId: 'j9' } });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'REVIEW', {
      flowState: 'RUNNING', prNumber: 12,
    });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.step', payload: { step: 'REVIEW', jobId: 'j9' },
    }));
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: 'flow-1', projectId: 'p1',
    }));
  });

  it('AC-7: an owned head does not adopt when the flow stopped before the record phase', async () => {
    // The decide-phase lock still sees the live flow (so the head is claimed); the record-phase lock sees the stop.
    const h = build({ claim: { kind: 'owned', jobId: 'j9' }, locks: [{}, { state: 'STOPPED' }] });

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.claimHead).toHaveBeenCalledWith('repo-1', 12, REVIEW_HEAD, NOW);
    expect(h.flows.lockById).toHaveBeenCalledTimes(2); // The decide lock, then the record lock.
    expect(h.adoptForFlow).not.toHaveBeenCalled();
    expect(h.steps.markStep).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it('AC-8: a head another flow already adopted stops as dispatch_refused', async () => {
    const h = build({ claim: { kind: 'owned', jobId: 'j9' } });
    h.adoptForFlow.mockResolvedValue(false);

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'REVIEW: head claimed by another flow');
    expect(h.steps.markStep).not.toHaveBeenCalled();
  });

  it('AC-9: a busy head waits without dispatching, stepping or stopping', async () => {
    const h = build({ claim: { kind: 'busy' } });

    await h.service.advance('flow-1', NOW);

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.adoptForFlow).not.toHaveBeenCalled();
    expect(h.wrote()).toBe(false);
  });

  it('AC-10: a failed head stops as dispatch_refused with its outcome', async () => {
    const h = build({ claim: { kind: 'failed', outcome: 'failed:repo gone' } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'REVIEW: failed:repo gone');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.stopped' }));
  });

  it('AC-11: releases the claim before stopping on a conflict', async () => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });
    h.dispatch.mockRejectedValue(conflicted());
    h.flows.stop.mockImplementation(async () => {
      expect(h.inTransaction()).toBe(true);
      h.order.push('stop');
      return h.record;
    });

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.release).toHaveBeenCalledWith('c1');
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'REVIEW: ConflictAppException');
    expect(h.order).toEqual(['release', 'stop']);
    expect(h.steps.markStep).not.toHaveBeenCalled();
    expect(h.reviews.markDispatched).not.toHaveBeenCalled();
  });

  it('AC-12: releases the claim before stopping on a paused budget', async () => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });
    h.dispatch.mockRejectedValue(paused());
    h.steps.markStep.mockImplementation(async () => { h.order.push('markStep'); });
    h.flows.stop.mockImplementation(async () => { h.order.push('stop'); return h.record; });

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.release).toHaveBeenCalledWith('c1');
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'budget_paused', NOW, 'REVIEW: BudgetPausedException');
    expect(h.order).toEqual(['release', 'stop']);
  });

  it('AC-13: releases the claim before rethrowing an unexpected error', async () => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });
    const error = new Error('unavailable');
    h.dispatch.mockRejectedValue(error);

    await expect(h.service.advance('flow-1', NOW)).rejects.toBe(error);

    expect(h.reviews.release).toHaveBeenCalledWith('c1');
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.steps.markStep).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.reviews.markDispatched).not.toHaveBeenCalled();
  });

  it.each([
    ['validation', new ValidationAppException({ reason: 'specMissing' }, 'fleet'), 'REVIEW: specMissing'],
    ['not-found', new NotFoundAppException({}, 'fleet.repos'), 'REVIEW: NotFoundAppException'],
    ['dispatch', new FleetDispatchException('tools'), 'REVIEW: FleetDispatchException'],
  ])('AC-14: releases the claim before the dispatch_refused stop (%s)', async (_label, error, detail) => {
    const h = build({ claim: { kind: 'claimed', claimId: 'c1' } });
    h.dispatch.mockRejectedValue(error);

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.release).toHaveBeenCalledWith('c1');
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, detail);
    expect(h.reviews.release.mock.invocationCallOrder[0])
      .toBeLessThan(h.flows.stop.mock.invocationCallOrder[0]);
  });

  it('stops without claiming a head when RUN ingest settled without a pushed sha', async () => {
    const h = build({ latest: job({ resultSha: null }) });

    await h.service.advance('flow-1', NOW);

    expect(h.reviews.claimHead).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'run_no_pr', NOW, 'RUN PR has no result sha for REVIEW');
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.stopped' }));
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'system.flow.advance' }));
  });
});
