import { describe, expect, test } from '@jest/globals'
import {
  DETAIL_FETCH_LIMIT,
  MAX_REQUEST_COMMENT,
  buildCommentSchema,
  buildRequestQuery,
  inboxHref,
  requestKeyLabel,
  sortPendingRequests,
  viewerActions,
} from '~/lib/approval-requests'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'

/** vue-i18n's `t`, standing in for the real one: the key is the message. */
const t = (key: string): string => key
const knows = (keys: readonly string[]) => (key: string): boolean => keys.includes(key)

const summary = (over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id: 'r1',
  permissionKey: 'label.create',
  projectId: 'p1',
  actorType: 'AGENT',
  actorId: 'a1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'api',
  redeem: true,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-11-01T00:00:00Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-31T00:00:00Z',
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-1 / AC-2 — the list query
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-1: the pending tab is one page of 100', () => {
  test('AC-1: buildRequestQuery({ tab: pending }) is exactly the pending query', () => {
    expect(buildRequestQuery({ tab: 'pending' })).toEqual({ status: 'pending', size: '100' })
  })

  test('AC-1 (edge): a bare pending status is also one page of 100, status kept', () => {
    expect(buildRequestQuery({ status: 'pending' })).toEqual({ status: 'pending', size: '100' })
  })
})

