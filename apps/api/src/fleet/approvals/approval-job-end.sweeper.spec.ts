import { currentContext, type ActionContext } from '../../action-context/action-context';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';
import { ApprovalJobEndSweeper, MAX_ROUNDS_PER_JOB } from './approval-job-end.sweeper';

const NOW = new Date('2026-10-04T10:00:00Z');
const job = { id: 'j1', projectId: 'p1', requestedById: 'u9', requestedByType: 'USER' } as const;
const link = (requestId: string): FleetApprovalAskRecord => ({
  requestId, kind: 'bash', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, naxAskId: `ask-${requestId}`,
  budgetPolicyId: null, resolvedBy: null, outcome: null, createdAt: NOW, updatedAt: NOW,
});

function build(over: { sweepEnabled?: boolean; jobIds?: string[]; pending?: FleetApprovalAskRecord[][] } = {}) {
  const jobIds = over.jobIds ?? ['j1'];
  // One entry per `findPendingForJobPage` call: the last one repeats, so a job that never empties is bounded by
  // MAX_ROUNDS_PER_JOB rather than by the fake.
  const pending = over.pending ?? [[]];
  let page = 0;
  const store = {
    findEndedJobPendingAsks: vi.fn(async (_limit: number) => jobIds),
    findPendingForJobPage: vi.fn(async () => pending[Math.min(page++, pending.length - 1)]),
  };
  const jobs = { findById: vi.fn(async (_id: string) => job) };
  const closer = { closeForJob: vi.fn(async (_job: unknown, _now: Date, _limit?: number) => [{ approvalId: 'a1' }]) };
  const live = { publish: vi.fn() };
  const tx = { run: <T>(fn: () => Promise<T>): Promise<T> => fn() };
  mockAuditRecorder.record.mockClear();
  const sweeper = new ApprovalJobEndSweeper(
    store as never, jobs as never, closer as never, live as never, tx as never,
    { sweepEnabled: over.sweepEnabled ?? false, approvalSweepMs: 15_000 }, mockAuditRecorder,
  );
  return { sweeper, store, jobs, closer, live, tx };
}

describe('ApprovalJobEndSweeper (US-006 F1 round 3)', () => {
  it('closes every job that still has a pending ask, in its own transaction, and publishes the live frames', async () => {
    const b = build({ jobIds: ['j1', 'j2'], pending: [[]] });

    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 2, closed: 2, failed: 0 });

    expect(b.store.findEndedJobPendingAsks).toHaveBeenCalledTimes(1);
    expect(b.jobs.findById.mock.calls).toEqual([['j1'], ['j2']]);
    expect(b.closer.closeForJob.mock.calls).toEqual([[job, NOW], [job, NOW]]);
    expect(b.live.publish).toHaveBeenCalledTimes(2);
    expect(b.live.publish).toHaveBeenCalledWith([{ approvalId: 'a1' }]);
    // The close writes rows, so the system writer accounts for them: one entry per drained job.
    expect(mockAuditRecorder.record).toHaveBeenCalledTimes(2);
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({
      key: 'system.approval.expire', resourceType: 'fleet-job', resourceId: 'j1', projectId: 'p1',
      summary: 'job-ended close: 1 ask',
    });
  });

  it('keeps calling while the job still has pending asks, bounded by MAX_ROUNDS_PER_JOB', async () => {
    const b = build({ pending: [[link('r1')], [link('r2')]] });   // never empties

    await b.sweeper.tick(NOW);

    expect(b.closer.closeForJob).toHaveBeenCalledTimes(MAX_ROUNDS_PER_JOB);
  });

  it('stops as soon as the job has no pending ask left', async () => {
    const b = build();   // the first page after the close is already empty

    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 1, closed: 1, failed: 0 });
    expect(b.closer.closeForJob).toHaveBeenCalledTimes(1);
  });

  it('counts a failing job and carries on with the next one', async () => {
    const b = build({ jobIds: ['j1', 'j2'] });
    b.closer.closeForJob.mockRejectedValueOnce(new Error('boom'));

    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 1, closed: 1, failed: 1 });
    expect(b.closer.closeForJob).toHaveBeenCalledTimes(2);
  });

  it('skips a job row that is gone', async () => {
    const b = build();
    b.jobs.findById.mockResolvedValueOnce(null);

    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 0, closed: 0, failed: 0 });
    expect(b.closer.closeForJob).not.toHaveBeenCalled();
  });

  it('drains as SYSTEM/approval, and starts no timer unless sweepEnabled', async () => {
    vi.useFakeTimers();
    const off = build();
    off.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);

    const on = build({ sweepEnabled: true });
    const seen: Array<ActionContext | undefined> = [];
    on.store.findEndedJobPendingAsks.mockImplementation(async () => {
      seen.push(currentContext());
      return [];
    });
    on.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    on.sweeper.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'approval' });
  });
});
