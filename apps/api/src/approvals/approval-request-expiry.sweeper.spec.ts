/**
 * P3 approval core US-012 — the expiry sweeper, without a database.
 *
 * The timer wiring (AC-9) and the per-request rules that do not need a real row are unit tests here;
 * the Postgres-backed ACs live in `test/integration/approvals/approval-expiry.integration.spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { currentContext, type ActionContext } from '../action-context/action-context';
import {
  ApprovalRequestExpirySweeper,
  MAX_PER_TICK,
  type ApprovalRequestExpiryResult,
} from './approval-request-expiry.sweeper';
import type { ApprovalRequestRecord, ApprovalRequestStatus } from './domain/approval.domain';

const NOW = new Date('2026-11-06T09:00:00Z');
const SECOND = 1_000;

const request = (patch: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  id: 'r1',
  permissionKey: 'label.delete',
  projectId: 'p1',
  actor: { type: 'AGENT', id: 'a1' },
  onBehalfOf: null,
  origin: 'rest',
  correlationId: 'c1',
  input: { labelId: 'l1' },
  inputHash: 'hash',
  requiredMode: 'agent',
  policyId: null,
  onTimeout: 'reject',
  approverMustHoldAction: true,
  requireDistinctApprover: false,
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: new Date(NOW.getTime() - SECOND),
  decidedAt: null,
  settledAt: null,
  result: null,
  createdAt: new Date(NOW.getTime() - 100 * SECOND),
  ...patch,
});

interface BuildOptions {
  due?: ApprovalRequestRecord[];
  /** Returned by `lockById` for every id when set; `null` means "the row is gone". */
  locked?: ApprovalRequestRecord | null;
  /** The one id whose `lockById` throws, to exercise the loop's error isolation. */
  lockThrowsId?: string;
  sweepEnabled?: boolean;
  executionThrows?: boolean;
  stale?: ApprovalRequestRecord[];
}

function build(over: BuildOptions = {}) {
  const due = over.due ?? [request()];
  const requests = {
    // The repository applies the limit (`take`); the mock honours it too, so a case that queues more
    // rows than one tick may settle sees the same batch the real query would return.
    findDue: vi.fn<(now: Date, limit: number) => Promise<ApprovalRequestRecord[]>>()
      .mockImplementation(async (_now, limit) => due.slice(0, limit)),
    findStaleApproved: vi.fn<(before: Date, limit: number) => Promise<ApprovalRequestRecord[]>>()
      .mockImplementation(async (_before, limit) => (over.stale ?? []).slice(0, limit)),
    lockById: vi.fn<(id: string) => Promise<ApprovalRequestRecord | null>>(async (id) => {
      if (id === over.lockThrowsId) throw new Error('lock refused');
      if (over.locked !== undefined) return over.locked;
      return due.find((row) => row.id === id) ?? null;
    }),
    canSettleTimeout: vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true),
    transition: vi.fn<
      (id: string, from: ApprovalRequestStatus, patch: Partial<ApprovalRequestRecord>) => Promise<ApprovalRequestRecord | null>
    >(async (id, _from, patch) => {
      const base = due.find((row) => row.id === id);
      return base === undefined ? null : { ...base, ...patch };
    }),
  };
  const audit = { record: vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined) };
  const execution = {
    execute: vi.fn<(id: string) => Promise<ApprovalRequestRecord>>(async (id) => {
      if (over.executionThrows === true) throw new Error('commit failed');
      return request({ id, status: 'executed', satisfiedBy: 'none' });
    }),
  };
  const tx = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => true),
  };
  const config = { sweepEnabled: over.sweepEnabled ?? false, approvalSweepMs: 15_000 };
  const events = { record: vi.fn().mockResolvedValue(undefined) };

  const sweeper = new ApprovalRequestExpirySweeper(
    tx as never,
    requests as never,
    audit as never,
    execution as never,
    config,
    events as never,
  );
  return { sweeper, requests, audit, execution, tx, config, events };
}

