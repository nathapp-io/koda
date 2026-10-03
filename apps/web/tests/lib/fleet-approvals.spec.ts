import { describe, test, expect } from '@jest/globals'
import {
  approvalSummary, badgeTarget, badgeText, budgetPayload, buildApprovalQuery, buildRaiseSchema, canDecide,
  commentTooLong, inboxPath, pendingByPolicy, raiseAmountError, requeueFailure, requeueResults, resumedAmount,
  sortPending, toKeepPausedBody, toRaiseBody,
} from '../../lib/fleet-approvals'
import type { FleetApprovalDto } from '../../lib/fleet-types'
import { enI18n } from '../helpers/fleet-harness'

const budget = { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' }

const approval = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1',
  payload: { ...budget }, outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

describe('buildApprovalQuery', () => {
  test('pending asks for one page of 100 pending rows', () => {
    expect(buildApprovalQuery({ tab: 'pending' })).toEqual({ status: 'pending', size: '100' })
  })
  test('all pages by 20 and sends current only past page 1', () => {
    expect(buildApprovalQuery({ tab: 'all', page: 1 })).toEqual({ size: '20' })
    expect(buildApprovalQuery({ tab: 'all', page: 3, type: 'nax_bash_escalate' })).toEqual({ size: '20', current: '3', type: 'nax_bash_escalate' })
  })
  test('pending ignores the page', () => {
    expect(buildApprovalQuery({ tab: 'pending', page: 4 })).toEqual({ status: 'pending', size: '100' })
  })
})

describe('sortPending', () => {
  test('soonest expiry first, then rows without one in their given order', () => {
    const rows = [
      approval('b1'), approval('x2', { expiresAt: '2026-10-03T10:09:00.000Z' }),
      approval('b2'), approval('x1', { expiresAt: '2026-10-03T10:05:00.000Z' }),
    ]
    expect(sortPending(rows).map((r) => r.id)).toEqual(['x1', 'x2', 'b1', 'b2'])
    expect(rows.map((r) => r.id)).toEqual(['b1', 'x2', 'b2', 'x1'])
  })
})

describe('budgetPayload', () => {
  test('reads a budget payload', () => {
    expect(budgetPayload(approval('a'))).toEqual(budget)
  })
  test('null for a bash approval and for a malformed budget payload (Review Focus 5)', () => {
    expect(budgetPayload(approval('a', { type: 'nax_bash_escalate', payload: { command: 'ls' } }))).toBeNull()
    expect(budgetPayload(approval('a', { payload: { ...budget, spentUsd: 0.6 } }))).toBeNull()
    expect(budgetPayload(approval('a', { payload: { ...budget, scopeType: 'galaxy' } }))).toBeNull()
  })
  test('a missing scopeId reads as null', () => {
    const withoutScopeId = { scopeType: 'global', windowKind: budget.windowKind, windowStart: budget.windowStart, spentUsd: budget.spentUsd, amountUsd: budget.amountUsd }
    expect(budgetPayload(approval('a', { payload: withoutScopeId }))?.scopeId).toBeNull()
  })
})

describe('canDecide (D244, Review Focus 5)', () => {
  const admin = { kind: 'admin' } as const
  const manager = { kind: 'project', canManage: true } as const
  const member = { kind: 'project', canManage: false } as const
  test('a pending budget override: admin inbox or project ADMIN', () => {
    expect(canDecide(approval('a'), admin)).toBe(true)
    expect(canDecide(approval('a'), manager)).toBe(true)
    expect(canDecide(approval('a'), member)).toBe(false)
  })
  test('never once decided, never a bash ask in 1b', () => {
    expect(canDecide(approval('a', { status: 'approved' }), admin)).toBe(false)
    expect(canDecide(approval('a', { type: 'nax_bash_escalate' }), admin)).toBe(false)
  })
})

describe('raise form', () => {
  test('the amount must parse and be above the spend', () => {
    expect(raiseAmountError('', '0.6000')).toBe('amountInvalid')
    expect(raiseAmountError('1.23456', '0.6000')).toBe('amountInvalid')
    expect(raiseAmountError('0.6', '0.6000')).toBe('notAbove')
    expect(raiseAmountError(' 2 ', '0.6000')).toBeNull()
  })
  test('raise always sends the selected ids, even none (D243)', () => {
    expect(toRaiseBody({ amount: '2', selected: [], comment: '  ' })).toEqual({ decision: 'raise_budget_and_resume', amountUsd: 2, requeueJobIds: [] })
    expect(toRaiseBody({ amount: '2.5', selected: ['j1'], comment: ' ok ' }))
      .toEqual({ decision: 'raise_budget_and_resume', amountUsd: 2.5, requeueJobIds: ['j1'], comment: 'ok' })
  })
  test('raise refuses an amount that was not validated', () => {
    expect(() => toRaiseBody({ amount: 'x', selected: [], comment: '' })).toThrow('not validated')
  })
  test('keep paused carries only the decision and a non-blank comment', () => {
    expect(toKeepPausedBody('')).toEqual({ decision: 'keep_paused' })
    expect(toKeepPausedBody(' wait ')).toEqual({ decision: 'keep_paused', comment: 'wait' })
  })
  test('a comment over 1000 characters is too long', () => {
    expect(commentTooLong('a'.repeat(1000))).toBe(false)
    expect(commentTooLong(` ${'a'.repeat(1001)} `)).toBe(true)
  })
})

describe('re-queue results (D245, Review Focus 4)', () => {
  const err = (code: string, args: Record<string, unknown> = {}) => JSON.stringify({ code, args })
  test('maps stored error codes to reasons', () => {
    expect(requeueFailure(err('fleet.jobs'))).toBe('gone')
    expect(requeueFailure(err('fleet.jobs', { activeJobId: 'j9' }))).toBe('activeJob')
    expect(requeueFailure(err('fleet.jobState', { state: 'QUEUED' }))).toBe('notCancelled')
    expect(requeueFailure(err('fleet.budgetPaused'))).toBe('paused')
    expect(requeueFailure(err('fleet.other'))).toBe('unknown')
    expect(requeueFailure('unexpected error')).toBe('unknown')
    expect(requeueFailure(undefined)).toBe('unknown')
    expect(requeueFailure('null')).toBe('unknown')
  })
  test('a user raise lists its results, skipping malformed entries', () => {
    const a = approval('a', {
      status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user',
      outcome: { resumedAmountUsd: '2.0000', requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: err('fleet.jobState') }, { ok: true }, 'junk'] },
    })
    expect(requeueResults(a)).toEqual([{ jobId: 'j1', ok: true, reason: null }, { jobId: 'j2', ok: false, reason: 'notCancelled' }])
    expect(resumedAmount(a)).toBe('2.0000')
  })
  test('a manual resume has no re-queue record to show', () => {
    const a = approval('a', { status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'manual_resume', outcome: { resumedAmountUsd: '3.0000', requeueResults: [] } })
    expect(requeueResults(a)).toBeNull()
    expect(resumedAmount(a)).toBe('3.0000')
  })
  test('keep paused and missing outcomes have none', () => {
    expect(requeueResults(approval('a', { status: 'rejected', decision: 'keep_paused', resolvedBy: 'user' }))).toBeNull()
    expect(requeueResults(approval('a', { decision: 'raise_budget_and_resume', resolvedBy: 'user', outcome: null }))).toBeNull()
    expect(resumedAmount(approval('a'))).toBeNull()
  })
  test('a numeric resumed amount is shown as a string', () => {
    expect(resumedAmount(approval('a', { outcome: { resumedAmountUsd: 2 } }))).toBe('2')
  })
})

