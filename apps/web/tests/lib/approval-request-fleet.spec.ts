import { describe, expect, test } from '@jest/globals'
import {
  bashAskOf, bashRequestBody, budgetAskOf, budgetKeepBody, budgetRaiseBody, buildBudgetRaiseSchema,
  requestDelivery, requestPanelKind, requestRequeueResults, requestResolvedBy, requeueCandidatesOf,
} from '../../lib/approval-request-fleet'
import { enI18n } from '../helpers/fleet-harness'
import type { ApprovalRequestDetail } from '../../lib/approval-requests'

const T = enI18n()

const BASH_PAYLOAD = {
  command: 'rm -rf build', commandTruncated: false, maskedCount: 1, root: '/repo', stage: 'run',
  storyId: 's1', featureName: 'fleet-ui', reason: 'destructive command', options: ['allow', 'allow-remember', 'deny'],
  rawDetail: null,
}

const BUDGET_INPUT = {
  policyId: 'pol1', scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc',
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '10.0000', amountUsd: '20.0000',
  requestedAt: '2026-10-03T10:00:00.000Z',
}

const detail = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => ({
  id: 'r1', permissionKey: 'label.create', projectId: 'p1', actorType: 'AGENT', actorId: 'agent-1',
  onBehalfOfType: null, onBehalfOfId: null, origin: 'fleet', redeem: false, requiredMode: 'human', status: 'pending',
  satisfiedBy: null, approverType: null, approverId: null, expiresAt: '2026-11-01T00:10:00.000Z', decidedAt: null,
  settledAt: null, createdAt: '2026-10-31T23:59:00.000Z', input: null, result: null, details: null, decisions: [],
  ...over,
})

const bashRequest = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => detail({
  permissionKey: 'fleet.job.shell.escalate',
  input: { jobId: 'j1', leaseEpoch: 3, naxAskId: 'ask-1', payload: BASH_PAYLOAD },
  details: { kind: 'bash', jobId: 'j1', resolvedBy: null, outcome: null },
  ...over,
})

const budgetRequest = (over: Partial<ApprovalRequestDetail> = {}): ApprovalRequestDetail => detail({
  permissionKey: 'fleet.budget.override',
  input: BUDGET_INPUT,
  details: {
    kind: 'budget', policyId: 'pol1', resolvedBy: null, outcome: null,
    requeueCandidates: [
      { jobId: 'j1', projectId: 'p1', feature: 'feat-a', queuedAt: '2026-10-03T09:00:00.000Z' },
      { jobId: 'j2', projectId: 'p1', feature: 'feat-b', queuedAt: '2026-10-03T09:01:00.000Z' },
    ],
    requeueCandidatesTruncated: false,
  },
  ...over,
})

describe('requestPanelKind', () => {
  test('picks the fleet panel by the request key, generic otherwise', () => {
    expect(requestPanelKind(bashRequest())).toBe('bash')
    expect(requestPanelKind(budgetRequest())).toBe('budget')
    expect(requestPanelKind(detail({ permissionKey: 'label.create' }))).toBe('generic')
  })
})

describe('bashAskOf', () => {
  test('parses the frozen payload through bashPayload', () => {
    const ask = bashAskOf(bashRequest())
    expect(ask?.jobId).toBe('j1')
    expect(ask?.naxAskId).toBe('ask-1')
    expect(ask?.leaseEpoch).toBe(3)
    expect(ask?.payload?.command).toBe('rm -rf build')
    expect(ask?.payload?.options).toEqual(['allow', 'allow-remember', 'deny'])
  })

  test('a payload bashPayload refuses reads as an unreadable ask, not as no ask', () => {
    const ask = bashAskOf(bashRequest({ input: { jobId: 'j1', leaseEpoch: 3, naxAskId: 'ask-1', payload: { command: 1 } } }))
    expect(ask).not.toBeNull()
    expect(ask?.payload).toBeNull()
  })

  test('falls back to the input job id when details are missing, and answers null for another key', () => {
    expect(bashAskOf(bashRequest({ details: null }))?.jobId).toBe('j1')
    expect(bashAskOf(budgetRequest({ input: BASH_PAYLOAD }))).toBeNull()
  })
})

