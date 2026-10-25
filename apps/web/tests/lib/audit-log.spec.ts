import { describe, expect, test } from '@jest/globals'
import {
  AUDIT_PAGE_SIZE,
  EMPTY_AUDIT_FILTERS,
  auditApiQuery,
  auditRouteQuery,
  parseAuditRoute,
  principalLabel,
  relatedFilters,
  withFilter,
  type AuditFilters,
} from '~/lib/audit-log'

const filters = (over: Partial<AuditFilters> = {}): AuditFilters => ({ ...EMPTY_AUDIT_FILTERS, ...over })

describe('EMPTY_AUDIT_FILTERS', () => {
  test('every filter field is empty and the page is 1', () => {
    expect(EMPTY_AUDIT_FILTERS).toEqual({
      key: '',
      actorType: '',
      actorId: '',
      approverId: '',
      projectId: '',
      resourceType: '',
      resourceId: '',
      correlationId: '',
      from: '',
      to: '',
      page: 1,
    })
    expect(AUDIT_PAGE_SIZE).toBe(50)
  })
})

describe('parseAuditRoute (spec §3.5 URL filters)', () => {
  // AC-1
  test('an empty query is EMPTY_AUDIT_FILTERS', () => {
    expect(parseAuditRoute({})).toEqual(EMPTY_AUDIT_FILTERS)
  })

  // AC-2
  test('reads a trimmed string, the first of an array, the dates and the page', () => {
    const parsed = parseAuditRoute({
      key: ' ticket.create ',
      actorId: ['a1', 'a2'],
      projectId: 'p1',
      from: '2026-10-01',
      page: '3',
    })
    expect(parsed).toEqual(filters({ key: 'ticket.create', actorId: 'a1', projectId: 'p1', from: '2026-10-01', page: 3 }))
  })

  // AC-3
  test('an unknown actor type, a non-date and a non-numeric page fall back to defaults', () => {
    expect(parseAuditRoute({ actorType: 'BOGUS', to: 'yesterday', page: 'abc' })).toEqual(EMPTY_AUDIT_FILTERS)
  })

  // AC-4
  test('over-long values are cut to the API limit of 128, so a hand-edited URL never answers 400', () => {
    const parsed = parseAuditRoute({ resourceId: 'r'.repeat(200) })
    expect(parsed.resourceId).toHaveLength(128)
  })

  test('every value field is cut to 128 and an array member that is null is ignored', () => {
    const long = 'x'.repeat(200)
    const parsed = parseAuditRoute({
      key: long,
      actorId: [null, long],
      approverId: long,
      projectId: long,
      resourceType: long,
      correlationId: long,
      to: long,
    })
    expect(parsed.key).toHaveLength(128)
    expect(parsed.actorId).toBe('')
    expect(parsed.approverId).toHaveLength(128)
    expect(parsed.projectId).toHaveLength(128)
    expect(parsed.resourceType).toHaveLength(128)
    expect(parsed.correlationId).toHaveLength(128)
    // A cut date is no longer YYYY-MM-DD, so it is dropped rather than sent as a broken window.
    expect(parsed.to).toBe('')
  })

  test('accepts every actor type and drops a zero or fractional page', () => {
    for (const actorType of ['USER', 'AGENT', 'RUNNER', 'SYSTEM'] as const) {
      expect(parseAuditRoute({ actorType }).actorType).toBe(actorType)
    }
    expect(parseAuditRoute({ page: '0' }).page).toBe(1)
    expect(parseAuditRoute({ page: '1.5' }).page).toBe(1)
    expect(parseAuditRoute({ page: ['2', '3'] }).page).toBe(2)
  })

  test('null and undefined values are empty, never the string "null"', () => {
    expect(parseAuditRoute({ key: null, actorId: undefined, from: null })).toEqual(EMPTY_AUDIT_FILTERS)
  })
})

describe('auditRouteQuery', () => {
  // AC-5
  test('emits only the set fields and the page only above 1', () => {
    expect(auditRouteQuery(filters({ key: 'ticket.create', page: 2 }))).toEqual({ key: 'ticket.create', page: '2' })
    expect(auditRouteQuery(EMPTY_AUDIT_FILTERS)).toEqual({})
    expect(auditRouteQuery(filters({ key: 'ticket.create', page: 1 }))).toEqual({ key: 'ticket.create' })
  })

  test('round-trips through parseAuditRoute', () => {
    const original = filters({
      key: 'comment.create',
      actorType: 'AGENT',
      actorId: 'a1',
      approverId: 'u9',
      projectId: 'p1',
      resourceType: 'ticket',
      resourceId: 't1',
      correlationId: 'c-1',
      from: '2026-10-01',
      to: '2026-10-31',
      page: 4,
    })
    expect(parseAuditRoute(auditRouteQuery(original))).toEqual(original)
  })
})

describe('auditApiQuery', () => {
  // AC-6
  test('emits the filter fields plus the API paging names', () => {
    expect(auditApiQuery(filters({ actorType: 'AGENT', actorId: 'a1', from: '2026-10-01', page: 2 })))
      .toEqual({ actorType: 'AGENT', actorId: 'a1', from: '2026-10-01', current: '2', size: '50' })
  })

  test('an empty filter set still asks for page 1 at the page size', () => {
    expect(auditApiQuery(EMPTY_AUDIT_FILTERS)).toEqual({ current: '1', size: '50' })
  })

  test('carries the correlation filter the related-request view needs', () => {
    expect(auditApiQuery(relatedFilters('c-1'))).toEqual({ correlationId: 'c-1', current: '1', size: '50' })
  })

  test('a page below 1 asks for the first page, which the API accepts', () => {
    expect(auditApiQuery(filters({ page: 0 })).current).toBe('1')
  })
})

describe('withFilter', () => {
  // AC-7
  test('applies the patch, resets the page and keeps the other filters', () => {
    const before = filters({ key: 'ticket.create', page: 3 })
    const after = withFilter(before, { projectId: 'p1' })
    expect(after).toEqual(filters({ key: 'ticket.create', projectId: 'p1' }))
    expect(after.page).toBe(1)
  })

  test('never mutates its input', () => {
    const before = filters({ key: 'ticket.create', page: 3 })
    const snapshot = { ...before }
    withFilter(before, { projectId: 'p1', actorType: 'AGENT' })
    expect(before).toEqual(snapshot)
  })
})

describe('relatedFilters', () => {
  // AC-8
  test('is the empty filter set with only the correlation id set', () => {
    expect(relatedFilters('c-1')).toEqual(filters({ correlationId: 'c-1' }))
    expect(relatedFilters('c-1').key).toBe('')
    expect(relatedFilters('c-1').page).toBe(1)
  })
})

describe('principalLabel', () => {
  // AC-9
  test('prefers the resolved display name', () => {
    expect(principalLabel({ type: 'USER', id: 'u1' }, 'Ada')).toBe('Ada')
  })

  // AC-10
  test('falls back to the id when nothing resolved', () => {
    expect(principalLabel({ type: 'SYSTEM', id: 'scheduler' }, null)).toBe('scheduler')
    expect(principalLabel({ type: 'USER', id: 'u1' }, '')).toBe('u1')
    expect(principalLabel({ type: 'USER', id: 'u1' }, '   ')).toBe('u1')
  })
})