describe('pendingByPolicy (D248)', () => {
  test('maps policy id to the pending budget approval', () => {
    const rows = [approval('a1'), approval('a2', { policyId: 'pol2', status: 'approved' }), approval('a3', { policyId: null }), approval('a4', { type: 'nax_bash_escalate', policyId: 'pol3' })]
    expect([...pendingByPolicy(rows)]).toEqual([['pol1', 'a1']])
  })
})

describe('paths and badge (D241, D247)', () => {
  test('inbox paths', () => {
    expect(inboxPath({ kind: 'project', slug: 'koda' })).toBe('/koda/fleet/approvals')
    expect(inboxPath({ kind: 'project', slug: 'koda' }, 'a b')).toBe('/koda/fleet/approvals?id=a%20b')
    expect(inboxPath({ kind: 'admin' }, 'x')).toBe('/admin/fleet/approvals?id=x')
  })
  const counts = { total: 3, unscoped: 1, projects: [{ projectId: 'p2', slug: 'beta', pending: 2 }] }
  test('in a project the badge goes to that inbox', () => {
    expect(badgeTarget(counts, { slug: 'koda', globalAdmin: true })).toBe('/koda/fleet/approvals')
  })
  test('outside a project: admin inbox for a global admin, else the first project with pending', () => {
    expect(badgeTarget(counts, { slug: null, globalAdmin: true })).toBe('/admin/fleet/approvals')
    expect(badgeTarget(counts, { slug: null, globalAdmin: false })).toBe('/beta/fleet/approvals')
    expect(badgeTarget({ total: 0, unscoped: 0, projects: [] }, { slug: null, globalAdmin: false })).toBeNull()
  })
  test('the count caps at 99+', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})

describe('approvalSummary', () => {
  const { t } = enI18n()
  test('a budget override names the scope and the stop', () => {
    expect(approvalSummary(t, approval('a'), () => 'koda')).toBe('Budget for project koda stopped at $0.60 of $0.50')
  })
  test('a bash ask and a malformed budget fall back to fixed text', () => {
    expect(approvalSummary(t, approval('a', { type: 'nax_bash_escalate', payload: {} }), () => null)).toBe('A job asks to run a shell command')
    expect(approvalSummary(t, approval('a', { payload: {} }), () => null)).toBe('Budget override')
  })
})

describe('buildRaiseSchema (D243)', () => {
  const { t } = enI18n()
  const schema = buildRaiseSchema(t, '0.6000')
  const errors = (amount: string, comment = '') => {
    const result = schema.safeParse({ amount, comment })
    return result.success ? {} : result.error.flatten().fieldErrors
  }
  test('a valid amount above the spend and a short comment pass', () => {
    expect(errors('2', 'ok')).toEqual({})
  })
  test('each field reports its own translated message', () => {
    expect(errors('abc').amount).toEqual(['Enter an amount above 0 with at most 4 decimals.'])
    expect(errors('0.6').amount).toEqual(['The new limit must be above $0.60.'])
    expect(errors('2', 'x'.repeat(1001)).comment).toEqual(['Keep the comment to 1000 characters.'])
  })
})