describe('ApprovalRequestExpirySweeper lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-9: with the sweep disabled, onModuleInit starts no interval and tick never runs', async () => {
    vi.useFakeTimers();
    const b = build({ sweepEnabled: false });
    const tick = vi.spyOn(b.sweeper, 'tick');

    b.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(b.config.approvalSweepMs * 4);
    expect(tick).not.toHaveBeenCalled();
    expect(b.requests.findDue).not.toHaveBeenCalled();

    b.sweeper.onModuleDestroy();
  });

  it('starts one interval when the sweep is enabled and clears it on destroy', async () => {
    vi.useFakeTimers();
    const b = build({ sweepEnabled: true, due: [] });

    b.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(b.config.approvalSweepMs);
    expect(b.requests.findDue).toHaveBeenCalledTimes(1);

    b.sweeper.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a failing interval sweep instead of rejecting into the timer', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    error.mockClear();
    vi.useFakeTimers();
    const b = build({ sweepEnabled: true, due: [] });
    b.requests.findDue.mockRejectedValue(new Error('db down'));

    b.sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(b.config.approvalSweepMs);
    b.sweeper.onModuleDestroy();

    expect(error.mock.calls.map(([message]) => String(message))).toEqual([
      'Approval request expiry sweep failed: db down',
    ]);
  });
});

describe('ApprovalRequestExpirySweeper.retryStale', () => {
  it('uses the five-minute cutoff and caps the scan', async () => {
    const b = build();
    await b.sweeper.retryStale(NOW);
    expect(b.requests.findStaleApproved).toHaveBeenCalledWith(new Date(NOW.getTime() - 300_000), MAX_PER_TICK);
  });

  it('executes every stale request sequentially and counts successes', async () => {
    const stale = [request({ id: 'r1', status: 'approved' }), request({ id: 'r2', status: 'approved' })];
    const b = build({ stale });
    const order: string[] = [];
    b.execution.execute.mockImplementation(async (id) => {
      order.push(`start-${id}`);
      await Promise.resolve();
      order.push(`end-${id}`);
      return request({ id, status: 'executed' });
    });
    expect(await b.sweeper.retryStale(NOW)).toEqual({ retried: 2, failed: 0 });
    expect(order).toEqual(['start-r1', 'end-r1', 'start-r2', 'end-r2']);
    expect(b.execution.execute.mock.calls).toEqual([['r1', NOW], ['r2', NOW]]);
  });

  it('does not count requests settled by another writer', async () => {
    const b = build({ stale: [request({ status: 'approved' })] });
    b.execution.execute.mockRejectedValue(new (await import('./domain/approval.errors')).ApprovalRequestNotPendingError('executed'));
    expect(await b.sweeper.retryStale(NOW)).toEqual({ retried: 0, failed: 0 });
  });

  it('continues after an execution failure, counts it, and warns with its id', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const b = build({ stale: [request({ id: 'r1', status: 'approved' }), request({ id: 'r2', status: 'approved' })] });
    b.execution.execute.mockRejectedValueOnce(new Error('boom'));
    expect(await b.sweeper.retryStale(NOW)).toEqual({ retried: 1, failed: 1 });
    expect(b.execution.execute).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('r1'));
  });

  it('runs tick then retry on the enabled interval', async () => {
    vi.useFakeTimers();
    const b = build({ sweepEnabled: true, due: [], stale: [] });
    const calls: string[] = [];
    vi.spyOn(b.sweeper, 'tick').mockImplementation(async () => { calls.push('tick'); return { expired: 0, approved: 0, failed: 0 }; });
    vi.spyOn(b.sweeper, 'retryStale').mockImplementation(async () => { calls.push('retry'); return { retried: 0, failed: 0 }; });
    b.sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(b.config.approvalSweepMs);
    expect(calls).toEqual(['tick', 'retry']);
    b.sweeper.onModuleDestroy();
  });

  it('does not start a timer when disabled', () => {
    vi.useFakeTimers();
    const b = build({ sweepEnabled: false });
    b.sweeper.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    b.sweeper.onModuleDestroy();
  });
});

