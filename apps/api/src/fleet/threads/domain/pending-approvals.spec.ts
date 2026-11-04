import {
  MAX_PENDING_APPROVALS, appendPendingApproval, readPendingApprovals, removePendingApproval,
  type ThreadPendingApproval,
} from './pending-approvals';

const entry = (n: number): ThreadPendingApproval => ({
  requestId: `r${n}`, tool: 'bash', summary: `Run ${n}`, command: `bun ${n}`, reason: 'reads the worktree', expiresAt: '2026-11-24T01:00:00.000Z',
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
