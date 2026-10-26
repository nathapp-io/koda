import type { LiveFleetApprovalEvent, LiveFleetJobEvent } from '../../live/live-event';
import type { FleetCommandRecord, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { CommandAckProcessor } from './command-ack.processor';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';

const NOW = new Date('2026-10-03T10:00:00.000Z');

const APPROVAL_LIVE: LiveFleetApprovalEvent = { id: 'lv-1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'cancelled', at: NOW.toISOString() };
const JOB_LIVE: LiveFleetJobEvent = { id: 'e1', type: 'fleet_job', projectId: 'p1', jobId: 'job-1', state: 'CRASHED', at: NOW.toISOString() };

const runningJob: FleetJobRecord = {
  id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'main', command: 'RUN', feature: 'demo', planFrom: null, threadId: null,
  profiles: [], maxCostUsd: '10', bashMode: 'escalate', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
  runnerId: 'r1', runnerBootId: 'boot-1', leaseEpoch: 1, state: 'RUNNING', stateReason: null, requestedById: 'u1',
  queuedAt: NOW, assignedAt: NOW, startedAt: NOW, finishedAt: null, cancelRequestedAt: null, naxRunId: null,
  naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0',
  costCarriedUsd: '0', firstStartedAt: NOW, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null,
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null,
  updatedAt: NOW,
};

const command = (over: Partial<FleetCommandRecord> = {}): FleetCommandRecord => ({
  id: 'cmd-1', runnerId: 'r1', jobId: 'job-1', type: 'ASSIGN', leaseEpoch: 1, payload: {},
  createdAt: NOW, deliveredAt: NOW, ackedAt: null, ackResult: null, ...over,
});

function makeProcessor(commandRecord: FleetCommandRecord) {
  let cmd = commandRecord;
  let job: FleetJobRecord = runningJob;
  const repo = {
    findCommand: vi.fn(async () => cmd),
    lockById: vi.fn(async () => job),
    ackCommand: vi.fn(),
    findRunnerHeld: vi.fn(async () => []),
    findPendingCommand: vi.fn(async () => null),
    update: vi.fn(),
    createCommand: vi.fn(),
  };
  const transitions = { apply: vi.fn(async () => ({ job: runningJob, live: JOB_LIVE, approvalLive: [APPROVAL_LIVE] })) };
  const fence = { holds: vi.fn(() => true), abandon: vi.fn() };
  const activity = { record: vi.fn() };
  const approvals = { lockById: vi.fn(), setOutcome: vi.fn() };
  const tx = { run: (fn: () => unknown) => fn() };
  const processor = new CommandAckProcessor(repo as never, transitions as never, fence as never, activity as never, approvals as never, tx as never, mockAuditRecorder);
  const seedCommand = (c: FleetCommandRecord) => { cmd = c; };
  const seedJob = (j: FleetJobRecord) => { job = j; };
  return { processor, repo, transitions, fence, approvals, seedCommand, seedJob };
}

describe('CommandAckProcessor live lists (S1.5 2a)', () => {
  it('AC-12: marks pending ASSIGN boot reconciliation on its update', async () => {
    const { processor, repo } = makeProcessor(command());
    repo.findRunnerHeld.mockResolvedValue([{ ...runningJob, state: 'ASSIGNED', runnerBootId: 'old-boot' }]);
    repo.findPendingCommand.mockResolvedValue(command());
    repo.update.mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBe('runner.boot-reconcile');
    });
    await processor.reconcileBoot('r1', 'new-boot', NOW, false);
    expect(repo.update).toHaveBeenCalledWith('job-1', { runnerBootId: 'new-boot' });
  });

  it('AC-13: READOPT creation after reboot is outside bookkeeping', async () => {
    const { processor, repo } = makeProcessor(command());
    repo.findRunnerHeld.mockResolvedValue([{ ...runningJob, runnerBootId: 'old-boot' }]);
    repo.findPendingCommand.mockResolvedValue(null);
    repo.createCommand.mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBeUndefined();
    });
    await processor.reconcileBoot('r1', 'new-boot', NOW, true);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'READOPT' }));
  });

  it('marks the exact command ack write as runner.command-ack', async () => {
    const { processor, repo } = makeProcessor(command({ type: 'ASSIGN' }));
    repo.ackCommand.mockImplementation(async () => { expect(currentBookkeepingReason()).toBe('runner.command-ack'); });
    await processor.process('r1', 'boot-1', [{ commandId: 'cmd-1', leaseEpoch: 1, result: 'ok' }], NOW);
    expect(repo.ackCommand).toHaveBeenCalledTimes(1);
  });

  it('an ok ASSIGN ack returns no job and no approval events', async () => {
    const { processor } = makeProcessor(command({ type: 'ASSIGN' }));
    await expect(processor.process('r1', 'boot-1', [{ commandId: 'cmd-1', leaseEpoch: 1, result: 'ok' }], NOW))
      .resolves.toEqual({ live: [], approvalLive: [] });
  });

  it('a rejected READOPT on a RUNNING job returns both live lists (plan D263)', async () => {
    const { processor, transitions } = makeProcessor(command({ type: 'READOPT' }));
    transitions.apply.mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBeUndefined();
      return { job: runningJob, live: JOB_LIVE, approvalLive: [APPROVAL_LIVE] };
    });
    const result = await processor.process('r1', 'boot-2', [{ commandId: 'cmd-1', leaseEpoch: 1, result: 'rejected', detail: 'no' }], NOW);
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ to: 'CRASHED', by: 'server' }));
    expect(result).toEqual({ live: [JOB_LIVE], approvalLive: [APPROVAL_LIVE] });
  });
});

