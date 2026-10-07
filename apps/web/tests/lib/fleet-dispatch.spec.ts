import { describe, expect, test } from '@jest/globals'
import { addToken, buildDispatchSchema, DISPATCH_DEFAULTS, dispatchPrefillFromQuery, prefillNotice, removeToken, toDispatchBody, type DispatchFormValues } from '~/lib/fleet-dispatch'

const t = (key: string): string => key
const schema = buildDispatchSchema(t)
const valid = (over: Partial<DispatchFormValues> = {}): DispatchFormValues => ({ ...DISPATCH_DEFAULTS, repoId: 'r1', feature: 'login-fix', ...over })
const messages = (values: unknown): string[] => {
  const r = schema.safeParse(values)
  return r.success ? [] : r.error.issues.map(i => i.message)
}

describe('buildDispatchSchema', () => {
  test('accepts a minimal RUN', () => {
    expect(messages(valid())).toEqual([])
  })

  test('requires a repo', () => {
    expect(messages(valid({ repoId: '' }))).toContain('fleet.dispatch.validation.repoRequired')
  })

  test.each(['', '-x', 'a/b', 'a..b', 'x'.repeat(129)])('rejects feature %p', (feature) => {
    expect(messages(valid({ feature }))).toContain('fleet.dispatch.validation.feature')
  })

  test('PLAN needs planFrom; RUN does not', () => {
    expect(messages(valid({ command: 'PLAN', planFrom: '  ' }))).toContain('fleet.dispatch.validation.planFromRequired')
    expect(messages(valid({ command: 'PLAN', planFrom: 'docs/spec.md' }))).toEqual([])
  })

  test('profiles: names, reserved prefix, duplicates, max 8', () => {
    expect(messages(valid({ profiles: ['bad name'] }))).toContain('fleet.dispatch.validation.profileName')
    expect(messages(valid({ profiles: ['koda-job-1'] }))).toContain('fleet.dispatch.validation.profileName')
    expect(messages(valid({ profiles: ['a', 'a'] }))).toContain('fleet.dispatch.validation.profileDuplicate')
    expect(messages(valid({ profiles: Array.from({ length: 9 }, (_, i) => `p${i}`) }))).toContain('fleet.dispatch.validation.profilesMax')
  })

  test('max cost: > 0, <= 10000, at most 4 decimals, coerced from the input string', () => {
    expect(messages(valid({ maxCostUsd: 0 }))).toContain('fleet.dispatch.validation.maxCost')
    expect(messages(valid({ maxCostUsd: 10_001 }))).toContain('fleet.dispatch.validation.maxCost')
    expect(messages(valid({ maxCostUsd: 0.00001 }))).toContain('fleet.dispatch.validation.maxCost')
    expect(messages({ ...valid(), maxCostUsd: '2.5' })).toEqual([])
    expect(messages({ ...valid(), maxCostUsd: 'abc' })).toContain('fleet.dispatch.validation.maxCost')
  })

  test('labels: pattern and mutual exclusion with a pin', () => {
    expect(messages(valid({ selectorLabels: ['Linux'] }))).toContain('fleet.dispatch.validation.label')
    expect(messages(valid({ selectorLabels: ['linux'], pinnedRunnerId: 'run1' }))).toContain('fleet.dispatch.validation.labelsOrPin')
    expect(messages(valid({ selectorLabels: ['linux'] }))).toEqual([])
  })
})

describe('toDispatchBody', () => {
  test('a minimal RUN sends only the required fields', () => {
    expect(toDispatchBody(valid())).toEqual({ repoId: 'r1', command: 'RUN', feature: 'login-fix', maxCostUsd: 5 })
  })

  test('trims, keeps ref, profiles and labels', () => {
    expect(toDispatchBody(valid({ ref: ' dev ', feature: ' f1 ', profiles: ['fast', 'review'], selectorLabels: ['linux'] })))
      .toEqual({ repoId: 'r1', command: 'RUN', feature: 'f1', maxCostUsd: 5, ref: 'dev', profiles: ['fast', 'review'], selectorLabels: ['linux'] })
  })

  test('planFrom only for PLAN', () => {
    expect(toDispatchBody(valid({ planFrom: 'docs/x.md' }))).not.toHaveProperty('planFrom')
    expect(toDispatchBody(valid({ command: 'PLAN', planFrom: ' docs/x.md ' }))).toMatchObject({ planFrom: 'docs/x.md' })
  })

  test('a pin wins over labels and drops them', () => {
    const body = toDispatchBody(valid({ pinnedRunnerId: 'run1', selectorLabels: ['linux'] }))
    expect(body.pinnedRunnerId).toBe('run1')
    expect(body).not.toHaveProperty('selectorLabels')
  })

  test('does not share arrays with the form values', () => {
    const values = valid({ profiles: ['fast'] })
    const body = toDispatchBody(values)
    expect(body.profiles).toEqual(['fast'])
    expect(body.profiles).not.toBe(values.profiles)
  })

  test('#231: acknowledgeOpenPr only travels when the caller opted in', () => {
    expect(toDispatchBody(valid())).not.toHaveProperty('acknowledgeOpenPr')
    expect(toDispatchBody(valid(), { acknowledgeOpenPr: true })).toMatchObject({ acknowledgeOpenPr: true })
  })
})

