import type { LiveFleetApprovalEvent } from '../../live/live-event';
import type { FleetJobEventRecord, FleetJobPatch, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { JobReport } from '../common/protocol';
import { JobReportProcessor } from './job-report.processor';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';

const NOW = new Date('2026-10-03T10:00:00.000Z');

const VALID_ASK = {
  naxAskId: 'ask-1f2e3d4c', deadlineAt: '2026-10-04T10:10:00.000Z', command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'],
};

const APPROVAL_LIVE: LiveFleetApprovalEvent = { id: 'lv-1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'pending', at: NOW.toISOString() };

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

type StoredEvent = { leaseEpoch: number; runnerSeq: number | null; type: string; payload: unknown };

function makeRepo() {
  let job: FleetJobRecord | null = null;
  const events: FleetJobEventRecord[] = [];
  let nextEventId = 0;
  return {
    seed: (j: FleetJobRecord) => { job = { ...j }; events.length = 0; },
    lockById: vi.fn(async () => job),
    findRunnerEvents: vi.fn(async (_jobId: string, _epoch: number, seqs: readonly number[]) =>
      events.filter((e) => seqs.includes(e.runnerSeq as number))),
    appendEvent: vi.fn(async (jobId: string, e: StoredEvent) => {
      const rec: FleetJobEventRecord = { id: `ev-${++nextEventId}`, jobId, seq: 0, ...e, createdAt: NOW };
      events.push(rec);
      return rec;
    }),
    findRunnerEventsAfter: vi.fn(async (_jobId: string, _epoch: number, after: number) =>
      events.filter((e) => (e.runnerSeq ?? 0) > after).sort((a, b) => (a.runnerSeq ?? 0) - (b.runnerSeq ?? 0))),
    update: vi.fn(async (id: string, patch: FleetJobPatch) => {
      job = { ...job, id, ...patch } as FleetJobRecord;
      return job;
    }),
    createCommand: vi.fn(async (c: { runnerId: string; jobId: string; type: string; leaseEpoch: number; payload: object }) =>
      ({ id: `cmd-${++nextEventId}`, createdAt: NOW, deliveredAt: null, ackedAt: null, ackResult: null, ...c })),
  };
}

function makeProcessor(repo: ReturnType<typeof makeRepo>) {
  const fence = { holds: (j: FleetJobRecord, r: string, e: number) => j.runnerId === r && j.leaseEpoch === e, abandon: vi.fn() };
  const activity = { record: vi.fn() };
  const budgets = { signal: vi.fn() };
  const live = { event: vi.fn(() => ({ id: 'job-live', type: 'fleet_job', projectId: 'p1', jobId: 'job-1', state: 'RUNNING', at: NOW.toISOString() })) };
  const tx = { run: (fn: () => unknown) => fn() };
  const closer = { openBash: vi.fn().mockResolvedValue({ approval: { id: 'a1' }, live: [APPROVAL_LIVE] }) };
  const processor = new JobReportProcessor(repo as never, {} as never, live as never, fence as never, activity as never, budgets as never, closer as never, tx as never, mockAuditRecorder);
  return { processor, closer, activity };
}

const report = (jobId: string, leaseEpoch: number): JobReport => ({
  jobId, leaseEpoch, events: [{ seq: 1, type: 'approval_request', payload: VALID_ASK as never }],
});

describe('JobReportProcessor approval_request (S1.5 §2.2)', () => {
  it('opens a bash approval for an approval_request on a RUNNING job and returns its live event', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, bashMode: 'escalate' });
    const { processor, closer } = makeProcessor(repo);
    const outcome = await processor.process('r1', report(runningJob.id, runningJob.leaseEpoch), NOW);
    expect(closer.openBash).toHaveBeenCalledWith(expect.objectContaining({ id: runningJob.id }), expect.objectContaining({ naxAskId: 'ask-1f2e3d4c' }), 'r1', NOW);
    expect(outcome.approvalLive).toEqual([APPROVAL_LIVE]);
    expect(outcome.ack).toEqual({ jobId: runningJob.id, ackedSeq: 1 });
  });

  it('rejects a malformed ask as an event, acks it, and opens nothing (D269)', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, bashMode: 'escalate' });
    const { processor, closer, activity } = makeProcessor(repo);
    activity.record.mockImplementation(async (event) => {
      expect(event.action).toBe('job.event_rejected');
      expect(currentBookkeepingReason()).toBe('runner.event-log');
    });
    const outcome = await processor.process('r1', { jobId: runningJob.id, leaseEpoch: runningJob.leaseEpoch, events: [{ seq: 1, type: 'approval_request', payload: { naxAskId: 'x' } as never }] }, NOW);
    expect(closer.openBash).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'job.event_rejected' }));
    expect(outcome.ack).toEqual({ jobId: runningJob.id, ackedSeq: 1 });
  });

  it('a stale epoch is fenced before any ask is applied', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, leaseEpoch: 3 });
    const { processor, closer } = makeProcessor(repo);
    await processor.process('r1', report(runningJob.id, 2), NOW);
    expect(closer.openBash).not.toHaveBeenCalled();
  });

  it('US-006 AC-8: an ask the policy resolves to none is answered with an APPROVAL_ANSWER command in the report transaction', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, bashMode: 'escalate' });
    const { processor, closer } = makeProcessor(repo);
    closer.openBash.mockResolvedValueOnce({ approval: null, live: [], answer: { naxAskId: 'ask-1f2e3d4c', choice: 'allow' } });

    const outcome = await processor.process('r1', report(runningJob.id, runningJob.leaseEpoch), NOW);

    expect(repo.createCommand).toHaveBeenCalledWith({
      runnerId: 'r1', jobId: 'job-1', type: 'APPROVAL_ANSWER', leaseEpoch: 1,
      payload: { approvalId: null, naxAskId: 'ask-1f2e3d4c', choice: 'allow' },
    });
    expect(outcome.approvalLive).toEqual([]);
    expect(outcome.ack).toEqual({ jobId: 'job-1', ackedSeq: 1 });
  });

  it('US-006 AC-9: the denied immediate answer keeps the choice in the command payload', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, bashMode: 'escalate' });
    const { processor, closer } = makeProcessor(repo);
    closer.openBash.mockResolvedValueOnce({ approval: null, live: [], answer: { naxAskId: 'ask-1f2e3d4c', choice: 'deny' } });

    await processor.process('r1', report(runningJob.id, runningJob.leaseEpoch), NOW);

    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ payload: { approvalId: null, naxAskId: 'ask-1f2e3d4c', choice: 'deny' } }));
  });

  it('writes no APPROVAL_ANSWER when the ask was opened as a pending request', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, bashMode: 'escalate' });
    const { processor } = makeProcessor(repo);
    await processor.process('r1', report(runningJob.id, runningJob.leaseEpoch), NOW);
    expect(repo.createCommand).not.toHaveBeenCalled();
  });
});