describe('budgetAskOf', () => {
  test('parses the frozen input, with the policy id from the details', () => {
    const ask = budgetAskOf(budgetRequest())
    expect(ask).toEqual({
      policyId: 'pol1', scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc',
      windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '10.0000', amountUsd: '20.0000',
      requestedAt: '2026-10-03T10:00:00.000Z',
    })
  })

  test('an input budgetPayload refuses answers null', () => {
    expect(budgetAskOf(budgetRequest({ input: { ...BUDGET_INPUT, windowKind: 'nonsense' } }))).toBeNull()
    expect(budgetAskOf(bashRequest())).toBeNull()
  })
})

describe('requeueCandidatesOf', () => {
  test('reads the offered candidates and the truncation flag', () => {
    const offer = requeueCandidatesOf(budgetRequest())
    expect(offer.candidates.map((c) => c.jobId)).toEqual(['j1', 'j2'])
    expect(offer.truncated).toBe(false)
    expect(requeueCandidatesOf(budgetRequest({
      details: { kind: 'budget', policyId: 'pol1', requeueCandidatesTruncated: true },
    })).truncated).toBe(true)
  })

  test('a settled budget request offers nothing, and malformed rows are dropped', () => {
    const settled = budgetRequest({ status: 'executed', details: { kind: 'budget', policyId: 'pol1', outcome: {} } })
    expect(requeueCandidatesOf(settled)).toEqual({ candidates: [], truncated: false })
    const odd = budgetRequest({
      details: { kind: 'budget', requeueCandidates: [{ jobId: 'j1' }, 'nope', null] },
    })
    expect(requeueCandidatesOf(odd).candidates).toEqual([])
    expect(requeueCandidatesOf(bashRequest()).candidates).toEqual([])
  })
})

describe('bashRequestBody', () => {
  test('maps each choice onto the engine decision and params', () => {
    expect(bashRequestBody('allow', '')).toEqual({ decision: 'approve', params: { choice: 'allow' } })
    expect(bashRequestBody('allow_for_job', '')).toEqual({ decision: 'approve', params: { choice: 'allow_for_job' } })
    expect(bashRequestBody('deny', '')).toEqual({ decision: 'reject', params: { choice: 'deny' } })
  })

  test('carries a trimmed comment, and drops a blank one', () => {
    expect(bashRequestBody('allow', '  ok  ')).toEqual({ decision: 'approve', params: { choice: 'allow' }, comment: 'ok' })
    expect(bashRequestBody('deny', '   ')).toEqual({ decision: 'reject', params: { choice: 'deny' } })
  })
})

describe('budgetRaiseBody', () => {
  test('sends the parsed amount and every ticked id, in one params object', () => {
    expect(budgetRaiseBody({ amount: '50', requeueJobIds: ['j1'], comment: '' }))
      .toEqual({ decision: 'approve', params: { amountUsd: 50, requeueJobIds: ['j1'] } })
  })

  test('always sends requeueJobIds, and a trimmed comment when there is one', () => {
    expect(budgetRaiseBody({ amount: '50.5', requeueJobIds: [], comment: ' go ' }))
      .toEqual({ decision: 'approve', params: { amountUsd: 50.5, requeueJobIds: [] }, comment: 'go' })
  })

  test('an amount the schema never validated throws instead of posting NaN', () => {
    expect(() => budgetRaiseBody({ amount: 'abc', requeueJobIds: [], comment: '' })).toThrow()
  })
})

describe('budgetKeepBody', () => {
  test('a rejection carries no params', () => {
    expect(budgetKeepBody('')).toEqual({ decision: 'reject' })
    expect(budgetKeepBody(' later ')).toEqual({ decision: 'reject', comment: 'later' })
  })
})

