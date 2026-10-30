import { describe, test, expect } from '@jest/globals'
import {
  badgeText, bashChoices, bashPayload, budgetPayload, commandPreview, countdownText, deliveryView,
  raiseAmountError, requeueFailure, secondsLeft,
} from '../../lib/fleet-approvals'
import type { FleetApprovalDto } from '../../lib/fleet-types'

/**
 * The fleet approval helpers the fleet surfaces still read: the job page, the header badge, the notification
 * bell, the thread action card and the engine's fleet panels. US-010 deleted the fleet inbox and the helpers only
 * it used (query building, sorting, the viewer keys, the raise/keep-paused/bash/action bodies, thread paths, keyboard
 * decisions, summary lines, the raise schema and its comment limit); the cases for those went with them.
 */

const budget = { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '0.6000', amountUsd: '0.5000' }

const approval = (id: string, over: Partial<FleetApprovalDto> = {}): FleetApprovalDto => ({
  id, type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol1',
  payload: { ...budget }, outcome: null, requestedAt: '2026-10-03T10:00:00.000Z', expiresAt: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
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

describe('raiseAmountError (D243)', () => {
  test('the amount must parse and be above the spend', () => {
    expect(raiseAmountError('', '0.6000')).toBe('amountInvalid')
    expect(raiseAmountError('1.23456', '0.6000')).toBe('amountInvalid')
    expect(raiseAmountError('0.6', '0.6000')).toBe('notAbove')
    expect(raiseAmountError(' 2 ', '0.6000')).toBeNull()
  })
})

describe('requeueFailure (D245, Review Focus 4)', () => {
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
})

describe('badgeText (D247)', () => {
  test('the count caps at 99+', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
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
    ['options without deny', { options: ['allow', 'allow-remember'] }],
    ['options that are empty', { options: [] }],
    ['options with a duplicate', { options: ['allow', 'allow', 'deny'] }],
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
