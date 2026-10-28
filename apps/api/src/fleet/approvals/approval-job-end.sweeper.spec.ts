import { currentContext, type ActionContext } from '../../action-context/action-context';
import type { AuditRecordInput } from '../../audit/audit-recorder.service';
import type { JobEndAsk } from './domain/fleet-approval-ask.domain';
import { ApprovalJobEndSweeper, MAX_ASKS_PER_TICK } from './approval-job-end.sweeper';

const NOW = new Date('2026-10-04T10:00:00Z');
const job = { id: 'j1', state: 'COMPLETED', projectId: 'p1', requestedById: 'u9', requestedByType: 'USER' } as const;
const ask = (requestId = 'a1', jobId = 'j1'): JobEndAsk => ({ requestId, jobId, projectId: 'p1' });

function build(batch: JobEndAsk[] = [ask()], sweepEnabled = false) {
  let active = false;
  const store = { claimEndedJobAsks: vi.fn(async (_limit: number) => batch) };
  const jobs = { findById: vi.fn(async (_id: string): Promise<typeof job | null> => job) };
  const closer = { closeJobAsk: vi.fn(async (_job: unknown, _requestId: string, _now: Date) =>
    ({ approval: { id: 'a1' } as { id: string } | null, live: [{ approvalId: 'a1' }] })) };
  const live = { publish: vi.fn(() => { expect(active).toBe(false); }) };
  const audit = { record: vi.fn(async (_entry: AuditRecordInput) => { expect(active).toBe(true); }) };
  const tx = { run: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
    expect(active).toBe(false);
    active = true;
    try { return await fn(); } finally { active = false; }
  }) };
  const sweeper = new ApprovalJobEndSweeper(
    store as never, jobs as never, closer as never, live as never, tx as never,
    { sweepEnabled, approvalSweepMs: 15_000 }, audit as never,
  );
  return { sweeper, store, jobs, closer, live, tx, audit };
}

describe('ApprovalJobEndSweeper (fair durable continuation)', () => {
  it('schedules one bounded batch, closes exact asks in separate audited transactions, publishes after commit', async () => {
    const b = build([ask(), ask('a2', 'j2')]);
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 2, closed: 2, failed: 0 });
    expect(b.store.claimEndedJobAsks).toHaveBeenCalledExactlyOnceWith(MAX_ASKS_PER_TICK);
    expect(b.closer.closeJobAsk.mock.calls).toEqual([[job, 'a1', NOW], [job, 'a2', NOW]]);
    expect(b.tx.run).toHaveBeenCalledTimes(3); // scheduling + two atomic closes
    expect(b.audit.record.mock.calls.map(([entry]) => entry.summary)).toEqual([
      'job-end close scheduled', 'job-end close scheduled', 'job-ended close: 1 ask', 'job-ended close: 1 ask',
    ]);
    expect(b.live.publish).toHaveBeenCalledTimes(2);
  });

  it('advances to the next selected ask even if the first is held, without restarting a job page', async () => {
    const b = build([ask(), ask('a2')]);
    b.closer.closeJobAsk.mockResolvedValueOnce({ approval: null, live: [] });
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 1, closed: 1, failed: 0 });
    expect(b.closer.closeJobAsk).toHaveBeenCalledTimes(2);
    expect(b.audit.record).toHaveBeenCalledTimes(3); // two attempts + one close
  });

  it('counts a failing ask and carries on; the scheduling transaction already committed its rotation', async () => {
    const b = build([ask(), ask('a2')]);
    b.closer.closeJobAsk.mockRejectedValueOnce(new Error('boom'));
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 1, closed: 1, failed: 1 });
    expect(b.live.publish).toHaveBeenCalledTimes(1);
  });

  it('does not publish a close whose transaction fails on audit', async () => {
    const b = build();
    b.audit.record.mockImplementation(async (entry) => {
      if (entry.summary?.startsWith('job-ended close:')) throw new Error('audit unavailable');
    });
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 0, closed: 0, failed: 1 });
    expect(b.live.publish).not.toHaveBeenCalled();
  });

  it('counts and audits a closed ask even when it has no live channel', async () => {
    const b = build();
    b.closer.closeJobAsk.mockResolvedValueOnce({ approval: { id: 'a1' }, live: [] });
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 1, closed: 1, failed: 0 });
    expect(b.audit.record).toHaveBeenCalledTimes(2);
    expect(b.live.publish).not.toHaveBeenCalled();
  });

  it('skips a job row that is gone or running again', async () => {
    const b = build([ask(), ask('a2')]);
    b.jobs.findById.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...job, state: 'RUNNING' } as never);
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 0, closed: 0, failed: 0 });
    expect(b.closer.closeJobAsk).not.toHaveBeenCalled();
  });

  it('does no close and no audit write for an empty batch', async () => {
    const b = build([]);
    expect(await b.sweeper.tick(NOW)).toEqual({ jobs: 0, closed: 0, failed: 0 });
    expect(b.audit.record).not.toHaveBeenCalled();
  });

  it('drains as SYSTEM/approval, and starts no timer unless sweepEnabled', async () => {
    vi.useFakeTimers();
    const off = build();
    const on = build([], true);
    const seen: Array<ActionContext | undefined> = [];
    on.store.claimEndedJobAsks.mockImplementation(async () => { seen.push(currentContext()); return []; });
    try {
      off.sweeper.onModuleInit();
      expect(vi.getTimerCount()).toBe(0);
      on.sweeper.onModuleInit();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
    } finally {
      on.sweeper.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'approval' });
  });
});
