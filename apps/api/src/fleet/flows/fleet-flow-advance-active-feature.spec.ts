import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { LatestFlowJob } from './domain/fleet-flow-step.domain';
import type { CallsOutcome, FleetFlowCallsService, PrdEditsOutcome } from './fleet-flow-calls.service';
import type { FlowStepInput } from './flow-step-decision';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * US-008: the advance service runs the feature the flow has active, not the first row of the
 * feature list. The set's `SPEC_REVIEW` belongs to the first feature; every later feature plans on
 * its own branch, reads its own jobs and answers with its own ids.
 */
const NOW = new Date('2026-11-07T12:30:00.000Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00.000Z');
const SPEC_A = '.nax/features/a/spec.md';
const SPEC_B = '.nax/features/b/spec.md';
const PLAN_SHA = 'plan-sha';

/** Observe the decision inputs and the dispatch inputs while the real engines run. */
const observed = vi.hoisted(() => ({ decisions: [] as FlowStepInput[], dispatchInputs: [] as unknown[] }));
vi.mock('./flow-step-decision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flow-step-decision')>();
  return {
    ...actual,
    decideFlowStep: (input: FlowStepInput) => {
      observed.decisions.push(input);
      return actual.decideFlowStep(input);
    },
  };
});
vi.mock('./flow-step-dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flow-step-dispatch')>();
  return {
    ...actual,
    buildStepDispatch: (input: Parameters<typeof actual.buildStepDispatch>[0]) => {
      observed.dispatchInputs.push(input);
      return actual.buildStepDispatch(input);
    },
  };
});

const featureA = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-a', flowId: 'flow-1', position: 0, feature: 'a', specPath: SPEC_A,
  dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

const featureB = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-b', flowId: 'flow-1', position: 1, feature: 'b', specPath: SPEC_B,
  dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/a', specSha: 'a'.repeat(40),
  setSha: 'a'.repeat(40),
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT,
  features: [featureA(), featureB()], ...over,
});

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'feat/a', command: 'AGENT', feature: 'b',
  planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date('2026-11-07T12:05:00.000Z'), assignedAt: null, startedAt: null,
  finishedAt: new Date('2026-11-07T12:20:00.000Z'), cancelRequestedAt: null,
  naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', costCarriedUsd: '0.0000', firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: 'feat/b', resultSha: 'b'.repeat(40),
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'PRD_REVIEW', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW, ...over,
} as FleetJobRecord);

/** The verdict of a review job: one minor finding and no edits. */
const verdict = (findings: unknown[], prdEdits: unknown[] = []): string =>
  JSON.stringify({ findings, prdEdits });

/** The agent result of a finished job: its verdict and the empty ask bookkeeping. */
const agentResult = (output: string): FleetJobRecord['agentResult'] => ({
  status: 'completed', output, truncated: false, deniedAsks: [], deniedAsksTruncated: false,
});

interface Options {
  flow?: Partial<FleetFlowRecord>;
  /** The latest job of the feature named by `snapshotFeatureId`. */
  snapshot?: LatestFlowJob | null;
  /** The feature the snapshot belongs to; the later feature by default. */
  snapshotFeatureId?: string;
  /** The feature's latest PLAN job. */
  plan?: FleetJobRecord | null;
  /** The feature's latest RUN job. */
  run?: FleetJobRecord | null;
  /** The number of PLAN jobs of the feature since the approval. */
  planCount?: number;
  callsOutcome?: CallsOutcome;
  prdOutcome?: PrdEditsOutcome;
}

