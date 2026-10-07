import { describe, expect, test } from '@jest/globals'
import {
  addTicketRef, affectsRuns, isLinkableTicket, matchTicketOptions, MAX_DISPATCH_TICKETS, normalizeTicketRef, runPrState,
  runReason, shortSha, ticketDispatchQuery, ticketFeatureSlug, ticketRefsFromQuery, ticketsQueryValue,
} from '~/lib/fleet-ticket-links'
import { FEATURE_RE } from '~/lib/fleet-dispatch'

describe('ticketFeatureSlug (D461)', () => {
  test('lower-cases ref and title and joins words with one dash', () => {
    expect(ticketFeatureSlug('WEB-12', 'Fix login: 500 on  SSO!')).toBe('web-12-fix-login-500-on-sso')
  })

  test('a title with no ASCII letters or digits leaves the ref alone (Review Focus 2)', () => {
    expect(ticketFeatureSlug('WEB-12', '修复登录')).toBe('web-12')
    expect(ticketFeatureSlug('WEB-12', '!!! ...')).toBe('web-12')
  })

  test('at most 48 chars, never ending with a dash, always a valid nax feature name', () => {
    const slug = ticketFeatureSlug('WEB-12', `${'a'.repeat(39)} tail`)
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
    for (const title of ['x'.repeat(200), 'a b c d e f g h i j k l m n o p q r s t u v w x y z', '--', '..']) {
      const s = ticketFeatureSlug('ABCDEF-123456789', title)
      expect(s.length).toBeLessThanOrEqual(48)
      expect(FEATURE_RE.test(s) && !s.includes('..') && !s.endsWith('-')).toBe(true)
    }
  })
})

describe('ticket refs', () => {
  test('normalizeTicketRef upper-cases and trims; rejects other shapes', () => {
    expect(normalizeTicketRef(' web-7 ')).toBe('WEB-7')
    for (const bad of ['', 'W-1', 'TOOLONGK-1', 'WEB-0', 'WEB-01', 'WEB-', 'WEB 1', 'WEB-1a', 'cuid123']) {
      expect(normalizeTicketRef(bad)).toBeNull()
    }
  })

  test('ticketRefsFromQuery: valid refs only, upper-cased, deduplicated, at most 20 (Review Focus 3)', () => {
    expect(ticketRefsFromQuery('web-1, WEB-2,,junk,web-1')).toEqual(['WEB-1', 'WEB-2'])
    expect(ticketRefsFromQuery(['WEB-3', 'web-4,WEB-3'])).toEqual(['WEB-3', 'WEB-4'])
    expect(ticketRefsFromQuery(undefined)).toEqual([])
    expect(ticketRefsFromQuery(42)).toEqual([])
    const many = Array.from({ length: 25 }, (_, i) => `WEB-${i + 1}`).join(',')
    expect(ticketRefsFromQuery(many)).toHaveLength(MAX_DISPATCH_TICKETS)
  })

  test('addTicketRef adds a normalized ref once, refuses junk and a full list, never mutates', () => {
    const list = ['WEB-1']
    expect(addTicketRef(list, 'web-2')).toEqual(['WEB-1', 'WEB-2'])
    expect(addTicketRef(list, 'WEB-1')).toEqual(['WEB-1'])
    expect(addTicketRef(list, 'nope')).toEqual(['WEB-1'])
    expect(list).toEqual(['WEB-1'])
    const full = Array.from({ length: MAX_DISPATCH_TICKETS }, (_, i) => `WEB-${i + 1}`)
    expect(addTicketRef(full, 'WEB-99')).toHaveLength(MAX_DISPATCH_TICKETS)
  })
})

describe('picker matching (P1)', () => {
  const options = [
    { ref: 'WEB-12', title: 'Login fails', status: 'CREATED' },
    { ref: 'WEB-11', title: 'Old', status: 'CLOSED' },
    { ref: 'WEB-1', title: 'Export is slow', status: 'IN_PROGRESS' },
  ]

  test('open, unchosen tickets whose ref or title contains the query', () => {
    expect(matchTicketOptions(options, [], 'login').map(o => o.ref)).toEqual(['WEB-12'])
    expect(matchTicketOptions(options, [], 'web-1').map(o => o.ref)).toEqual(['WEB-12', 'WEB-1'])
    expect(matchTicketOptions(options, ['WEB-12'], '').map(o => o.ref)).toEqual(['WEB-1'])
    expect(matchTicketOptions(options, [], '', 1)).toHaveLength(1)
  })

  test('CLOSED and REJECTED are not linkable (D450)', () => {
    expect(isLinkableTicket('CLOSED')).toBe(false)
    expect(isLinkableTicket('REJECTED')).toBe(false)
    expect(isLinkableTicket('VERIFY_FIX')).toBe(true)
  })
})

describe('links between pages', () => {
  test('ticketDispatchQuery proposes a PLAN with this ticket and its slug', () => {
    expect(ticketDispatchQuery({ ref: 'WEB-3', title: 'Add CSV export' }))
      .toEqual({ command: 'PLAN', tickets: 'WEB-3', feature: 'web-3-add-csv-export' })
  })

  test('ticketsQueryValue joins the refs; empty for none', () => {
    expect(ticketsQueryValue([{ ref: 'WEB-1', title: 'a', status: 'CREATED' }, { ref: 'WEB-2', title: 'b', status: 'CREATED' }])).toBe('WEB-1,WEB-2')
    expect(ticketsQueryValue(null)).toBe('')
    expect(ticketsQueryValue(undefined)).toBe('')
  })
})

describe('Fleet runs rows', () => {
  const base = { stateReason: null as string | null, escalationReason: null as string | null }

  test('runReason picks the failure comment reason (failure-comment.ts)', () => {
    expect(runReason({ ...base, state: 'FAILED', stateReason: ' acceptance failed ' })).toBe('acceptance failed')
    expect(runReason({ ...base, state: 'CRASHED', stateReason: 'runner silent' })).toBe('runner silent')
    expect(runReason({ state: 'ESCALATED', stateReason: 'state', escalationReason: 'needs a human' })).toBe('needs a human')
    expect(runReason({ state: 'ESCALATED', stateReason: 'state', escalationReason: '  ' })).toBe('state')
    expect(runReason({ ...base, state: 'FAILED' })).toBeNull()
    expect(runReason({ ...base, state: 'COMPLETED', stateReason: 'ignored' })).toBeNull()
    expect(runReason({ ...base, state: 'CANCELLED', stateReason: 'ignored' })).toBeNull()
  })

  test('runPrState reads the matching ticket link; null without a PR or a link', () => {
    const links = [{ url: 'https://github.com/a/b/pull/7', linkType: 'pr', prState: 'merged' }]
    expect(runPrState({ resultPrUrl: 'https://github.com/a/b/pull/7' }, links)).toBe('merged')
    expect(runPrState({ resultPrUrl: 'https://github.com/a/b/pull/8' }, links)).toBeNull()
    expect(runPrState({ resultPrUrl: null }, links)).toBeNull()
  })

  test('affectsRuns: a listed job, or any newly queued job (P3)', () => {
    expect(affectsRuns({ jobId: 'j1', state: 'RUNNING' }, ['j1'])).toBe(true)
    expect(affectsRuns({ jobId: 'j9', state: 'RUNNING' }, ['j1'])).toBe(false)
    expect(affectsRuns({ jobId: 'j9', state: 'QUEUED' }, ['j1'])).toBe(true)
  })

  test('shortSha', () => {
    expect(shortSha('abcdef1234567')).toBe('abcdef1')
    expect(shortSha(null)).toBeNull()
  })
})
