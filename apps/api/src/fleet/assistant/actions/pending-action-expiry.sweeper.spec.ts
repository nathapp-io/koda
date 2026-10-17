/**
 * Fleet S5b 2a US-007: the expiry sweeper's tick — its batch cap, its per-action transaction with the 2a-D11 lock
 * order, its re-check under the lock, its failure isolation and its timer. Every collaborator is a stub, so each
 * assertion is about what the sweeper decides; the DB-backed behaviour is in
 * test/integration/fleet/assistant-actions-expiry.integration.spec.ts.
 */
import { Logger } from '@nestjs/common';
import { testFleetConfig } from '../../../common/test-helpers/fleet-config';
import type { FleetApprovalRecord } from '../../approvals/domain/approval.domain';
import { MAX_PER_TICK, PendingActionExpirySweeper } from './pending-action-expiry.sweeper';
import type { PendingActionRecord } from './pending-action.domain';

const NOW = new Date('2026-10-24T09:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

const action = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  id: 'act1', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment',
  input: {}, preview: 'p', status: 'PENDING', requestedById: 'u1', approvalId: 'ap1', decidedById: null, decidedAt: null,
  result: null, deliveredAt: null, expiresAt: PAST, createdAt: new Date(NOW.getTime() - 86_400_000), ...over,
});

const approval = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'ap1', type: 'assistant_action', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: null, naxAskId: null, policyId: null,
  payload: { actionId: 'act1', tool: 'koda_add_comment', threadId: 't1', threadPath: '/web/threads/t1', requestedById: 'u1' },
  outcome: null, requestedAt: NOW, expiresAt: PAST, decision: null, decidedById: null, decidedAt: null, resolvedBy: null,
  comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

function build(opts: { due?: PendingActionRecord[]; approval?: FleetApprovalRecord | null; threadGone?: boolean; sweepEnabled?: boolean } = {}) {
  const rows = opts.due ?? [action()];
  const order: string[] = [];
  /** The stored rows, so a `lockById` answers what a concurrent decide would have left behind. */
  const stored = new Map(rows.map((row) => [row.id, row]));
  const actions = {
    // The repository applies the cap itself (its query is `take: limit`); the fake honours it the same way.
    findDue: vi.fn(async (_now: Date, limit: number) => rows.slice(0, limit)),
    lockThread: vi.fn(async () => { order.push('thread'); return !opts.threadGone; }),
    lockById: vi.fn(async (id: string) => { order.push('action'); return stored.get(id) ?? null; }),
  };
  const approvals = { lockById: vi.fn(async () => { order.push('approval'); return opts.approval === undefined ? approval() : opts.approval; }) };
  const decisions = { expireLocked: vi.fn(async (a: PendingActionRecord, ap: FleetApprovalRecord) => ({ approval: ap, live: [{ id: `live-${a.id}` }], noteId: `note-${a.id}` })) };
  const live = { publish: vi.fn() };
  const threads = { publish: vi.fn() };
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const sweeper = new PendingActionExpirySweeper(tx as never, actions as never, approvals as never, decisions as never, live as never, threads as never,
    testFleetConfig({ sweepEnabled: opts.sweepEnabled ?? false, approvalSweepMs: 15_000 }) as never);
  return { sweeper, actions, approvals, decisions, live, threads, tx, order, stored };
}

describe('PendingActionExpirySweeper.tick (2a-D10)', () => {
  it('expires a due action under the thread, approval and action locks (2a-D11) and answers expired 1', async () => {
    const b = build();

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 1, failed: 0 });

    expect(b.actions.findDue).toHaveBeenCalledWith(NOW, MAX_PER_TICK);
    expect(b.order).toEqual(['thread', 'approval', 'action']);
    expect(b.decisions.expireLocked).toHaveBeenCalledWith(expect.objectContaining({ id: 'act1' }), expect.objectContaining({ id: 'ap1', status: 'pending' }), NOW);
  });

  it('publishes the approval live events and the note message and thread frames only after the commit', async () => {
    const b = build();
    let committed = false;
    b.tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { const r = await fn(); committed = true; return r; });
    b.live.publish.mockImplementation(() => expect(committed).toBe(true));
    b.threads.publish.mockImplementation(() => expect(committed).toBe(true));

    await b.sweeper.tick(NOW);

    expect(b.live.publish).toHaveBeenCalledWith([{ id: 'live-act1' }]);
    expect(b.threads.publish.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({ threadId: 't1', at: NOW.toISOString(), type: 'message', messageId: 'note-act1' }),
      expect.objectContaining({ threadId: 't1', at: NOW.toISOString(), type: 'thread' }),
    ]);
    expect(b.tx.run).toHaveBeenCalledTimes(1);
  });

  it('skips an action a decide settled between the scan and the lock, writing nothing', async () => {
    const b = build({ due: [action({ status: 'REJECTED', decidedById: 'u1' })] });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 0 });

    expect(b.decisions.expireLocked).not.toHaveBeenCalled();
    expect(b.live.publish).not.toHaveBeenCalled();
    expect(b.threads.publish).not.toHaveBeenCalled();
  });

  it('skips an action whose expiresAt is still in the future at lock time', async () => {
    const b = build({ due: [action({ expiresAt: FUTURE })] });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 0 });
    expect(b.decisions.expireLocked).not.toHaveBeenCalled();
  });

  it('skips an action whose approval is no longer pending', async () => {
    const b = build({ approval: approval({ status: 'rejected' }) });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 0 });
    expect(b.decisions.expireLocked).not.toHaveBeenCalled();
  });

  it('skips an action whose thread is gone, without taking the other locks', async () => {
    const b = build({ threadGone: true });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 0 });
    expect(b.order).toEqual(['thread']);
  });

  it('expires an action with a 100 ms-less-than-now expiry, so the boundary is included', async () => {
    const b = build({ due: [action({ expiresAt: NOW })] });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 1, failed: 0 });
  });
});