function build(opts: Options = {}) {
  const row = flow({ ...opts.flow });
  const snapshotFeatureId = opts.snapshotFeatureId ?? 'feature-b';
  const plan = opts.plan === undefined
    ? job({ id: 'plan-1', flowStep: 'PLAN', command: 'PLAN', resultSha: PLAN_SHA, resultBranch: 'feat/b' })
    : opts.plan;
  const run = opts.run === undefined
    ? job({ id: 'run-1', flowStep: 'RUN', command: 'RUN', resultBranch: 'pr/head', workflow: {
      runId: 'nax-1', outcome: 'draft', workflowPassed: false, reasons: [],
      openItems: [{ id: 'D-1', kind: 'advisor', issue: 'Dep says 12', severity: null, file: null, line: null, suggestion: null }],
    } })
    : opts.run;
  let inTransaction = false;
  const order: string[] = [];
  const assertTx = () => { expect(inTransaction).toBe(true); };
  const flows = {
    findById: vi.fn(async () => row),
    lockById: vi.fn(async () => { assertTx(); order.push('flow'); return row; }),
    stop: vi.fn(async () => { assertTx(); return row; }),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async (_flowId: string, featureId: string) =>
      (opts.snapshot && featureId === snapshotFeatureId ? opts.snapshot : null)),
    latestJobForStep: vi.fn(async (_flowId: string, _featureId: string, step: string) =>
      (step === 'PLAN' ? plan : step === 'RUN' ? run : null)),
    countJobsForStepSince: vi.fn(async (_flowId: string, _featureId: string, step: string) =>
      (step === 'PLAN' ? (opts.planCount ?? 0) : 0)),
    sumCost: vi.fn(async () => row.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }),
    creatorAccess: vi.fn(async () => { assertTx(); return { exists: true, disabled: false }; }),
    setBranch: vi.fn(async () => { assertTx(); }),
    recordCalls: vi.fn(async () => { assertTx(); }),
    recordPrdEdits: vi.fn(async () => { assertTx(); }),
    recordRulings: vi.fn(async () => { assertTx(); }),
    setWaiting: vi.fn(async () => { assertTx(); }),
    projectSlug: vi.fn(async () => 'web'),
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
  const calls = {
    apply: vi.fn<FleetFlowCallsService['apply']>(async () => {
      expect(inTransaction).toBe(false);
      return opts.callsOutcome ?? { kind: 'committed', specSha: 'calls-sha' };
    }),
    applyPrdEdits: vi.fn<FleetFlowCallsService['applyPrdEdits']>(async () => {
      expect(inTransaction).toBe(false);
      return opts.prdOutcome ?? { kind: 'committed', sha: 'edit-sha', applied: 1, refused: [] };
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
  const wrote = () => [flows.stop, steps.setSpent, steps.complete, steps.markStep, steps.recordCalls,
    steps.recordPrdEdits, steps.recordRulings, steps.setWaiting, steps.setBranch,
    audit.record, activity.record, flowService.reaskLocked].some((fn) => fn.mock.calls.length > 0);
  return { service, row, flows, steps, repos, activity, audit, txManager, jobs, permissions, flowService,
    github, calls, outbox, rulings, order, wrote, inTransaction: () => inTransaction };
}

/** A flow whose first feature is ready and whose second feature runs on its own branch. */
const laterFeatureFlow = (over: Partial<FleetFlowRecord> = {}): Partial<FleetFlowRecord> => ({
  state: 'RUNNING',
  features: [featureA({ state: 'READY' }), featureB({ state: 'RUNNING', branch: 'feat/b' })],
  ...over,
});

describe('FleetFlowAdvanceService.advance, the active feature', () => {
  beforeEach(() => {
    observed.decisions.length = 0;
    observed.dispatchInputs.length = 0;
  });

  it('AC-1: a two-feature flow dispatches the set review for its position-0 feature', async () => {
    const h = build({ flow: { state: 'APPROVED' } });

    await h.service.advance('flow-1', NOW);

    expect(observed.dispatchInputs.at(-1)).toMatchObject({
      feature: { id: 'feature-a', feature: 'a', specPath: SPEC_A },
      setSpecPaths: [SPEC_A, SPEC_B],
    });
    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'AGENT' }),
      expect.objectContaining({ flowId: 'flow-1', flowStep: 'SPEC_REVIEW', flowFeatureId: 'feature-a' }));
    const body = h.jobs.dispatch.mock.calls[0]?.[2];
    if (!body || body.command !== 'AGENT') throw new Error('expected an AGENT dispatch');
    expect(body.agent.task).toContain(SPEC_A);
    expect(body.agent.task).toContain(SPEC_B);
  });

  it('AC-2: the active later feature plans on its own branch', async () => {
    const h = build({ flow: laterFeatureFlow() });

    await h.service.advance('flow-1', NOW);

    expect(h.jobs.dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({
      command: 'PLAN', ref: 'feat/b', feature: 'b',
    }), expect.objectContaining({ flowId: 'flow-1', flowStep: 'PLAN', flowFeatureId: 'feature-b' }));
  });

  it('AC-3: the later feature reads no forge head of the flow branch and is never re-asked', async () => {
    const h = build({ flow: laterFeatureFlow() });
    h.github.getBranchHead.mockResolvedValue('e'.repeat(40));

    await h.service.advance('flow-1', NOW);

    expect(h.github.getBranchHead).not.toHaveBeenCalled();
    expect(h.github.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(h.flowService.reaskLocked).not.toHaveBeenCalled();
    expect(h.jobs.dispatch).toHaveBeenCalledOnce();
  });

  it('AC-4: the decision input of the later feature carries its own ids', async () => {
    const answers = [{ id: '1', answer: 'A1' }];
    const h = build({ flow: laterFeatureFlow({ features: [
      featureA({ state: 'READY' }),
      featureB({ state: 'RUNNING', branch: 'feat/b', callsJobId: 'calls-1', prNumber: 7,
        questionsJobId: 'questions-1', answers }),
    ] }) });

    await h.service.advance('flow-1', NOW);

    expect(observed.decisions.at(-1)).toMatchObject({
      firstFeature: false,
      callsJobId: 'calls-1',
      featurePrNumber: 7,
      questionsJobId: 'questions-1',
      answers,
    });
  });

  it('AC-5: a stop names the active feature', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'PLAN' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'PLAN', command: 'PLAN', state: 'FAILED', stateReason: 'boom' }), ingestSettled: true },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'step_failed', NOW, 'PLAN job job-b FAILED: boom');
    expect(h.outbox.record).toHaveBeenCalledExactlyOnceWith({
      type: 'fleet_flow_stopped',
      payload: expect.objectContaining({ flowId: 'flow-1', feature: 'b', stopReason: 'step_failed' }),
      metadata: { projectId: 'p1', eventId: 'flow-1:stopped' },
    });
  });

  it('AC-6: a wait for answers belongs to the active feature', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'SPEC_REVIEW' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'SPEC_REVIEW', command: 'AGENT', state: 'COMPLETED', ref: 'a'.repeat(40),
        agentResult: agentResult(verdict([{ id: 'F1', class: 'ambiguous', summary: 's', question: 'q' }])) }), ingestSettled: true },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setWaiting).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-b',
      { jobId: 'job-b', questions: [{ id: '1', question: 'q' }] });
    expect(h.outbox.record).toHaveBeenCalledExactlyOnceWith({
      type: 'fleet_flow_questions',
      payload: expect.objectContaining({ flowId: 'flow-1', feature: 'b', step: 'SPEC_REVIEW', jobId: 'job-b' }),
      metadata: { projectId: 'p1', eventId: 'flow-1:questions:job-b' },
    });
  });

  it('AC-7: the RULE pass reads and records the later feature own rows', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'RULE', prNumber: 12 }),
      ] }),
      snapshot: { job: job({ id: 'rule-1', flowStep: 'RULE', command: 'AGENT', state: 'COMPLETED',
        agentResult: agentResult(JSON.stringify({ rulings: [{ item: 'D-1', ruling: 'verified: a' }], questions: [] })) }), ingestSettled: true },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.latestJobForStep).toHaveBeenCalledWith('flow-1', 'feature-b', 'RUN');
    expect(h.rulings.createForFlow).toHaveBeenCalledWith(expect.objectContaining({ runJobId: 'run-1', flowId: 'flow-1' }));
    expect(h.steps.recordRulings).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-b', 'rule-1');
  });

  it('AC-8/AC-9: the later feature PRD calls target its own branch and move no sha', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'PRD_REVIEW' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'PRD_REVIEW', command: 'AGENT', state: 'COMPLETED',
        agentResult: agentResult(verdict([{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }])) }), ingestSettled: true },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'PRD_REVIEW', jobId: 'job-b', findings: [{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }],
    }, PLAN_SHA, { feature: 'b', specPath: SPEC_B, branch: 'feat/b' });
    expect(h.steps.recordCalls).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-b', 'job-b', null);
  });

  it('AC-10: the later feature PRD edits target its own branch', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'PRD_REVIEW' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'PRD_REVIEW', command: 'AGENT', state: 'COMPLETED',
        agentResult: agentResult(verdict(
          [{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }],
          [{ story: 'US-001', op: 'add_ac', new: 'Cover it' }],
        )) }), ingestSettled: true },
      planCount: 2,
    });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.applyPrdEdits).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_prd_edits', jobId: 'job-b',
      edits: [{ story: 'US-001', op: 'add_ac', new: 'Cover it' }],
      accepted: [{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }],
    }, PLAN_SHA, { feature: 'b', specPath: SPEC_B, branch: 'feat/b' });
  });

  it('AC-11: a PLAN that pushed another branch refuses the later feature', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'PRD_REVIEW' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'PRD_REVIEW', command: 'AGENT', state: 'COMPLETED',
        agentResult: agentResult(verdict([{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }])) }), ingestSettled: true },
      plan: job({ id: 'plan-1', flowStep: 'PLAN', command: 'PLAN', resultSha: PLAN_SHA, resultBranch: 'other/branch' }),
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'PLAN pushed other/branch, expected feat/b');
    expect(h.steps.setBranch).not.toHaveBeenCalled();
    expect(h.calls.apply).not.toHaveBeenCalled();
  });

  it('AC-12: a stale calls head stops the later feature instead of re-asking', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'PRD_REVIEW' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'PRD_REVIEW', command: 'AGENT', state: 'COMPLETED',
        agentResult: agentResult(verdict([{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }])) }), ingestSettled: true },
      callsOutcome: { kind: 'stale', head: 'external' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'spec_changed', NOW, expect.any(String));
    expect(h.flowService.reaskLocked).not.toHaveBeenCalled();
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
  });

  it('AC-13: a stale PRD-edit head stops the later feature instead of re-asking', async () => {
    const h = build({
      flow: laterFeatureFlow({ features: [
        featureA({ state: 'READY' }),
        featureB({ state: 'RUNNING', branch: 'feat/b', currentStep: 'PRD_REVIEW' }),
      ] }),
      snapshot: { job: job({ id: 'job-b', flowStep: 'PRD_REVIEW', command: 'AGENT', state: 'COMPLETED',
        agentResult: agentResult(verdict(
          [{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }],
          [{ story: 'US-001', op: 'add_ac', new: 'Cover it' }],
        )) }), ingestSettled: true },
      planCount: 2,
      prdOutcome: { kind: 'stale', head: 'external' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'spec_changed', NOW, expect.any(String));
    expect(h.flowService.reaskLocked).not.toHaveBeenCalled();
    expect(h.steps.recordPrdEdits).not.toHaveBeenCalled();
  });
});
