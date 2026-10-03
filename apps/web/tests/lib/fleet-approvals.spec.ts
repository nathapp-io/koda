import { describe, test, expect } from '@jest/globals'
import {
  approvalSummary, badgeTarget, badgeText, bashChoices, bashPayload, budgetPayload, buildApprovalQuery,
  buildRaiseSchema, canDecide, commandPreview, commentTooLong, countdownText, deliveryView, firstPending,
  inboxPath, pendingByPolicy, raiseAmountError, requeueFailure, requeueResults, resumedAmount, secondsLeft,
  sortPending, toBashBody, toKeepPausedBody, toRaiseBody,
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
  const manager = { kind: 'project', canManage: true, canWork: true } as const
  const member = { kind: 'project', canManage: false, canWork: false } as const
  const developer = { kind: 'project', canManage: false, canWork: true } as const
  test('a pending budget override: admin inbox or project ADMIN', () => {
    expect(canDecide(approval('a'), admin)).toBe(true)
    expect(canDecide(approval('a'), manager)).toBe(true)
    expect(canDecide(approval('a'), member)).toBe(false)
  })
  test('never once decided; a pending bash ask is decided by DEVELOPER+ (D290)', () => {
    expect(canDecide(approval('a', { status: 'approved' }), admin)).toBe(false)
    // D290: bash asks are decided by DEVELOPER+, budget overrides still by ADMIN only.
    const bash = approval('a', { type: 'nax_bash_escalate', policyId: null })
    expect(canDecide(bash, admin)).toBe(true)
    expect(canDecide(bash, developer)).toBe(true)
    expect(canDecide(bash, member)).toBe(false)
    expect(canDecide(approval('a'), developer)).toBe(false)
    expect(canDecide({ ...bash, status: 'expired' }, admin)).toBe(false)
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
  test('a bash ask names its command and stage; malformed payloads fall back to fixed text (D296)', () => {
    expect(approvalSummary(t, approval('a', { type: 'nax_bash_escalate', payload: bashFields() }), () => null))
      .toBe('Run git push --force origin HEAD (execution)')
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

const bashFields = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'git push --force origin HEAD', commandTruncated: false, maskedCount: 1, root: '/work/app', stage: 'execution',
  storyId: 'US-001', featureName: 'login', reason: 'not covered by the stage grants', options: ['allow', 'allow-remember', 'deny'],
  ...over,
})
const bashRow = (over: Partial<FleetApprovalDto> = {}, payload: Record<string, unknown> = {}): FleetApprovalDto =>
  approval('b1', { type: 'nax_bash_escalate', policyId: null, jobId: 'j1', payload: bashFields(payload), expiresAt: '2026-10-03T10:10:00.000Z', ...over })

describe('bashPayload (D289, Review Focus 1)', () => {
  test('a well-formed ask is read in full; rawDetail is null when absent', () => {
    expect(bashPayload(bashRow())).toEqual({ ...bashFields(), rawDetail: null })
  })
  test('an unparsed ask carries its raw text', () => {
    expect(bashPayload(bashRow({}, { command: '', rawDetail: 'request: rm -rf build' }))?.rawDetail).toBe('request: rm -rf build')
  })
  test.each([
    ['a missing command', { command: undefined }],
    ['an empty command without raw text', { command: '' }],
    ['a non-boolean truncation flag', { commandTruncated: 'no' }],
    ['a negative masked count', { maskedCount: -1 }],
    ['a fractional masked count', { maskedCount: 1.5 }],
    ['an unknown option', { options: ['allow', 'yolo'] }],
    ['options that are not a list', { options: 'allow' }],
    ['a numeric story id', { storyId: 7 }],
    ['a numeric raw detail', { rawDetail: 3 }],
    ['an empty command with empty raw text', { command: '', rawDetail: '' }],
  ])('%s is malformed', (_name, over) => {
    expect(bashPayload(bashRow({}, over))).toBeNull()
  })
  test('a budget approval is not a bash ask', () => {
    expect(bashPayload(approval('a'))).toBeNull()
  })
})

describe('bashChoices (D291, Review Focus 1)', () => {
  const p = (over: Record<string, unknown> = {}) => bashPayload(bashRow({}, over))
  test('every offered choice, in order', () => {
    expect(bashChoices(p())).toEqual(['allow', 'allow_for_job', 'deny'])
  })
  test('allow-remember not offered: no "for this job"', () => {
    expect(bashChoices(p({ options: ['allow', 'deny'] }))).toEqual(['allow', 'deny'])
  })
  test('a cut command can only be denied', () => {
    expect(bashChoices(p({ commandTruncated: true }))).toEqual(['deny'])
  })
  test('an unreadable payload can only be denied', () => {
    expect(bashChoices(null)).toEqual(['deny'])
  })
  test('an unparsed, uncut ask is decided like any other', () => {
    expect(bashChoices(p({ command: '', rawDetail: 'x' }))).toEqual(['allow', 'allow_for_job', 'deny'])
  })
})

describe('toBashBody (D293)', () => {
  test('decision and trimmed comment only, never budget fields', () => {
    expect(toBashBody('allow', '  ok  ')).toEqual({ decision: 'allow', comment: 'ok' })
    expect(toBashBody('deny', '   ')).toEqual({ decision: 'deny' })
  })
})

describe('countdown (D292)', () => {
  const now = new Date('2026-10-03T10:00:00.000Z')
  test('whole seconds left, rounded up, floored at 0', () => {
    expect(secondsLeft('2026-10-03T10:00:00.500Z', now)).toBe(1)
    expect(secondsLeft('2026-10-03T10:10:00.000Z', now)).toBe(600)
    expect(secondsLeft('2026-10-03T09:59:00.000Z', now)).toBe(0)
  })
  test('no expiry, or an unreadable one, has no countdown', () => {
    expect(secondsLeft(null, now)).toBeNull()
    expect(secondsLeft('soon', now)).toBeNull()
  })
  test('m:ss under an hour, h:mm:ss from an hour', () => {
    expect(countdownText(0)).toBe('0:00')
    expect(countdownText(65)).toBe('1:05')
    expect(countdownText(600)).toBe('10:00')
    expect(countdownText(3725)).toBe('1:02:05')
  })
})

describe('deliveryView (D294, Review Focus 3)', () => {
  const decided = (outcome: Record<string, unknown> | null, resolvedBy: FleetApprovalDto['resolvedBy'] = 'user') =>
    bashRow({ status: 'approved', decision: 'allow', resolvedBy, outcome })
  test('no ack yet reads as waiting', () => {
    expect(deliveryView(decided(null))).toEqual({ state: 'waiting' })
    expect(deliveryView(decided({}))).toEqual({ state: 'waiting' })
  })
  test('ok and rejected acks', () => {
    expect(deliveryView(decided({ delivery: { result: 'ok', detail: null, at: 'x' } }))).toEqual({ state: 'delivered' })
    expect(deliveryView(decided({ delivery: { result: 'rejected', detail: 'callback_failed:429', at: 'x' } })))
      .toEqual({ state: 'failed', detail: 'callback_failed:429' })
  })
  test('an unknown stored shape never claims delivery', () => {
    expect(deliveryView(decided({ delivery: { result: 'maybe' } }))).toEqual({ state: 'failed', detail: null })
    expect(deliveryView(decided({ delivery: 'ok' }))).toEqual({ state: 'failed', detail: null })
  })
  test('a timeout, a job end or a budget approval has no delivery line', () => {
    expect(deliveryView(decided(null, 'timeout'))).toBeNull()
    expect(deliveryView(approval('a', { status: 'approved', resolvedBy: 'user' }))).toBeNull()
  })
})

describe('commandPreview (D296)', () => {
  const p = (over: Record<string, unknown>) => {
    const parsed = bashPayload(bashRow({}, over))
    if (parsed === null) throw new Error('commandPreview: the payload should have parsed')
    return parsed
  }
  test('the first line, cut at 80 characters', () => {
    expect(commandPreview(p({}))).toBe('git push --force origin HEAD')
    expect(commandPreview(p({ command: 'x'.repeat(81) }))).toBe(`${'x'.repeat(80)}...`)
    expect(commandPreview(p({ command: 'echo a\necho b' }))).toBe('echo a...')
  })
  test('an unparsed ask previews its raw text', () => {
    expect(commandPreview(p({ command: '', rawDetail: 'request: ls\nruns in: /w' }))).toBe('request: ls...')
  })
})

describe('firstPending (D297)', () => {
  test('the pending ask that expires first', () => {
    const rows = [
      bashRow({ id: 'late', expiresAt: '2026-10-03T10:20:00.000Z' }),
      bashRow({ id: 'done', status: 'approved', expiresAt: '2026-10-03T10:01:00.000Z' }),
      bashRow({ id: 'soon', expiresAt: '2026-10-03T10:05:00.000Z' }),
    ]
    expect(firstPending(rows)?.id).toBe('soon')
    expect(firstPending([])).toBeNull()
  })
})
