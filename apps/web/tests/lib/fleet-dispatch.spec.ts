import { describe, expect, test } from '@jest/globals'
import { addToken, buildDispatchSchema, DISPATCH_DEFAULTS, removeToken, toDispatchBody, type DispatchFormValues } from '~/lib/fleet-dispatch'

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