describe('bash fields (D299)', () => {
  test('defaults: raw, 10 minutes', () => {
    expect(DISPATCH_DEFAULTS.bashMode).toBe('raw')
    expect(DISPATCH_DEFAULTS.approvalTimeoutMinutes).toBe('10')
  })

  test('a gated or escalate RUN needs a valid timeout; raw and PLAN do not', () => {
    expect(messages(valid({ bashMode: 'escalate', approvalTimeoutMinutes: '' }))).toEqual(['fleet.bash.validation.timeout'])
    expect(messages(valid({ bashMode: 'gated', approvalTimeoutMinutes: '61' }))).toEqual(['fleet.bash.validation.timeout'])
    expect(messages(valid({ bashMode: 'escalate', approvalTimeoutMinutes: '5' }))).toEqual([])
    expect(messages(valid({ bashMode: 'raw', approvalTimeoutMinutes: '' }))).toEqual([])
    expect(messages(valid({ command: 'PLAN', planFrom: 'docs/s.md', bashMode: 'escalate', approvalTimeoutMinutes: '' }))).toEqual([])
  })

  test('the timeout field may arrive undefined (unmounted under v-if) for a raw job', () => {
    expect(messages({ ...valid(), approvalTimeoutMinutes: undefined })).toEqual([])
  })

  test('body: raw sends no bash fields; an escalate RUN sends both; a PLAN never does', () => {
    expect(toDispatchBody(valid())).not.toHaveProperty('bashMode')
    expect(toDispatchBody(valid())).not.toHaveProperty('approvalTimeoutSec')
    expect(toDispatchBody(valid({ bashMode: 'escalate', approvalTimeoutMinutes: '2' }))).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120 }))
    const plan = toDispatchBody(valid({ command: 'PLAN', planFrom: 'docs/s.md', bashMode: 'escalate', approvalTimeoutMinutes: '2' }))
    expect(plan).not.toHaveProperty('bashMode')
    expect(plan).not.toHaveProperty('approvalTimeoutSec')
  })
})

describe('dispatchPrefillFromQuery (#205)', () => {
  test('accepts a full PLAN -> RUN handoff', () => {
    expect(dispatchPrefillFromQuery({ command: 'RUN', repoId: 'r1', feature: 'login', ref: 'feat/login' }))
      .toEqual({ command: 'RUN', repoId: 'r1', feature: 'login', ref: 'feat/login' })
  })

  test('drops unknown commands, bad features and overlong refs', () => {
    expect(dispatchPrefillFromQuery({ command: 'DELETE' })).toEqual({})
    expect(dispatchPrefillFromQuery({ feature: 'a/b' })).toEqual({})
    expect(dispatchPrefillFromQuery({ feature: 'a..b' })).toEqual({})
    expect(dispatchPrefillFromQuery({ ref: 'x'.repeat(256) })).toEqual({})
    expect(dispatchPrefillFromQuery({ repoId: '  ' })).toEqual({})
  })

  test('trims values and takes the first of an array query', () => {
    expect(dispatchPrefillFromQuery({ repoId: ['r1', 'r2'], feature: ' f1 ', ref: ' dev ' }))
      .toEqual({ repoId: 'r1', feature: 'f1', ref: 'dev' })
  })

  test('tolerates a missing query (route without query in tests)', () => {
    expect(dispatchPrefillFromQuery(undefined)).toEqual({})
    expect(dispatchPrefillFromQuery(null)).toEqual({})
  })
})

describe('token lists', () => {
  test('addToken trims, skips blanks and duplicates, never mutates', () => {
    const list = ['a']
    expect(addToken(list, ' b ')).toEqual(['a', 'b'])
    expect(addToken(list, 'a')).toEqual(['a'])
    expect(addToken(list, '  ')).toEqual(['a'])
    expect(list).toEqual(['a'])
  })

  test('removeToken', () => {
    expect(removeToken(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('dispatch tickets (C9 §4)', () => {
  test('defaults to none and sends none', () => {
    expect(DISPATCH_DEFAULTS.ticketRefs).toEqual([])
    expect(toDispatchBody(valid())).not.toHaveProperty('ticketRefs')
  })

  test('sends a copy of the chosen refs', () => {
    const values = valid({ ticketRefs: ['WEB-1', 'WEB-2'] })
    const body = toDispatchBody(values)
    expect(body.ticketRefs).toEqual(['WEB-1', 'WEB-2'])
    expect(body.ticketRefs).not.toBe(values.ticketRefs)
  })

  test('validates refs and the maximum', () => {
    expect(messages(valid({ ticketRefs: ['WEB-1'] }))).toEqual([])
    expect(messages(valid({ ticketRefs: ['web-1'] }))).toContain('fleet.dispatch.validation.tickets')
    expect(messages(valid({ ticketRefs: Array.from({ length: 21 }, (_, i) => `WEB-${i + 1}`) }))).toContain('fleet.dispatch.validation.tickets')
  })

  test('prefills tickets from ?tickets= and picks the notice (P7)', () => {
    const fromTicket = dispatchPrefillFromQuery({ command: 'PLAN', tickets: 'web-3', feature: 'web-3-add-csv-export' })
    expect(fromTicket).toEqual({ command: 'PLAN', ticketRefs: ['WEB-3'], feature: 'web-3-add-csv-export' })
    expect(prefillNotice(fromTicket)).toBe('ticket')
    const handoff = dispatchPrefillFromQuery({ command: 'RUN', repoId: 'r1', feature: 'f', ref: 'feat/f', tickets: 'WEB-3' })
    expect(prefillNotice(handoff)).toBe('plan')
    expect(prefillNotice(dispatchPrefillFromQuery({ tickets: 'junk' }))).toBeNull()
  })
})
