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