describe('THREAD_PUBLISH acks (US-004)', () => {
  const publishAck = (commandId: string, result: 'ok' | 'rejected', detail?: string) => ({ commandId, leaseEpoch: 1, result, ...(detail ? { detail } : {}) });
  const threadPublishCommand = (): FleetCommandRecord => ({
    id: 'cmd-p', runnerId: 'r1', jobId: 'job-1', type: 'THREAD_PUBLISH', leaseEpoch: 1, payload: {},
    createdAt: NOW, deliveredAt: NOW, ackedAt: null, ackResult: null,
  });

  it('AC-5: observes thread.input-ack for a THREAD_INPUT acknowledgement', async () => {
    const inputCommand: FleetCommandRecord = { ...threadPublishCommand(), id: 'cmd-input', type: 'THREAD_INPUT' };
    const { repo } = makeProcessor(inputCommand);
    const threadEffects = { onInputAck: vi.fn(async () => { expect(currentBookkeepingReason()).toBe('thread.input-ack'); }) };
    const withThreads = new CommandAckProcessor(repo as never, { apply: vi.fn() } as never, { holds: () => true, abandon: vi.fn() } as never,
      { record: vi.fn() } as never, { lockById: vi.fn(), setOutcome: vi.fn() } as never, { run: (fn: () => unknown) => fn() } as never, mockAuditRecorder, threadEffects as never);

    await withThreads.process('r1', 'boot-1', [publishAck('cmd-input', 'rejected', 'input_failed')], NOW);

    expect(threadEffects.onInputAck).toHaveBeenCalledWith(expect.objectContaining({ type: 'THREAD_INPUT' }), 'rejected', 'input_failed');
  });

  it('AC-8: routes a rejected THREAD_PUBLISH ack to the thread effects with its detail', async () => {
    const { repo } = makeProcessor(threadPublishCommand());
    const threadEffects = { onInputAck: vi.fn(async () => { expect(currentBookkeepingReason()).toBe('thread.input-ack'); }) };
    const withThreads = new CommandAckProcessor(repo as never, { apply: vi.fn() } as never, { holds: () => true, abandon: vi.fn() } as never,
      { record: vi.fn() } as never, { lockById: vi.fn(), setOutcome: vi.fn() } as never, { run: (fn: () => unknown) => fn() } as never, mockAuditRecorder, threadEffects as never);
    await withThreads.process('r1', 'boot-1', [publishAck('cmd-p', 'rejected', 'turn_running')], NOW);
    expect(threadEffects.onInputAck).toHaveBeenCalledWith(expect.objectContaining({ type: 'THREAD_PUBLISH' }), 'rejected', 'turn_running');
  });

  it('AC-8: a rejected THREAD_PUBLISH ack does not move the job state', async () => {
    const { processor, transitions } = makeProcessor(threadPublishCommand());
    await processor.process('r1', 'boot-1', [publishAck('cmd-p', 'rejected', 'turn_running')], NOW);
    expect(transitions.apply).not.toHaveBeenCalled();
  });

  it('AC-9: an ok THREAD_PUBLISH ack is routed to the thread effects and returns no live events', async () => {
    const { repo } = makeProcessor(threadPublishCommand());
    const threadEffects = { onInputAck: vi.fn(async () => undefined) };
    const withThreads = new CommandAckProcessor(repo as never, { apply: vi.fn() } as never, { holds: () => true, abandon: vi.fn() } as never,
      { record: vi.fn() } as never, { lockById: vi.fn(), setOutcome: vi.fn() } as never, { run: (fn: () => unknown) => fn() } as never, mockAuditRecorder, threadEffects as never);
    const result = await withThreads.process('r1', 'boot-1', [publishAck('cmd-p', 'ok')], NOW);
    expect(threadEffects.onInputAck).toHaveBeenCalledWith(expect.objectContaining({ type: 'THREAD_PUBLISH' }), 'ok', '');
    expect(result).toEqual({ live: [], approvalLive: [] });
  });
});

describe('APPROVAL_ANSWER acks (spec §3, plan D268)', () => {
  it.each([['ok', undefined], ['rejected', 'callback_failed:429']] as const)('stores %s as outcome.delivery', async (result, detail) => {
    const { processor, approvals, transitions, seedCommand, seedJob } = makeProcessor(command({ type: 'APPROVAL_ANSWER', leaseEpoch: 2, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' } }));
    seedCommand({ id: 'c1', type: 'APPROVAL_ANSWER', runnerId: 'r1', jobId: 'j1', leaseEpoch: 2, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' }, createdAt: NOW, deliveredAt: NOW, ackedAt: null, ackResult: null });
    seedJob({ ...runningJob, id: 'j1', runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING' });
    approvals.lockById.mockResolvedValue({ id: 'a1', outcome: null });
    approvals.setOutcome.mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBe('runner.command-ack');
    });
    const out = await processor.process('r1', 'boot', [{ commandId: 'c1', leaseEpoch: 2, result, ...(detail ? { detail } : {}) }], NOW);
    expect(approvals.setOutcome).toHaveBeenCalledWith('a1', { delivery: { result, detail: detail ?? null, at: NOW.toISOString() } });
    expect(out.live).toEqual([]);
    expect(transitions.apply).not.toHaveBeenCalled();
  });
});
