import { describe, expect, test } from '@jest/globals'
import type { FlowStartFormValues } from '~/lib/fleet-flow-start-form'
import { toFlowStartBody } from '~/lib/fleet-flow-start-body'

const row = { feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] as string[] }
const makeValues = (overrides: Partial<FlowStartFormValues> = {}): FlowStartFormValues => ({
  features: [{ ...row }],
  roles: { reviewer: 'm', supervisor: 'm' },
  costCapUsd: 2,
  ...overrides,
})

describe('toFlowStartBody', () => {
  test('US-004 AC-1: maps one parsed row into the API request body', () => {
    expect(toFlowStartBody(makeValues())).toEqual({
      features: [{ ...row }],
      roles: { reviewer: 'm', supervisor: 'm' },
      costCapUsd: 2,
    })
  })

  test('US-004 AC-2: converts a string cap to a number', () => {
    expect(toFlowStartBody(makeValues({ costCapUsd: '2.5' })).costCapUsd).toBe(2.5)
  })

  test('US-004 AC-3: copies each dependency array', () => {
    const input = makeValues({ features: [{ ...row, dependsOn: ['f-min'] }] })
    const body = toFlowStartBody(input)
    expect(body.features[0]?.dependsOn).toEqual(['f-min'])
    expect(body.features[0]?.dependsOn).not.toBe(input.features[0]?.dependsOn)
  })

  test('US-004 AC-4: returns a new feature array without changing input', () => {
    const input = makeValues()
    const before = structuredClone(input)
    const body = toFlowStartBody(input)
    expect(body.features).not.toBe(input.features)
    expect(input).toEqual(before)
  })

  test('US-004 AC-5: accepts frozen valid parsed values without mutation', () => {
    const dependencies = Object.freeze([] as string[])
    const feature = Object.freeze({ ...row, dependsOn: dependencies })
    const features = Object.freeze([feature])
    const roles = Object.freeze({ reviewer: 'm', supervisor: 'm' })
    const input = Object.freeze({ features, roles, costCapUsd: 2 })
    expect(() => toFlowStartBody(input)).not.toThrow()
    expect(toFlowStartBody(input)).toEqual({ features: [{ ...row }], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 })
  })
})
