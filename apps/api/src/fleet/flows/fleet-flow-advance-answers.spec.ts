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
    latestJobForStep: vi.fn(async () => job({ id: 'plan-1', command: 'PLAN', flowStep: 'PLAN', resultSha: 'plan-sha' })),
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
  const service = new FleetFlowAdvanceService(flows as never, steps as never, threads as never, repos as never,
    activity as never, audit as never, txManager as never, jobs as never, permissions as never, flowService as never,
    github as never, {} as never, testFleetConfig(), calls as never, outbox as never);
  return { service, row, flows, steps, activity, audit, txManager, jobs, flowService, calls, outbox };
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
    expect(h.calls.apply).toHaveBeenCalledWith(h.row, { kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [FINDINGS[0], { ...FINDINGS[1], answer: 'A1' }] }, 's1');
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
    expect(h.calls.apply).toHaveBeenCalledWith(h.row, { kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [minor] }, 's1');
  });
});
