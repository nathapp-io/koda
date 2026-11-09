import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { LatestFlowJob } from './domain/fleet-flow-step.domain';
import type { CallsOutcome, FleetFlowCallsService } from './fleet-flow-calls.service';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * US-010: the set's `SPEC_REVIEW` findings are committed spec by spec. Every feature's own findings
 * go into its own spec, in position order, each commit on top of the previous one on the flow
 * branch. The markers, the shas and the activity are written once, under the locks, after the last
 * commit.
 */
const NOW = new Date('2026-11-07T12:30:00.000Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00.000Z');
const SPEC_A = '.nax/features/a/spec.md';
const SPEC_B = '.nax/features/b/spec.md';
const BRANCH = 'feat/flow';
const SPEC_SHA = 'a'.repeat(40);
const JOB_ID = 'job-1';

const FINDING_A = { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it', feature: 'a' } as const;
const FINDING_B = { id: 'F2', class: 'minor', summary: 'Missing edge case', fix: 'add it', feature: 'b' } as const;

const featureA = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-a', flowId: 'flow-1', position: 0, feature: 'a', specPath: SPEC_A,
  dependsOn: [], state: 'RUNNING', currentStep: 'SPEC_REVIEW', prNumber: null, ...over,
});

const featureB = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-b', flowId: 'flow-1', position: 1, feature: 'b', specPath: SPEC_B,
  dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: BRANCH, specSha: SPEC_SHA, setSha: SPEC_SHA,
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT,
  features: [featureA(), featureB()], ...over,
});

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: JOB_ID, projectId: 'p1', repoId: 'repo-1', ref: SPEC_SHA, command: 'AGENT', feature: 'a',
  planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date('2026-11-07T12:05:00.000Z'), assignedAt: null, startedAt: null,
  finishedAt: new Date('2026-11-07T12:20:00.000Z'), cancelRequestedAt: null,
  naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', costCarriedUsd: '0.0000', firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: BRANCH, resultSha: 'review-sha',
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'SPEC_REVIEW', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW,
  agentResult: { status: 'completed', output: '{"findings":[]}', truncated: false, deniedAsks: [], deniedAsksTruncated: false },
  ...over,
} as FleetJobRecord);

/** The verdict of the set review: the findings it names, one per feature. */
const verdict = (findings: readonly unknown[]): string => JSON.stringify({ findings, prdEdits: [] });

interface Options {
  flow?: Partial<FleetFlowRecord>;
  features?: FleetFlowFeatureRecord[];
  findings?: readonly unknown[];
  /** The outcome of every `calls.apply` call, in call order. */
  applyOutcome?: (index: number) => CallsOutcome;
  /** The number of `SPEC_REVIEW` jobs of the first feature since the approval. */
  specReviewCount?: number;
}

