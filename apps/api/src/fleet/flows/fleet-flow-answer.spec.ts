import { FleetFlowsService } from './fleet-flows.service';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import type { FlowAnswersInput } from './flow-answers';

function record(over: Partial<FleetFlowRecord> = {}): FleetFlowRecord {
  return {
    id: 'flow', projectId: 'project', repoId: 'repo', threadId: null, entry: 'NAX', createdByType: 'USER', createdById: 'creator',
    branch: 'feat/x', specSha: 'a'.repeat(40), pinnedRunnerId: null, reviewerRole: 'reviewer', supervisorRole: 'supervisor',
    costCapUsd: '25.0000', spentUsd: '0.0000', state: 'WAITING_ANSWER', approvalMode: null, approverId: null,
    approvedAt: null, approvalRequestId: null, stopReason: null, endedAt: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    features: [{ id: 'feature-1', flowId: 'flow', position: 0, feature: 'feature', specPath: 'feature.md', dependsOn: [],
      state: 'WAITING_ANSWER', currentStep: null, prNumber: null, questionsJobId: 'j1', questions: [{ id: '2', question: 'Q2' }, { id: '4', question: 'Q4' }] }],
    ...over,
  };
}

function setup(initial = record()) {
  const calls: string[] = [];
  const flows = {
    findById: vi.fn().mockResolvedValue(initial),
    lockById: vi.fn(async () => { calls.push('flow'); return initial; }),
    recordAnswers: vi.fn(async () => { calls.push('answers'); return record({ state: 'RUNNING' }); }),
  };
  const threads = { lockForFlowTransition: vi.fn(async () => { calls.push('thread'); return { id: 'thread' }; }) };
  const repos = { lockById: vi.fn(async () => { calls.push('repo'); return { id: 'repo', projectId: 'project' }; }) };
  const asks = { close: vi.fn() };
  const audit = { record: vi.fn() };
  const activity = { record: vi.fn() };
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => { calls.push('tx'); return fn(); }) };
  const service = new FleetFlowsService(flows as never, threads as never, repos as never, asks as never, audit as never, activity as never, tx as never);
  return { calls, flows, threads, repos, audit, activity, tx, service };
}

const actor = { type: 'USER', id: 'human-1' } as const;
const answers: FlowAnswersInput = { jobId: 'j1', answers: [{ id: '4', answer: 'A4' }, { id: '2', answer: 'A2' }] };

describe('FleetFlowsService.answer', () => {
  it('AC-1/2/3: persists a complete answer batch in question order and returns repository result', async () => {
    const { service, flows, calls } = setup();
    const expected = record({ state: 'RUNNING' });
    flows.recordAnswers.mockImplementation(async () => { calls.push('answers'); return expected; });
    const now = new Date('2026-03-02T00:00:00.000Z');
    await expect(service.answer('project', 'flow', answers, actor, now)).resolves.toBe(expected);
    expect(flows.recordAnswers).toHaveBeenCalledWith('flow', 'feature-1', {
      answers: [{ id: '2', answer: 'A2' }, { id: '4', answer: 'A4' }], userId: 'human-1', at: now,
    });
    expect(calls).toEqual(['tx', 'repo', 'flow', 'answers']);
  });

  it('answers the currently waiting feature, not a previously answered review feature', async () => {
    const previous = { id: 'previous', flowId: 'flow', position: 0, feature: 'previous', specPath: 'previous.md', dependsOn: [], state: 'RUNNING', currentStep: null, prNumber: null, questionsJobId: 'old-job', questions: [{ id: '1', question: 'old' }] };
    const waiting = { id: 'current', flowId: 'flow', position: 1, feature: 'current', specPath: 'current.md', dependsOn: [], state: 'WAITING_ANSWER', currentStep: null, prNumber: null, questionsJobId: 'j1', questions: [{ id: '2', question: 'Q2' }, { id: '4', question: 'Q4' }] };
    const { service, flows } = setup(record({ features: [previous, waiting] }));
    await service.answer('project', 'flow', answers, actor);
    expect(flows.recordAnswers).toHaveBeenCalledWith('flow', 'current', expect.any(Object));
  });

  it('AC-4/5: records human-attributed audit and activity in the transaction', async () => {
    const { service, audit, activity } = setup();
    await service.answer('project', 'flow', answers, actor);
    expect(audit.record).toHaveBeenCalledWith({ key: 'fleet.flow.answer', resourceType: 'flow', resourceId: 'flow', projectId: 'project', summary: 'flow answered' });
    expect(activity.record).toHaveBeenCalledWith({ actorType: 'USER', actorId: 'human-1', action: 'flow.answered', entityType: 'flow', entityId: 'flow', projectId: 'project', payload: { flowId: 'flow', jobId: 'j1', count: 2 } });
  });

  it('AC-6: rejects a non-waiting flow without recording answers', async () => {
    const { service, flows } = setup(record({ state: 'RUNNING' }));
    await expect(service.answer('project', 'flow', answers, actor)).rejects.toMatchObject({ status: 409, response: { prefix: 'fleet.flows.notWaiting' } });
    expect(flows.recordAnswers).not.toHaveBeenCalled();
  });

  it('AC-7: rejects a waiting feature without questions', async () => {
    const { service, flows } = setup(record({ features: [{ id: 'feature-1', flowId: 'flow', position: 0, feature: 'feature', specPath: 'feature.md', dependsOn: [], state: 'WAITING_ANSWER', currentStep: null, prNumber: null, questionsJobId: 'j1', questions: null }] }));
    await expect(service.answer('project', 'flow', answers, actor)).rejects.toMatchObject({ status: 409, response: { prefix: 'fleet.flows.notWaiting' } });
    expect(flows.recordAnswers).not.toHaveBeenCalled();
  });

  it('AC-8: rejects a stale review job without recording answers', async () => {
    const { service, flows } = setup();
    await expect(service.answer('project', 'flow', { ...answers, jobId: 'j0' }, actor)).rejects.toMatchObject({ status: 409, response: { prefix: 'fleet.flows.answersStale' } });
    expect(flows.recordAnswers).not.toHaveBeenCalled();
  });

  it('AC-9/10: rejects unknown and missing question ids with precise reasons', async () => {
    const { service } = setup();
    await expect(service.answer('project', 'flow', { jobId: 'j1', answers: [{ id: '2', answer: 'A2' }, { id: '9', answer: 'A9' }, { id: '4', answer: 'A4' }] }, actor))
      .rejects.toMatchObject({ prefix: 'fleet.flows.answersInput', args: { reason: 'unknown question 9' } });
    await expect(service.answer('project', 'flow', { jobId: 'j1', answers: [{ id: '2', answer: 'A2' }] }, actor))
      .rejects.toMatchObject({ prefix: 'fleet.flows.answersInput', args: { reason: 'missing answer 4' } });
  });

  it('AC-11: hides a flow from another project', async () => {
    const { service, flows } = setup(record({ projectId: 'other' }));
    await expect(service.answer('project', 'flow', answers, actor)).rejects.toMatchObject({ status: 404, response: { prefix: 'fleet.flows.notFound' } });
    expect(flows.recordAnswers).not.toHaveBeenCalled();
  });
});
