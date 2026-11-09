import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { CreatorAccess, IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import type { PermissionService } from '../../permissions/permission.service';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const NOW = new Date('2026-11-07T12:30:00Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00Z');
const QUESTIONS = [{ id: '2', question: 'Should this be bounded?' }];
const ANSWERS = [{ id: '2', answer: 'A1' }];
const FINDINGS = [
  { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' },
  { id: 'F2', class: 'ambiguous', summary: 'Choose bound', question: 'Should this be bounded?' },
];
const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: '.nax/features/f/spec.md',
  dependsOn: [], state: 'RUNNING', currentStep: 'SPEC_REVIEW', prNumber: null, ...over,
});
const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/f', specSha: 's1',
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'approver-1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT, features: [feature()], ...over,
});
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'repo-1', ref: 's1', command: 'AGENT', feature: 'f',
  planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1', queuedAt: new Date('2026-11-07T12:05:00Z'),
  assignedAt: null, startedAt: null, finishedAt: new Date('2026-11-07T12:20:00Z'), cancelRequestedAt: null,
  naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', costCarriedUsd: '0.0000', firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: 'feat/f', resultSha: 'review-sha',
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'SPEC_REVIEW', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW,
  agentResult: { status: 'completed', output: JSON.stringify({ findings: FINDINGS }) }, ...over,
} as FleetJobRecord);
interface Options { flow?: Partial<FleetFlowRecord>; latest?: Partial<FleetJobRecord>; locks?: Partial<FleetFlowRecord>[]; outcome?: {kind:'stale';head:string}|{kind:'committed';specSha:string}; }
function build(opts: Options = {}) {
  const latest = job(opts.latest);
  const row = flow({ features: [feature({ currentStep: latest.flowStep ?? null })], ...opts.flow });
  let inTransaction = false;
  let lockIndex = 0;
  const assertTx = () => expect(inTransaction).toBe(true);
  const flows = {
    findById: vi.fn(async () => row),
    lockById: vi.fn(async () => { assertTx(); return flow({ ...row, ...opts.locks?.[lockIndex++] }); }),
    stop: vi.fn(async () => { assertTx(); return row; }),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => ({ job: latest, ingestSettled: true })),
    sumCost: vi.fn(async () => row.spentUsd), setSpent: vi.fn(async () => undefined), complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }),
    creatorAccess: vi.fn<IFleetFlowStepRepository['creatorAccess']>(async (): Promise<CreatorAccess> => { assertTx(); return { exists: true, disabled: false }; }),
    countJobsForStepSince: vi.fn<IFleetFlowStepRepository['countJobsForStepSince']>(async () => 0),
    setBranch: vi.fn(async () => undefined), recordCalls: vi.fn(async () => { assertTx(); }),
    setWaiting: vi.fn(async () => { assertTx(); }),
    latestJobForStep: vi.fn(async (flowId: string, _featureId: string, step: string) => step === 'RUN'
      ? job({ id: 'run-1', command: 'RUN', flowStep: 'RUN', resultBranch: 'pr/head', workflow: { outcome: 'draft', openItems: [
        { id: 'D-1', kind: 'advisor', issue: 'Protected' }, { id: 'F-1', kind: 'finding', issue: 'Finding' },
        { id: 'C-1', kind: 'ci', issue: 'CI' }, { id: 'D-2', kind: 'advisor', issue: 'Eligible' },
      ] } })
      : job({ id: 'plan-1', command: 'PLAN', flowStep: 'PLAN', resultSha: 'plan-sha' })),
  };
  const repos = {
    lockById: vi.fn(async () => { assertTx(); return { id: row.repoId }; }),
    findReviewRepo: vi.fn(async () => ({ id: row.repoId, owner: 'o', name: 'r', githubInstallationId: 1n })),
  };
  const threads = { lockForFlowTransition: vi.fn(async () => { assertTx(); return { publishedSha: row.specSha }; }) };
  const activity = { record: vi.fn(async () => { assertTx(); }) };
  const audit = { record: vi.fn(async () => { assertTx(); }) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => { inTransaction = true; try { return await fn(); } finally { inTransaction = false; } }) };
  const jobs = { dispatch: vi.fn(async () => ({ job: { id: 'next-job' } })) };
  const permissions = { effectiveKeys: vi.fn<PermissionService['effectiveKeys']>(async () => new Set(['fleet.job.dispatch'])) };
  const flowService = { reaskLocked: vi.fn(async () => row) };
  const github = {
    mintReadOnlyToken: vi.fn(async () => ({ token: 'test-only', expiresAt: NOW })),
    getBranchHead: vi.fn(async () => 's1'),
  };
  const calls = { apply: vi.fn(async () => opts.outcome ?? { kind: 'committed' as const, specSha: 's2' }) };
  const outbox = { record: vi.fn(async () => { assertTx(); }) };
  const rulings = { ruledItemIds: vi.fn(async () => ['D-1']), createForFlow: vi.fn(), commentRefused: vi.fn() };
  const service = new FleetFlowAdvanceService(flows as never, steps as never, threads as never, repos as never,
    activity as never, audit as never, txManager as never, jobs as never, permissions as never, flowService as never,
    github as never, {} as never, testFleetConfig(), calls as never, outbox as never,
    rulings as never);
  return { service, row, flows, steps, activity, audit, txManager, jobs, flowService, calls, outbox, rulings };
}