function build(opts: Options = {}) {
  const row = flow({ features: opts.features ?? [featureA(), featureB()], ...opts.flow });
  const findings = opts.findings ?? [FINDING_A, FINDING_B];
  const snapshot: LatestFlowJob = {
    job: job({ agentResult: { status: 'completed', output: verdict(findings), truncated: false, deniedAsks: [], deniedAsksTruncated: false } }),
    ingestSettled: true,
  };
  let inTransaction = false;
  const assertTx = () => { expect(inTransaction).toBe(true); };
  const flows = {
    findById: vi.fn(async () => row),
    lockById: vi.fn(async () => { assertTx(); return row; }),
    stop: vi.fn(async () => { assertTx(); return row; }),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async (_flowId: string, featureId: string) =>
      (featureId === 'feature-a' ? snapshot : null)),
    latestJobForStep: vi.fn(async () => null),
    countJobsForStepSince: vi.fn(async (_flowId: string, _featureId: string, step: string) =>
      (step === 'SPEC_REVIEW' ? (opts.specReviewCount ?? 0) : 0)),
    sumCost: vi.fn(async () => row.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }),
    creatorAccess: vi.fn(async () => { assertTx(); return { exists: true, disabled: false }; }),
    setBranch: vi.fn(async () => { assertTx(); }),
    recordCalls: vi.fn(async (
      _flowId: string, featureId: string, jobId: string, specSha: string | null,
      options?: { setSha?: boolean },
    ) => {
      assertTx();
      const target = row.features.find((item) => item.id === featureId);
      if (target) target.callsJobId = jobId;
      if (specSha !== null) {
        row.specSha = specSha;
        if (options?.setSha) row.setSha = specSha;
      }
    }),
    recordPrdEdits: vi.fn(async () => { assertTx(); }),
    recordRulings: vi.fn(async () => { assertTx(); }),
    setWaiting: vi.fn(async () => { assertTx(); }),
    projectSlug: vi.fn(async () => 'web'),
  };
  const repos = {
    lockById: vi.fn(async () => { assertTx(); return { id: row.repoId }; }),
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
  const jobs = { dispatch: vi.fn<(...args: Parameters<FleetJobsService['dispatch']>) => Promise<{ job: { id: string } }>>(async () => {
    expect(inTransaction).toBe(false); return { job: { id: 'next-job' } };
  }) };
  const permissions = { effectiveKeys: vi.fn(async () => {
    assertTx(); return new Set(['fleet.job.dispatch']);
  }) };
  const flowService = { reaskLocked: vi.fn(async () => { assertTx(); return row; }) };
  const github = {
    mintReadOnlyToken: vi.fn(async () => { expect(inTransaction).toBe(false); return { token: 'test-only', expiresAt: NOW }; }),
    getBranchHead: vi.fn(async () => { expect(inTransaction).toBe(false); return row.specSha; }),
  };
  let applyIndex = 0;
  const calls = {
    apply: vi.fn<FleetFlowCallsService['apply']>(async () => {
      expect(inTransaction).toBe(false);
      const index = applyIndex;
      applyIndex += 1;
      return opts.applyOutcome
        ? opts.applyOutcome(index)
        : { kind: 'committed', specSha: `commit-${index + 1}` };
    }),
    applyPrdEdits: vi.fn(async () => {
      expect(inTransaction).toBe(false);
      return { kind: 'unchanged', refused: [] };
    }),
  };
  const outbox = { record: vi.fn(async () => { assertTx(); }) };
  const rulings = {
    ruledItemIds: vi.fn(async () => []),
    createForFlow: vi.fn(async () => ({ kind: 'recorded' as const, rulingId: 'ruling-1' })),
    commentRefused: vi.fn(async () => { assertTx(); }),
  };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never, activity as never, audit as never,
    txManager as never, jobs as never, permissions as never, flowService as never, github as never,
    { claimHead: vi.fn(), markDispatched: vi.fn(), release: vi.fn() } as never, testFleetConfig(),
    calls as never, outbox as never, rulings as never,
  );
  return { service, row, flows, steps, repos, activity, audit, txManager, jobs, permissions, flowService,
    github, calls, outbox, rulings };
}

