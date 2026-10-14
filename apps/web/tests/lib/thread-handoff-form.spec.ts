import { describe, expect, test } from '@jest/globals'
import { buildThreadHandoffSchema, THREAD_HANDOFF_DEFAULTS, toThreadHandoffBody, type ThreadHandoffFormValues } from '~/lib/thread-handoff-form'

const t = (key: string): string => key
const schema = buildThreadHandoffSchema(t)
const valid = (over: Partial<ThreadHandoffFormValues> = {}): ThreadHandoffFormValues => ({ ...THREAD_HANDOFF_DEFAULTS, ...over })

/** The issue messages a parse produces; empty when the values pass. */
const messages = (values: unknown): string[] => {
  const r = schema.safeParse(values)
  return r.success ? [] : r.error.issues.map(issue => issue.message)
}

describe('US-002 thread handoff form defaults', () => {
  test('US-002 AC-8: THREAD_HANDOFF_DEFAULTS is an empty profile list, a 5 USD cap and raw bash', () => {
    expect(THREAD_HANDOFF_DEFAULTS).toEqual({ profiles: [], maxCostUsd: 5, bashMode: 'raw' })
  })
})

describe('US-002 toThreadHandoffBody', () => {
  test('US-002 AC-9: a PLAN from the defaults sends only the max cost', () => {
    expect(toThreadHandoffBody(THREAD_HANDOFF_DEFAULTS, 'PLAN')).toEqual({ maxCostUsd: 5 })
  })

  test('US-002 AC-10: a RUN sends profiles and the bash mode when both are set', () => {
    const body = toThreadHandoffBody({ profiles: ['native-ds', 'workflow'], maxCostUsd: 2.5, bashMode: 'gated' }, 'RUN')

    expect(body).toEqual({ maxCostUsd: 2.5, profiles: ['native-ds', 'workflow'], bashMode: 'gated' })
  })

  test('US-002 AC-11: a PLAN sends profiles but never bashMode', () => {
    const body = toThreadHandoffBody({ profiles: ['native-ds'], maxCostUsd: 2.5, bashMode: 'gated' }, 'PLAN')

    expect(body).toEqual({ maxCostUsd: 2.5, profiles: ['native-ds'] })
  })

  test('US-002 guard: an empty profile list is omitted from a RUN body, which still carries the bash mode', () => {
    const body = toThreadHandoffBody({ profiles: [], maxCostUsd: 3, bashMode: 'escalate' }, 'RUN')

    expect(body).toEqual({ maxCostUsd: 3, bashMode: 'escalate' })
    expect(body).not.toHaveProperty('profiles')
  })
})

describe('US-002 buildThreadHandoffSchema', () => {
  test('US-002 AC-12: a max cost with more than 4 decimals fails with the maxCost message', () => {
    expect(messages(valid({ maxCostUsd: 0.00001 }))).toContain('fleet.dispatch.validation.maxCost')
  })

  test('US-002 AC-13: a profile with the reserved koda-job- prefix fails with the profileName message', () => {
    expect(messages(valid({ profiles: ['koda-job-x'] }))).toContain('fleet.dispatch.validation.profileName')
  })

  test('US-002 AC-14: duplicate profiles fail with the profileDuplicate message', () => {
    expect(messages(valid({ profiles: ['a', 'a'] }))).toContain('fleet.dispatch.validation.profileDuplicate')
  })

  test('US-002 AC-15: THREAD_HANDOFF_DEFAULTS parses successfully', () => {
    expect(schema.safeParse(THREAD_HANDOFF_DEFAULTS).success).toBe(true)
  })
})