describe('FleetFlowAdvanceService answer lifecycle', () => {
  it('AC-4/5/6/7: atomically persists an ambiguous review wait and emits one questions event', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.steps.setWaiting).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', { jobId: 'j1', questions: QUESTIONS });
    expect(h.outbox.record).toHaveBeenCalledExactlyOnceWith({
      type: 'fleet_flow_questions',
      payload: { flowId: 'flow-1', projectId: 'p1', feature: 'f', step: 'SPEC_REVIEW', jobId: 'j1', questions: QUESTIONS,
        approverId: 'approver-1', creatorType: 'USER', creatorId: 'u1' },
      metadata: { projectId: 'p1', eventId: 'flow-1:questions:j1' },
    });
    expect(h.audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'system.flow.advance', resourceType: 'flow', resourceId: 'flow-1', projectId: 'p1', summary: 'flow waiting answer SPEC_REVIEW' });
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith({ actorType: 'SYSTEM', actorId: 'flow', action: 'flow.waiting', entityType: 'flow', entityId: 'flow-1', projectId: 'p1', payload: { step: 'SPEC_REVIEW', jobId: 'j1', count: 1 } });
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.calls.apply).not.toHaveBeenCalled();
  });
  it('AC-1: REVIEW decision lazily loads the RUN workflow and protected ruling ids', async () => {
    const review = job({ id: 'review-1', flowStep: 'REVIEW', command: 'REVIEW', feature: 'review-pr-12',
      agentResult: { status: 'completed', output: '{"findings":[]}' } });
    const h = build({ latest: review, flow: { features: [feature({ prNumber: 12 })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.latestJobForStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'RUN');
    expect(h.rulings.ruledItemIds).toHaveBeenCalledExactlyOnceWith('run-1');
  });
  it('AC-3/6: guided FIX answer dispatches RULE against the RUN branch and eligible workflow items', async () => {
    const fix = job({ id: 'fix-1', flowStep: 'FIX', command: 'FIX', fixReady: { markedReady: false, readyHeld: 'still held' } });
    const h = build({ latest: fix, flow: { features: [feature({ currentStep: 'FIX', prNumber: 12, questionsJobId: 'fix-1',
      questions: [{ id: '1', question: 'Q' }], answers: [{ id: '1', answer: 'A' }] })] } });
    await h.service.advance('flow-1', NOW);
    const body = h.jobs.dispatch.mock.calls[0]?.[2];
    expect(body).toEqual(expect.objectContaining({ command: 'AGENT', feature: 'f', ref: 'pr/head', bashMode: 'raw' }));
    if (body.command !== 'AGENT') throw new Error('expected RULE AGENT dispatch');
    expect(body.agent.task).toContain('Still held: still held');
    expect(body.agent.task).toContain('- D-2 (advisor): Eligible');
    expect(body.agent.task).not.toContain('D-1');
    expect(body.agent.task).not.toContain('F-1');
    expect(body.agent.task).not.toContain('C-1');
    expect(body.agent.task).toContain('Q1: Q A: A');
    expect(h.rulings.ruledItemIds).toHaveBeenCalledWith('run-1');
  });
  it('AC-4/5: RULE answer guidance has no held text when the answered job is RULE', async () => {
    const rule = job({ id: 'rule-1', flowStep: 'RULE', command: 'AGENT', agentResult: { status: 'completed',
      output: '{"rulings":[],"questions":[{"item":"D-1","question":"Q?"}]}' } });
    const h = build({ latest: rule, flow: { features: [feature({ currentStep: 'RULE', prNumber: 12, questionsJobId: 'rule-1',
      questions: [{ id: '1', question: 'D-1: Q?' }], answers: [{ id: '1', answer: 'clarification' }] })] } });
    await h.service.advance('flow-1', NOW);
    const body = h.jobs.dispatch.mock.calls[0]?.[2];
    if (!body || body.command !== 'AGENT') throw new Error('expected RULE AGENT dispatch');
    expect(body.ref).toBe('pr/head');
    expect(body.agent.task).toContain('Q1: D-1: Q? A: clarification');
    expect(body.agent.task).not.toContain('Still held:');
  });
  it('AC-6: RULE with a RUN lacking resultBranch stops dispatch_refused', async () => {
    const fix = job({ id: 'fix-1', flowStep: 'FIX', command: 'FIX', fixReady: { markedReady: false, readyHeld: 'held' } });
    const h = build({ latest: fix, flow: { features: [feature({ currentStep: 'FIX', prNumber: 12, questionsJobId: 'fix-1', answers: ANSWERS })] } });
    h.steps.latestJobForStep.mockResolvedValue(job({ id: 'run-1', command: 'RUN', flowStep: 'RUN', resultBranch: null }));
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'RULE: RUN has no result branch');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });
  it('AC-2: PLAN decision does not read RUN data or rulings', async () => {
    const plan = job({ id: 'plan-1', flowStep: 'PLAN', command: 'PLAN' });
    const h = build({ latest: plan });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.latestJobForStep).not.toHaveBeenCalledWith('flow-1', 'feature-1', 'RUN');
    expect(h.rulings.ruledItemIds).not.toHaveBeenCalled();
  });
  it('AC-7: FIX wait persists FIX and emits a FIX questions event', async () => {
    const heldFix = job({ id: 'fix-1', flowStep: 'FIX', command: 'FIX', fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' } });
    const h = build({ latest: heldFix });
    await h.service.advance('flow-1', NOW);
    const questions = [{ id: '1', question: 'PR still held after FIX fix-1: 1 open item(s): G-1. Answer with guidance for one more ruling and FIX round, or stop the flow.' }];
    expect(h.steps.setWaiting).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', { jobId: 'fix-1', questions });
    expect(h.outbox.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'fleet_flow_questions',
      payload: expect.objectContaining({ step: 'FIX', jobId: 'fix-1', questions }),
    }));
  });
  it('AC-8: does nothing for a flow waiting on answers', async () => {
    const h = build({ flow: { state: 'WAITING_ANSWER' } });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.setWaiting).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
    expect(h.outbox.record).not.toHaveBeenCalled();
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.calls.apply).not.toHaveBeenCalled();
  });
  it('AC-9: passes stored answers on matching review to calls.apply', async () => {
    const h = build({ flow: { features: [feature({ questionsJobId: 'j1', answers: ANSWERS })] } });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledWith(h.row, { kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [FINDINGS[0], { ...FINDINGS[1], answer: 'A1' }] }, 's1', { feature: 'f', specPath: '.nax/features/f/spec.md', branch: 'feat/f', replay: expect.anything() });
  });
  it('AC-10: stale calls re-ask with the new head and do not record calls', async () => {
    const h = build({ flow: { features: [feature({ questionsJobId: 'j1', answers: ANSWERS })] }, outcome: { kind: 'stale', head: 'h2' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flowService.reaskLocked).toHaveBeenCalledWith(h.row, 'h2', NOW);
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
  });
  it('AC-11: keeps non-ambiguous findings unchanged on the F4a calls path', async () => {
    const minor = { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' };
    const h = build({ latest: { agentResult: { status: 'completed', output: JSON.stringify({ findings: [minor] }) } } });
    await h.service.advance('flow-1', NOW);
    expect(h.calls.apply).toHaveBeenCalledWith(h.row, { kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [minor] }, 's1', { feature: 'f', specPath: '.nax/features/f/spec.md', branch: 'feat/f', replay: expect.anything() });
  });
});