describe('ApprovalRequestExpirySweeper.tick', () => {
  it('runs as SYSTEM/approval and asks for at most MAX_PER_TICK due requests', async () => {
    const b = build({ due: [] });
    const seen: Array<ActionContext | undefined> = [];
    b.requests.findDue.mockImplementation(async () => {
      seen.push(currentContext());
      return [];
    });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 0, failed: 0 });

    expect(MAX_PER_TICK).toBe(100);
    expect(b.requests.findDue).toHaveBeenCalledWith(NOW, MAX_PER_TICK);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'approval' });
    expect(seen[0]?.origin).toBe('system');
  });

  it('expires a reject-on-timeout request and records the system entry in its transaction', async () => {
    const b = build();
    const result: ApprovalRequestExpiryResult = await b.sweeper.tick(NOW);

    expect(result).toEqual({ expired: 1, approved: 0, failed: 0 });
    expect(b.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'expired' }));
    expect(b.tx.run).toHaveBeenCalledTimes(1);
    expect(b.requests.transition).toHaveBeenCalledWith('r1', 'pending', { status: 'expired', settledAt: NOW });
    expect(b.audit.record).toHaveBeenCalledWith({
      key: 'system.approval.expire', resourceType: 'approval-request', resourceId: 'r1', projectId: 'p1',
      summary: 'expired label.delete',
    });
    expect(b.execution.execute).not.toHaveBeenCalled();
  });

  it('approves on timeout with no approver and executes only after the commit', async () => {
    const due = request({ onTimeout: 'approve' });
    const b = build({ due: [due] });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 1, failed: 0 });

    expect(b.requests.transition).toHaveBeenCalledWith('r1', 'pending', {
      status: 'approved', decidedAt: NOW, satisfiedBy: 'none',
    });
    expect(b.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'approved' }));
    expect(b.audit.record).toHaveBeenCalledWith({
      key: 'system.approval.expire', resourceType: 'approval-request', resourceId: 'r1', projectId: 'p1',
      summary: 'approved on timeout label.delete',
    });
    // The execute seam runs after the settling transaction closed.
    expect(b.execution.execute).toHaveBeenCalledWith('r1');
    expect(b.tx.run.mock.invocationCallOrder[0]).toBeLessThan(
      b.execution.execute.mock.invocationCallOrder[0] as number,
    );
  });

  it.each(['reject', 'approve'] as const)('defers %s-on-timeout to job-end cancellation after locking the request', async (onTimeout) => {
    const b = build({ due: [request({ permissionKey: 'fleet.job.shell.escalate', onTimeout })] });
    b.requests.canSettleTimeout.mockResolvedValue(false);
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 0, failed: 0 });
    expect(b.requests.canSettleTimeout).toHaveBeenCalledExactlyOnceWith('r1');
    expect(b.requests.lockById.mock.invocationCallOrder[0]).toBeLessThan(b.requests.canSettleTimeout.mock.invocationCallOrder[0] as number);
    expect(b.requests.transition).not.toHaveBeenCalled();
    expect(b.events.record).not.toHaveBeenCalled();
    expect(b.audit.record).not.toHaveBeenCalled();
    expect(b.execution.execute).not.toHaveBeenCalled();
  });

  it('skips a request another writer settled between the scan and the lock', async () => {
    const b = build({ locked: request({ status: 'rejected' }) });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 0, failed: 0 });
    expect(b.requests.transition).not.toHaveBeenCalled();
    expect(b.audit.record).not.toHaveBeenCalled();
  });

  it('skips a request that is no longer due under the lock', async () => {
    const b = build({ locked: request({ expiresAt: new Date(NOW.getTime() + 60 * SECOND) }) });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 0, failed: 0 });
    expect(b.requests.transition).not.toHaveBeenCalled();
  });

  it('skips a request whose row vanished under the lock', async () => {
    const b = build({ locked: null });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 0, failed: 0 });
    expect(b.requests.transition).not.toHaveBeenCalled();
  });

  it('counts a lost transition under the lock as a failure and records no entry', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const b = build();
    b.requests.transition.mockResolvedValue(null);

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 0, failed: 1 });

    expect(b.audit.record).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'Approval request r1 not settled: Approval request is not pending: pending',
    ]);
  });

  it('counts one failing request, logs it at warn and expiring the next one still works', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const due = [request({ id: 'r1' }), request({ id: 'r2' })];
    const b = build({ due, lockThrowsId: 'r1' });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 1, approved: 0, failed: 1 });

    expect(b.requests.transition).toHaveBeenCalledTimes(1);
    expect(b.requests.transition).toHaveBeenCalledWith('r2', 'pending', { status: 'expired', settledAt: NOW });
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(['Approval request r1 not settled: lock refused']);
  });

  it('counts a timeout approval whose execution throws as approved and failed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const b = build({ due: [request({ onTimeout: 'approve' })], executionThrows: true });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, approved: 1, failed: 1 });
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(['Approval request r1 not executed: commit failed']);
  });

  it('settles at most MAX_PER_TICK of 101 due requests in one tick', async () => {
    const due = Array.from({ length: MAX_PER_TICK + 1 }, (_, index) => request({ id: `r${String(index).padStart(3, '0')}` }));
    const b = build({ due });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: MAX_PER_TICK, approved: 0, failed: 0 });
    expect(b.requests.transition).toHaveBeenCalledTimes(MAX_PER_TICK);
    expect(b.requests.transition.mock.calls.map(([id]) => id)).not.toContain(`r${String(MAX_PER_TICK).padStart(3, '0')}`);
  });
});