describe('PendingActionExpirySweeper.tick failure isolation', () => {
  it('AC-6: a first action that throws leaves { expired: 1, failed: 1 }', async () => {
    const b = build({ due: [action({ id: 'act1' }), action({ id: 'act2' })] });
    b.decisions.expireLocked.mockRejectedValueOnce(new Error('deadlock'));

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 1, failed: 1 });
  });

  it('AC-12: still attempts every later due action after a failure', async () => {
    const b = build({ due: [action({ id: 'act1' }), action({ id: 'act2' })] });
    b.decisions.expireLocked.mockRejectedValueOnce(new Error('deadlock'));

    await b.sweeper.tick(NOW);

    expect(b.decisions.expireLocked.mock.calls.map(([a]) => (a as PendingActionRecord).id)).toEqual(['act1', 'act2']);
    expect(b.live.publish).toHaveBeenCalledWith([{ id: 'live-act2' }]);
  });

  it('AC-11: logs the failing action and the reason', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const b = build({ due: [action({ id: 'act1' }), action({ id: 'act2' })] });
    b.decisions.expireLocked.mockRejectedValueOnce(new Error('deadlock'));

    await b.sweeper.tick(NOW);

    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(['Action act1 not expired: deadlock']);
  });

  it('a transaction that fails publishes nothing for that action', async () => {
    const b = build();
    b.decisions.expireLocked.mockRejectedValue(new Error('boom'));

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 1 });
    expect(b.live.publish).not.toHaveBeenCalled();
    expect(b.threads.publish).not.toHaveBeenCalled();
  });
});

describe('PendingActionExpirySweeper.tick batch cap', () => {
  it('AC-7: 101 due actions expire 100, and the 101st is never touched', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => action({ id: `act${String(i).padStart(3, '0')}` }));
    const b = build({ due: rows });

    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 100, failed: 0 });

    expect(b.actions.findDue).toHaveBeenCalledWith(NOW, 100);
    expect(b.decisions.expireLocked).toHaveBeenCalledTimes(100);
    expect(b.decisions.expireLocked.mock.calls.map(([a]) => (a as PendingActionRecord).id)).not.toContain('act100');
  });

  it('AC-7: an expired action that is deferred to the next tick is the hundred-and-first, in the order asked', async () => {
    const due = [...Array.from({ length: 100 }, (_, i) => action({ id: `act${i}` })), action({ id: 'deferred' })];
    const b = build({ due });

    await b.sweeper.tick(NOW);

    expect(b.actions.findDue.mock.calls).toEqual([[NOW, MAX_PER_TICK]]);
    expect(b.stored.get('deferred')).toMatchObject({ status: 'PENDING' });
  });
});

describe('PendingActionExpirySweeper timer (2a-D10)', () => {
  it('AC-9: starts no timer when sweepEnabled is off', () => {
    vi.useFakeTimers();
    try {
      const off = build({ sweepEnabled: false });
      off.sweeper.onModuleInit();
      expect(vi.getTimerCount()).toBe(0);
      expect(off.tx.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts one unref-ed interval on approvalSweepMs when sweepEnabled is on, and clears it on destroy', () => {
    vi.useFakeTimers();
    try {
      const on = build({ sweepEnabled: true });
      on.sweeper.onModuleInit();
      expect(vi.getTimerCount()).toBe(1);
      on.sweeper.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing interval tick is logged and never an unhandled rejection', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(Logger.prototype, 'error');
    error.mockClear();
    try {
      const on = build({ sweepEnabled: true });
      on.actions.findDue.mockRejectedValue(new Error('scan failed'));
      on.sweeper.onModuleInit();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(error.mock.calls.map(([message]) => String(message))).toEqual(['Action expiry sweep failed: scan failed']);
    } finally {
      vi.useRealTimers();
    }
  });
});