describe('US-001 AC-2: the All tab pages by 20 and sends current only after page 1', () => {
  test('AC-2: page 3 with a project is exactly { size, current, projectId }', () => {
    expect(buildRequestQuery({ tab: 'all', page: 3, projectId: 'p1' }))
      .toEqual({ size: '20', current: '3', projectId: 'p1' })
  })

  test('AC-2 (edge): page 1 sends no current', () => {
    expect(buildRequestQuery({ tab: 'all', page: 1 })).toEqual({ size: '20' })
  })

  test('AC-2 (edge): a settled status pages by 20 and filters by key and job', () => {
    expect(buildRequestQuery({ tab: 'all', status: 'executed', permissionKey: 'label.create', jobId: 'j1' }))
      .toEqual({ status: 'executed', permissionKey: 'label.create', jobId: 'j1', size: '20' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-3 — pending rows in expiry order
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-3: sortPendingRequests is soonest expiry first', () => {
  test('AC-3: the 2026-11-01 row comes before the 2026-11-02 row', () => {
    const later = summary({ id: 'later', expiresAt: '2026-11-02T00:00:00Z' })
    const sooner = summary({ id: 'sooner', expiresAt: '2026-11-01T00:00:00Z' })

    expect(sortPendingRequests([later, sooner]).map((r) => r.id)).toEqual(['sooner', 'later'])
  })

  test('AC-3 (edge): equal expiries keep a stable order and a missing one sorts last', () => {
    const a = summary({ id: 'a', expiresAt: '2026-11-01T00:00:00Z' })
    const b = summary({ id: 'b', expiresAt: '2026-11-01T00:00:00Z' })
    const none = summary({ id: 'none', expiresAt: null })

    expect(sortPendingRequests([none, b, a]).map((r) => r.id)).toEqual(['a', 'b', 'none'])
  })

  test('AC-3 (edge): the input array is not mutated', () => {
    const rows = [summary({ id: 'later', expiresAt: '2026-11-02T00:00:00Z' }), summary({ id: 'sooner', expiresAt: '2026-11-01T00:00:00Z' })]

    sortPendingRequests(rows)

    expect(rows.map((r) => r.id)).toEqual(['later', 'sooner'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-4..AC-7 — who sees which control, from the row alone
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-4..AC-7: viewerActions reads the row', () => {
  test('AC-4: my own human-mode request shows Cancel only', () => {
    const row = summary({ actorType: 'USER', actorId: 'u1', requiredMode: 'human' })

    expect(viewerActions(row, 'u1')).toEqual({ decide: false, cancel: true })
  })

  test('AC-5: my own self-mode request shows the decide controls and Cancel', () => {
    const row = summary({ actorType: 'USER', actorId: 'u1', requiredMode: 'self' })

    expect(viewerActions(row, 'u1')).toEqual({ decide: true, cancel: true })
  })

  test('AC-6: an agent request shows the decide controls and no Cancel', () => {
    const row = summary({ actorType: 'AGENT', actorId: 'a1', requiredMode: 'human' })

    expect(viewerActions(row, 'u1')).toEqual({ decide: true, cancel: false })
  })

  test('AC-7: a settled request shows nothing', () => {
    const row = summary({ status: 'executed', actorType: 'USER', actorId: 'u1', requiredMode: 'self' })

    expect(viewerActions(row, 'u1')).toEqual({ decide: false, cancel: false })
  })

  test('AC-7 (edge): another user owns the request — not mine, so I may decide and not cancel', () => {
    const row = summary({ actorType: 'USER', actorId: 'u2', requiredMode: 'self' })

    expect(viewerActions(row, 'u1')).toEqual({ decide: true, cancel: false })
  })

  test('AC-7 (edge): a request raised on my behalf is decidable, never cancellable', () => {
    const row = summary({ actorType: 'AGENT', actorId: 'a1', onBehalfOfType: 'USER', onBehalfOfId: 'u1' })

    expect(viewerActions(row, 'u1')).toEqual({ decide: true, cancel: false })
  })

  test('AC-7 (edge): a signed-out viewer is nobody\'s requester', () => {
    const row = summary({ actorType: 'USER', actorId: 'u1', requiredMode: 'self' })

    expect(viewerActions(row, null)).toEqual({ decide: true, cancel: false })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-8 — the inbox link
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-8: inboxHref', () => {
  test('AC-8: a project request opens the project inbox on that row', () => {
    expect(inboxHref('sandbox', 'r1')).toBe('/sandbox/approvals?id=r1')
  })

  test('AC-8 (edge): no request id is the list itself', () => {
    expect(inboxHref('sandbox')).toBe('/sandbox/approvals')
  })

  test('AC-8 (edge): no project is the global inbox, and ids are escaped', () => {
    expect(inboxHref(null, 'r1')).toBe('/approvals?id=r1')
    expect(inboxHref('a b', 'r/1')).toBe('/a%20b/approvals?id=r%2F1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-9 — key labels
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-9: requestKeyLabel falls back to the raw key', () => {
  test('AC-9: an unknown key stays raw', () => {
    expect(requestKeyLabel(t, knows([]), 'label.create')).toBe('label.create')
  })

  test('AC-9: a known key reads approvals.keys.<key with dots replaced>', () => {
    const te = knows(['approvals.keys.fleet_budget_override'])

    expect(requestKeyLabel(t, te, 'fleet.budget.override')).toBe('approvals.keys.fleet_budget_override')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-10 — the comment schema
// ─────────────────────────────────────────────────────────────────────────────

describe('US-001 AC-10: buildCommentSchema caps the comment at 2000 characters', () => {
  test('AC-10: a 2001-character comment is rejected with approvals.comment.tooLong', () => {
    const result = buildCommentSchema(t).safeParse({ comment: 'x'.repeat(MAX_REQUEST_COMMENT + 1) })

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['approvals.comment.tooLong'])
  })

  test('AC-10 (edge): exactly 2000 characters pass, and so does a blank comment', () => {
    const schema = buildCommentSchema(t)

    expect(schema.safeParse({ comment: 'x'.repeat(MAX_REQUEST_COMMENT) }).success).toBe(true)
    expect(schema.safeParse({ comment: '' }).success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The constants the rest of the feature reads
// ─────────────────────────────────────────────────────────────────────────────

describe('approval-requests constants', () => {
  test('the detail fetch limit and the engine comment cap are the spec values', () => {
    expect(DETAIL_FETCH_LIMIT).toBe(20)
    expect(MAX_REQUEST_COMMENT).toBe(2000)
  })
})
