import { describe, expect, test } from '@jest/globals'
import { buildDispatchSchema, DISPATCH_DEFAULTS, toDispatchBody, type DispatchFormValues } from '~/lib/fleet-dispatch'

const t = (key: string): string => key
const schema = buildDispatchSchema(t)
const valid = (over: Partial<DispatchFormValues> = {}): DispatchFormValues => ({
  ...DISPATCH_DEFAULTS,
  repoId: 'r1',
  feature: 'login-fix',
  ...over,
})
const messages = (values: unknown): string[] => {
  const result = schema.safeParse(values)
  return result.success ? [] : result.error.issues.map(issue => issue.message)
}

describe('PR dispatch schema', () => {
  test('accepts FIX with an empty hidden feature', () => {
    expect(messages(valid({ command: 'FIX', feature: '', prNumber: '23' }))).toEqual([])
  })

  test('trims a REVIEW pull request number for validation', () => {
    expect(messages(valid({ command: 'REVIEW', prNumber: ' 23 ' }))).toEqual([])
  })

  test.each(['', '0', '023', '1e3', '2147483648'])('rejects REVIEW pull request number %p', prNumber => {
    expect(messages(valid({ command: 'REVIEW', prNumber }))).toContain('fleet.dispatch.validation.prNumber')
  })

  test('ignores stale hidden RUN/PLAN values for FIX', () => {
    expect(messages(valid({
      command: 'FIX',
      prNumber: '23',
      feature: 'a/b',
      ref: 'x'.repeat(300),
      ticketRefs: ['bad'],
      bashMode: 'stale-invalid',
      approvalTimeoutMinutes: '',
    }))).toEqual([])
  })

  test('continues validating feature for RUN', () => {
    expect(messages(valid({ feature: '' }))).toContain('fleet.dispatch.validation.feature')
  })

  test('continues validating ref for RUN', () => {
    expect(messages(valid({ ref: 'x'.repeat(300) }))).toContain('fleet.dispatch.validation.ref')
  })
})

describe('PR dispatch body', () => {
  test('defaults prNumber to an empty string', () => {
    expect(DISPATCH_DEFAULTS.prNumber).toBe('')
  })

  test('sends only PR dispatch fields and placement options', () => {
    expect(toDispatchBody(valid({
      command: 'FIX',
      prNumber: ' 23 ',
      feature: 'login',
      ref: 'dev',
      ticketRefs: ['KD-1'],
      bashMode: 'escalate',
      profiles: ['fast'],
      maxCostUsd: 1,
    }))).toEqual({ repoId: 'r1', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['fast'] })
  })

  test('never includes acknowledgeOpenPr for REVIEW', () => {
    expect(toDispatchBody(valid({ command: 'REVIEW', prNumber: '23' }), { acknowledgeOpenPr: true }))
      .not.toHaveProperty('acknowledgeOpenPr')
  })
})
