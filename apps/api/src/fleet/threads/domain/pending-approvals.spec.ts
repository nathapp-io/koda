import {
  APPROVAL_DELIVERY_DETAIL_MAX, MAX_PENDING_APPROVALS, appendPendingApproval, readPendingApprovals, removePendingApproval,
  setApprovalDelivery,
  type ThreadApprovalDelivery,
  type ThreadPendingApproval,
} from './pending-approvals';

const entry = (n: number): ThreadPendingApproval => ({
  requestId: `r${n}`, tool: 'bash', summary: `Run ${n}`, command: `bun ${n}`, reason: 'reads the worktree', expiresAt: '2026-11-24T01:00:00.000Z',
});

const delivery = (over: Partial<ThreadApprovalDelivery> = {}): ThreadApprovalDelivery => ({
  decision: 'allow', result: 'rejected', detail: 'expired', at: '2026-11-24T00:30:00.000Z', ...over,
});

describe('readPendingApprovals (US-007)', () => {
  it('answers an empty list for a thread that has no pending approvals', () => {
    expect(readPendingApprovals(null)).toEqual([]);
    expect(readPendingApprovals(undefined)).toEqual([]);
  });

  it('answers an empty list for a column that holds something other than a list', () => {
    expect(readPendingApprovals({ requestId: 'r1' })).toEqual([]);
    expect(readPendingApprovals('garbage')).toEqual([]);
  });

  it('keeps the stored entries in their stored order', () => {
    expect(readPendingApprovals([entry(1), entry(2)])).toEqual([entry(1), entry(2)]);
  });

  it('drops an entry that is missing its tool, summary or expiresAt', () => {
    expect(readPendingApprovals([{ ...entry(1), tool: undefined }, { ...entry(2), expiresAt: 7 }, entry(3)])).toEqual([entry(3)]);
  });

  // B3: the stored decision outcome comes back with its request, so a page load after a runner refusal can say why.
  it('B3: keeps a stored delivery and drops one this version cannot read', () => {
    expect(readPendingApprovals([{ ...entry(1), delivery: delivery() }])).toEqual([{ ...entry(1), delivery: delivery() }]);
    expect(readPendingApprovals([{ ...entry(1), delivery: delivery({ result: 'maybe' as never }) }])).toEqual([entry(1)]);
    expect(readPendingApprovals([{ ...entry(1), delivery: { decision: 'allow', result: 'rejected', detail: 'x', at: 'not-a-date' } }]))
      .toEqual([entry(1)]);
  });
});

describe('setApprovalDelivery (B3)', () => {
  it('records the outcome on the request it decided and leaves the others alone', () => {
    expect(setApprovalDelivery([entry(1), entry(2)], 'r2', delivery())).toEqual([entry(1), { ...entry(2), delivery: delivery() }]);
  });

  it('answers null for a request the session already resolved', () => {
    expect(setApprovalDelivery([entry(1)], 'r9', delivery())).toBeNull();
  });

  it('answers null when the entry already holds that very outcome', () => {
    expect(setApprovalDelivery([{ ...entry(1), delivery: delivery() }], 'r1', delivery())).toBeNull();
  });

  it('replaces an earlier outcome with the newer one', () => {
    const older = delivery({ decision: 'deny', at: '2026-11-24T00:20:00.000Z' });
    expect(setApprovalDelivery([{ ...entry(1), delivery: older }], 'r1', delivery()))
      .toEqual([{ ...entry(1), delivery: delivery() }]);
  });

  it('bounds the stored detail, so what it writes is what it can read back', () => {
    const long = 'x'.repeat(APPROVAL_DELIVERY_DETAIL_MAX + 50);
    const stored = setApprovalDelivery([entry(1)], 'r1', delivery({ detail: long.slice(0, APPROVAL_DELIVERY_DETAIL_MAX) }));
    expect(readPendingApprovals(stored)).toEqual([{ ...entry(1), delivery: delivery({ detail: 'x'.repeat(APPROVAL_DELIVERY_DETAIL_MAX) }) }]);
    expect(readPendingApprovals([{ ...entry(1), delivery: delivery({ detail: long }) }])).toEqual([entry(1)]);
  });
});

describe('appendPendingApproval (US-007)', () => {
  it('appends the newest request after the older ones', () => {
    expect(appendPendingApproval([entry(1)], entry(2))).toEqual([entry(1), entry(2)]);
  });

  it('answers null for a request that is already listed', () => {
    expect(appendPendingApproval([entry(1), entry(2)], entry(1))).toBeNull();
  });

  it('answers null for a 21st request, keeping the oldest twenty', () => {
    const twenty = Array.from({ length: MAX_PENDING_APPROVALS }, (_, i) => entry(i + 1));
    expect(MAX_PENDING_APPROVALS).toBe(20);
    expect(appendPendingApproval(twenty, entry(21))).toBeNull();
    expect(appendPendingApproval(twenty.slice(1), entry(21))).toEqual([...twenty.slice(1), entry(21)]);
  });
});

describe('removePendingApproval (US-007)', () => {
  it('removes the matching request and leaves the others in order', () => {
    expect(removePendingApproval([entry(1), entry(2), entry(3)], 'r2')).toEqual([entry(1), entry(3)]);
  });

  it('answers null when the request is not listed', () => {
    expect(removePendingApproval([entry(1)], 'r9')).toBeNull();
  });
});