describe('buildBudgetRaiseSchema', () => {
  test('accepts an amount above the frozen spend', () => {
    expect(buildBudgetRaiseSchema(T.t, '10.0000').safeParse({ amount: '50', comment: '' }).success).toBe(true)
  })

  test('refuses an amount that does not exceed the frozen spend, with the approvals.fleet message', () => {
    const result = buildBudgetRaiseSchema(T.t, '10.0000').safeParse({ amount: '10', comment: '' })
    expect(result.success).toBe(false)
    expect(result.success ? [] : result.error.issues.map((issue) => issue.message))
      .toEqual([T.t('approvals.fleet.budget.validation.notAbove', { spent: '$10.00' })])
  })

  test('refuses a malformed amount, and a comment past the engine 2000-character cap', () => {
    const schema = buildBudgetRaiseSchema(T.t, '10.0000')
    expect(schema.safeParse({ amount: '0', comment: '' }).success).toBe(false)
    expect(schema.safeParse({ amount: '50', comment: 'x'.repeat(2000) }).success).toBe(true)
    const tooLong = schema.safeParse({ amount: '50', comment: 'x'.repeat(2001) })
    expect(tooLong.success ? [] : tooLong.error.issues.map((issue) => issue.message))
      .toEqual([T.t('approvals.comment.tooLong')])
  })
})

describe('requestDelivery', () => {
  test('a user-decided bash ask adapts through deliveryView', () => {
    const delivered = bashRequest({
      status: 'approved',
      details: { kind: 'bash', jobId: 'j1', resolvedBy: 'user', outcome: { delivery: { result: 'ok' } } },
    })
    expect(requestDelivery(delivered)).toEqual({ state: 'delivered' })
    expect(requestDelivery(bashRequest({
      details: { kind: 'bash', resolvedBy: 'user', outcome: { delivery: { result: 'rejected', detail: 'runner gone' } } },
    }))).toEqual({ state: 'failed', detail: 'runner gone' })
    expect(requestDelivery(bashRequest({ details: { kind: 'bash', resolvedBy: 'user', outcome: {} } })))
      .toEqual({ state: 'waiting' })
  })

  test('a timeout, a budget ask and a detail-less request have no delivery to show', () => {
    expect(requestDelivery(bashRequest({ details: { kind: 'bash', resolvedBy: 'timeout', outcome: {} } }))).toBeNull()
    expect(requestDelivery(budgetRequest())).toBeNull()
    expect(requestDelivery(bashRequest({ details: null }))).toBeNull()
  })
})

describe('requestResolvedBy', () => {
  test('reads the resolved-by code, and ignores one the API does not define', () => {
    expect(requestResolvedBy(bashRequest({ details: { kind: 'bash', resolvedBy: 'timeout' } }))).toBe('timeout')
    expect(requestResolvedBy(bashRequest({ details: { kind: 'bash', resolvedBy: 'nonsense' } }))).toBeNull()
    expect(requestResolvedBy(bashRequest({ details: null }))).toBeNull()
  })
})

describe('requestRequeueResults', () => {
  const executed = (outcome: Record<string, unknown>): ApprovalRequestDetail => budgetRequest({
    status: 'executed', details: { kind: 'budget', policyId: 'pol1', resolvedBy: 'user', outcome },
  })

  test('explains a failed re-queue through requeueFailure', () => {
    expect(requestRequeueResults(executed({
      resumedAmountUsd: '50.0000',
      requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: '{"code":"fleet.jobState"}' }],
    }))).toEqual([
      { jobId: 'j1', ok: true, reason: null },
      { jobId: 'j2', ok: false, reason: 'notCancelled' },
    ])
  })

  test('no requeue result at all answers null, so nothing is claimed that was never offered', () => {
    expect(requestRequeueResults(executed({ resumedAmountUsd: '50.0000' }))).toBeNull()
    expect(requestRequeueResults(budgetRequest({ details: null }))).toBeNull()
    expect(requestRequeueResults(bashRequest())).toBeNull()
  })

  test('malformed entries are skipped, never rendered as a job', () => {
    expect(requestRequeueResults(executed({ requeueResults: [{ jobId: 'j1' }, null, 'nope'] }))).toEqual([])
  })
})
