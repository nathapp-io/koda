import type { LiveFleetApprovalEvent, LiveFleetJobEvent } from '../../live/live-event';
import type { FleetCommandRecord, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { CommandAckProcessor } from './command-ack.processor';

const NOW = new Date('2026-10-03T10:00:00.000Z');

const APPROVAL_LIVE: LiveFleetApprovalEvent = { id: 'lv-1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'cancelled', at: NOW.toISOString() };
const JOB_LIVE: LiveFleetJobEvent = { id: 'e1', type: 'fleet_job', projectId: 'p1', jobId: 'job-1', state: 'CRASHED', at: NOW.toISOString() };

const runningJob: FleetJobRecord = {
  id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'main', command: 'RUN', feature: 'demo', planFrom: null,
  profiles: [], maxCostUsd: '10', bashMode: 'escalate', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
  runnerId: 'r1', runnerBootId: 'boot-1', leaseEpoch: 1, state: 'RUNNING', stateReason: null, requestedById: 'u1',
  queuedAt: NOW, assignedAt: NOW, startedAt: NOW, finishedAt: null, cancelRequestedAt: null, naxRunId: null,
  naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0',
  costCarriedUsd: '0', firstStartedAt: NOW, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null,
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null,
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
    findCommand: jest.fn(async () => cmd),
    lockById: jest.fn(async () => job),
    ackCommand: jest.fn(),
  };
  const transitions = { apply: jest.fn(async () => ({ job: runningJob, live: JOB_LIVE, approvalLive: [APPROVAL_LIVE] })) };
  const fence = { holds: jest.fn(() => true), abandon: jest.fn() };
  const activity = { record: jest.fn() };
  const approvals = { lockById: jest.fn(), setOutcome: jest.fn() };
  const tx = { run: (fn: () => unknown) => fn() };
  const processor = new CommandAckProcessor(repo as never, transitions as never, fence as never, activity as never, approvals as never, tx as never);
  const seedCommand = (c: FleetCommandRecord) => { cmd = c; };
  const seedJob = (j: FleetJobRecord) => { job = j; };
  return { processor, repo, transitions, fence, approvals, seedCommand, seedJob };
}

describe('CommandAckProcessor live lists (S1.5 2a)', () => {
  it('an ok ASSIGN ack returns no job and no approval events', async () => {
    const { processor } = makeProcessor(command({ type: 'ASSIGN' }));
    await expect(processor.process('r1', 'boot-1', [{ commandId: 'cmd-1', leaseEpoch: 1, result: 'ok' }], NOW))
      .resolves.toEqual({ live: [], approvalLive: [] });
  });

  it('a rejected READOPT on a RUNNING job returns both live lists (plan D263)', async () => {
    const { processor, transitions } = makeProcessor(command({ type: 'READOPT' }));
    const result = await processor.process('r1', 'boot-2', [{ commandId: 'cmd-1', leaseEpoch: 1, result: 'rejected', detail: 'no' }], NOW);
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ to: 'CRASHED', by: 'server' }));
    expect(result).toEqual({ live: [JOB_LIVE], approvalLive: [APPROVAL_LIVE] });
  });
});

describe('APPROVAL_ANSWER acks (spec §3, plan D268)', () => {
  it.each([['ok', undefined], ['rejected', 'callback_failed:429']] as const)('stores %s as outcome.delivery', async (result, detail) => {
    const { processor, approvals, transitions, seedCommand, seedJob } = makeProcessor(command({ type: 'APPROVAL_ANSWER', leaseEpoch: 2, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' } }));
    seedCommand({ id: 'c1', type: 'APPROVAL_ANSWER', runnerId: 'r1', jobId: 'j1', leaseEpoch: 2, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' }, createdAt: NOW, deliveredAt: NOW, ackedAt: null, ackResult: null });
    seedJob({ ...runningJob, id: 'j1', runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING' });
    approvals.lockById.mockResolvedValue({ id: 'a1', outcome: null });
    const out = await processor.process('r1', 'boot', [{ commandId: 'c1', leaseEpoch: 2, result, ...(detail ? { detail } : {}) }], NOW);
    expect(approvals.setOutcome).toHaveBeenCalledWith('a1', { delivery: { result, detail: detail ?? null, at: NOW.toISOString() } });
    expect(out.live).toEqual([]);
    expect(transitions.apply).not.toHaveBeenCalled();
  });
});