describe('FleetFlowAdvanceService.advance, the set SPEC_REVIEW calls', () => {
  it('AC-1: commits each feature own spec, every commit on top of the previous one', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledTimes(2);
    expect(h.calls.apply.mock.calls[0]).toEqual([
      h.row,
      { kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: JOB_ID, findings: [FINDING_A] },
      SPEC_SHA,
      { feature: 'a', specPath: SPEC_A, branch: BRANCH },
    ]);
    expect(h.calls.apply.mock.calls[1]).toEqual([
      h.row,
      { kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: JOB_ID, findings: [FINDING_B] },
      'commit-1',
      { feature: 'b', specPath: SPEC_B, branch: BRANCH },
    ]);
  });

  it('AC-2: every call targets the flow branch and carries only its own findings', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    const targets = h.calls.apply.mock.calls.map((call) => call[3]);
    expect(targets).toEqual([
      { feature: 'a', specPath: SPEC_A, branch: BRANCH },
      { feature: 'b', specPath: SPEC_B, branch: BRANCH },
    ]);
    expect(h.calls.apply.mock.calls[0]?.[1].findings).toEqual([FINDING_A]);
    expect(h.calls.apply.mock.calls[1]?.[1].findings).toEqual([FINDING_B]);
  });

  it('AC-3: a finding without a feature, or with an unknown one, goes into the first spec', async () => {
    const missing = { id: 'F1', class: 'minor', summary: 'No feature named', fix: 'fix it' };
    const unknown = { id: 'F2', class: 'minor', summary: 'Unknown feature named', fix: 'fix it', feature: 'zzz' };
    const h = build({ findings: [missing, unknown] });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: JOB_ID, findings: [missing, unknown],
    }, SPEC_SHA, { feature: 'a', specPath: SPEC_A, branch: BRANCH });
  });

  it('AC-4: records the marker of every target feature and promotes both shas on the last commit', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.steps.recordCalls).toHaveBeenCalledTimes(2);
    expect(h.steps.recordCalls.mock.calls[0]).toEqual(['flow-1', 'feature-a', JOB_ID, null]);
    expect(h.steps.recordCalls.mock.calls[1]).toEqual(['flow-1', 'feature-b', JOB_ID, 'commit-2', { setSha: true }]);
    expect(h.row.features[0]?.callsJobId).toBe(JOB_ID);
    expect(h.row.specSha).toBe('commit-2');
    expect(h.row.setSha).toBe('commit-2');
  });

  it('AC-5: a failed first commit stops the flow and never reaches the second spec', async () => {
    const h = build({ applyOutcome: () => ({ kind: 'failed', detail: 'spec write refused' }) });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.flows.stop).toHaveBeenCalledExactlyOnceWith('flow-1', 'calls_failed', NOW, 'SPEC_REVIEW: spec write refused');
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
  });

  it('AC-6: a retry writes no progress and the next pass starts at the first feature again', async () => {
    const h = build({
      applyOutcome: (index) => (index % 2 === 0
        ? { kind: 'committed', specSha: `commit-${index + 1}` }
        : { kind: 'retry' }),
    });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledTimes(2);
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledTimes(4);
    expect(h.calls.apply.mock.calls[2]?.[2]).toBe(SPEC_SHA);
    expect(h.calls.apply.mock.calls[2]?.[3]).toEqual({ feature: 'a', specPath: SPEC_A, branch: BRANCH });
  });

  it('a stale head re-asks the flow and never reaches the next spec', async () => {
    const h = build({ applyOutcome: () => ({ kind: 'stale', head: 'external' }) });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.flowService.reaskLocked).toHaveBeenCalledExactlyOnceWith(h.row, 'external', NOW);
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-7: a pass whose findings all target b commits only b and still marks the first feature', async () => {
    const h = build({ findings: [FINDING_B] });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: JOB_ID, findings: [FINDING_B],
    }, SPEC_SHA, { feature: 'b', specPath: SPEC_B, branch: BRANCH });
    expect(h.steps.recordCalls.mock.calls[0]).toEqual(['flow-1', 'feature-a', JOB_ID, null]);
    expect(h.steps.recordCalls.mock.calls[1]).toEqual(['flow-1', 'feature-b', JOB_ID, 'commit-1', { setSha: true }]);
    expect(h.row.features[0]?.callsJobId).toBe(JOB_ID);
  });

  it('AC-7: the marker moves the flow past the review without reapplying its calls', async () => {
    const h = build({ findings: [FINDING_B], specReviewCount: 1 });

    await h.service.advance('flow-1', NOW);
    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'AGENT' }),
      expect.objectContaining({ flowStep: 'SPEC_REVIEW' }));
  });

  it('AC-7: a second set review round ends in PLAN', async () => {
    const h = build({ findings: [FINDING_B], specReviewCount: 2 });

    await h.service.advance('flow-1', NOW);
    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledOnce();
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'PLAN' }),
      expect.objectContaining({ flowStep: 'PLAN' }));
  });

  it('AC-8: a single-feature pass applies the calls once, on the flow branch', async () => {
    const finding = { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' };
    const h = build({
      findings: [finding],
      features: [featureA({ feature: 'f', specPath: '.nax/features/f/spec.md' })],
    });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: JOB_ID, findings: [finding],
    }, SPEC_SHA, { feature: 'f', specPath: '.nax/features/f/spec.md', branch: BRANCH });
    expect(h.steps.recordCalls).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-a', JOB_ID, 'commit-1', { setSha: true });
  });
});