describe('JobReportProcessor postRun mirror (US-003 AC-7, AC-8)', () => {
  const snapshot = (jobId: string, leaseEpoch: number, postRun: object): JobReport => ({
    jobId, leaseEpoch, events: [{ seq: 1, type: 'snapshot', payload: { postRun } as never }],
  });

  it('AC-7: stores the workflow step of a RUNNING job snapshot', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob });
    const { processor } = makeProcessor(repo);
    const appendEvent = repo.appendEvent.getMockImplementation();
    repo.appendEvent.mockImplementation(async (jobId, event) => {
      expect(currentBookkeepingReason()).toBe('runner.event-log');
      return appendEvent ? appendEvent(jobId, event) : Promise.reject(new Error('appendEvent implementation missing'));
    });
    const update = repo.update.getMockImplementation();
    repo.update.mockImplementation(async (id, patch) => {
      expect(currentBookkeepingReason()).toBe('runner.event-log');
      return update ? update(id, patch) : Promise.reject(new Error('update implementation missing'));
    });
    const out = await processor.process('r1', snapshot(runningJob.id, runningJob.leaseEpoch, { acceptance: 'running', workflowStep: 'branch-review' }), NOW);
    expect(repo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({ postRun: { acceptance: 'running', workflowStep: 'branch-review' } }));
    expect(out.ack).toEqual({ jobId: 'job-1', ackedSeq: 1 });
    expect((await repo.lockById('job-1'))?.postRun).toEqual({ acceptance: 'running', workflowStep: 'branch-review' });
  });

  it('AC-8: a later snapshot replaces the stored workflow step (no merge)', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, postRun: { acceptance: 'running', workflowStep: 'branch-review' } });
    const { processor } = makeProcessor(repo);
    await processor.process('r1', snapshot(runningJob.id, runningJob.leaseEpoch, { acceptance: 'passed', workflowStep: 'publish' }), NOW);
    expect((await repo.lockById('job-1'))?.postRun).toEqual({ acceptance: 'passed', workflowStep: 'publish' });
  });
});

describe('JobReportProcessor config job end (fleet S3 D476: UPLOADING with no bundle)', () => {
  it('applies snapshot(configResult) -> UPLOADING -> COMPLETED in one report with no bundle and no ingest', async () => {
    const repo = makeRepo();
    repo.seed({ ...runningJob, command: 'CONFIG_EDIT', bashMode: 'raw', maxCostUsd: '0' });
    const transitions = {
      apply: vi.fn(async ({ job, to }: { job: FleetJobRecord; to: string }) => {
        expect(currentBookkeepingReason()).toBeUndefined();
        const after = await repo.update(job.id, { state: to as FleetJobRecord['state'] });
        return { job: after, live: { id: `live-${to}`, type: 'fleet_job', projectId: 'p1', jobId: job.id, state: to, at: NOW.toISOString() }, approvalLive: [] };
      }),
    };
    const fence = { holds: () => true, abandon: vi.fn() };
    const live = { event: vi.fn(() => ({ id: 'job-live', type: 'fleet_job', projectId: 'p1', jobId: 'job-1', state: 'RUNNING', at: NOW.toISOString() })) };
    const processor = new JobReportProcessor(repo as never, transitions as never, live as never, fence as never, { record: vi.fn() } as never,
      { signal: vi.fn() } as never, { openBash: vi.fn() } as never, { run: (fn: () => unknown) => fn() } as never, mockAuditRecorder);
    const configResult = { outcome: 'ok', files: ['.nax/context.md', 'AGENTS.md'] };

    const out = await processor.process('r1', {
      jobId: 'job-1', leaseEpoch: 1, events: [
        { seq: 1, type: 'snapshot', payload: { configResult, resultBranch: 'nax-config/job-1', resultSha: 'abc1234', resultPrUrl: 'https://github.com/acme/app/pull/9' } as never },
        { seq: 2, type: 'state', payload: { to: 'UPLOADING' } },
        { seq: 3, type: 'state', payload: { to: 'COMPLETED', reason: 'ok' } },
      ],
    }, NOW);

    expect(out.ack).toEqual({ jobId: 'job-1', ackedSeq: 3 });
    expect(transitions.apply.mock.calls.map(([a]) => a.to)).toEqual(['UPLOADING', 'COMPLETED']);
    expect(transitions.apply.mock.calls[1][0]).toEqual(expect.objectContaining({ reason: 'ok' }));
    expect(repo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({ configResult, resultBranch: 'nax-config/job-1', resultPrUrl: 'https://github.com/acme/app/pull/9' }));
  });
});
