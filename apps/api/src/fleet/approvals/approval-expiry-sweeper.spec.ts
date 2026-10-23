import { currentContext, type ActionContext } from '../../action-context/action-context';
import { ApprovalExpirySweeper } from './approval-expiry-sweeper';

const NOW = new Date('2026-10-04T10:00:00Z');
const due = { id: 'a1', jobId: 'j1', status: 'pending', expiresAt: new Date(NOW.getTime() - 1) };

function build(over: { sweepEnabled?: boolean; locked?: object | null } = {}) {
  const repo = { findExpiredPending: vi.fn().mockResolvedValue([due]), lockById: vi.fn().mockResolvedValue(over.locked === undefined ? due : over.locked) };
  const jobs = { lockById: vi.fn().mockResolvedValue({ id: 'j1', requestedById: 'u9' }) };
  const closer = { expire: vi.fn().mockResolvedValue({ approval: { ...due, status: 'expired' }, live: [{ approvalId: 'a1' }] }) };
  const live = { publish: vi.fn() };
  const tx = { run: (fn: () => Promise<unknown>) => fn() };
  const sweeper = new ApprovalExpirySweeper(repo as never, jobs as never, closer as never, live as never, tx as never, { sweepEnabled: over.sweepEnabled ?? false, approvalSweepMs: 15_000 });
  return { sweeper, repo, jobs, closer, live };
}

describe('ApprovalExpirySweeper (spec §2.4)', () => {
  it('expires a due ask under job-then-approval locks and publishes after commit', async () => {
    const b = build();
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 1, failed: 0 });
    expect(b.jobs.lockById.mock.invocationCallOrder[0]).toBeLessThan(b.repo.lockById.mock.invocationCallOrder[0]);
    expect(b.closer.expire).toHaveBeenCalledWith(due, { id: 'j1', requestedById: 'u9' }, NOW);
    expect(b.live.publish).toHaveBeenCalledWith([{ approvalId: 'a1' }]);
  });
  it('skips an ask decided between the scan and the lock', async () => {
    const b = build({ locked: { ...due, status: 'approved' } });
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 0 });
    expect(b.closer.expire).not.toHaveBeenCalled();
  });
  it('counts a failure and carries on', async () => {
    const b = build();
    b.closer.expire.mockRejectedValueOnce(new Error('boom'));
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 1 });
  });
  it('AC-5: the interval callback looks for expired asks as SYSTEM/approval (permissions P2 US-004)', async () => {
    vi.useFakeTimers();
    const b = build({ sweepEnabled: true });
    const seen: Array<ActionContext | undefined> = [];
    b.repo.findExpiredPending.mockImplementation(async () => {
      seen.push(currentContext());
      return [];
    });

    b.sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(15_000);
    b.sweeper.onModuleDestroy();
    vi.useRealTimers();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'approval' });
  });
  it('starts no timer unless sweepEnabled', () => {
    vi.useFakeTimers();
    const off = build();
    off.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    const on = build({ sweepEnabled: true });
    on.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    on.sweeper.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
