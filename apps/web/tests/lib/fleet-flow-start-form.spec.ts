import { describe, expect, test } from '@jest/globals'
import { buildFlowStartSchema, buildPreApprovalSchema, firstFlowStartIssue, type FlowStartFormValues } from '~/lib/fleet-flow-start-form'

const t = (key: string): string => key
const schema = buildFlowStartSchema(t)
const row = { feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] as string[] }
const values = (over: Partial<FlowStartFormValues> = {}): FlowStartFormValues => ({
  features: [{ ...row }], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2, ...over,
})
const firstMessage = (input: unknown): string | undefined => {
  const result = schema.safeParse(input)
  return result.success ? undefined : result.error.issues[0]?.message
}

describe('buildFlowStartSchema', () => {
  test('US-003 AC-1: accepts a valid single feature flow', () => {
    expect(schema.safeParse(values()).success).toBe(true)
  })
  test('US-003 AC-2: rejects an invalid feature name', () => {
    expect(firstMessage(values({ features: [{ ...row, feature: 'bad name' }] }))).toBe('fleet.flows.start.validation.feature')
  })
  test('US-003 AC-3: rejects .. in a feature name', () => {
    expect(firstMessage(values({ features: [{ ...row, feature: 'a..b' }] }))).toBe('fleet.flows.start.validation.feature')
  })
  test('US-003 AC-4: reports duplicate feature names', () => {
    expect(firstMessage(values({ features: [{ ...row }, { ...row }] }))).toBe('fleet.flows.start.validation.featureDuplicate')
  })
  test('US-003 AC-5: rejects no features', () => {
    expect(firstMessage(values({ features: [] }))).toBe('fleet.flows.start.validation.featuresCount')
  })
  test('US-003 AC-6: rejects more than 20 features', () => {
    expect(firstMessage(values({ features: Array.from({ length: 21 }, (_, i) => ({ ...row, feature: `f-${i}` })) }))).toBe('fleet.flows.start.validation.featuresCount')
  })
  test.each(['/abs/spec.md', 'docs/spec.txt', 'docs/../spec.md'])('US-003 AC-7-9: rejects invalid spec path %s', specPath => {
    expect(firstMessage(values({ features: [{ ...row, specPath }] }))).toBe('fleet.flows.start.validation.specPath')
  })
  test('US-003 AC-10: dependencies must refer to earlier rows', () => {
    expect(firstMessage(values({ features: [{ ...row, dependsOn: ['f-clamp'] }, { ...row, feature: 'f-clamp' }] }))).toBe('fleet.flows.start.validation.dependsOn')
  })
  test('US-003 AC-11: dependencies must refer to existing rows', () => {
    expect(firstMessage(values({ features: [{ ...row, dependsOn: ['gone'] }] }))).toBe('fleet.flows.start.validation.dependsOn')
  })
  test('US-003 AC-12: validates reviewer role', () => {
    expect(firstMessage(values({ roles: { reviewer: 'has space', supervisor: 'm' } }))).toBe('fleet.flows.start.validation.role')
  })
  test('US-003 AC-13: caps cost at 1000', () => {
    expect(firstMessage(values({ costCapUsd: 1000.0001 }))).toBe('fleet.flows.start.validation.costCap')
  })
  test('US-003 AC-14: allows at most four decimals', () => {
    expect(firstMessage(values({ costCapUsd: 1.23456 }))).toBe('fleet.flows.start.validation.costCap')
  })
  test('US-003 AC-15: trims feature names in parsed output', () => {
    const result = schema.safeParse(values({ features: [{ ...row, feature: ' f-min ' }] }))
    expect(result.success && result.data.features[0]?.feature).toBe('f-min')
  })
  test('duplicate and dependency errors precede later role and cap errors', () => {
    expect(firstMessage(values({ features: [{ ...row }, { ...row }], roles: { reviewer: 'bad role', supervisor: 'm' }, costCapUsd: -1 }))).toBe('fleet.flows.start.validation.featureDuplicate')
  })
})

describe('firstFlowStartIssue', () => {
  // A row refinement (dependsOn) is collected after every row's field checks, so the raw issue list
  // can put a later row ahead of an earlier one; the form must still report the earliest row first.
  const mixed = () => {
    const result = schema.safeParse(values({ features: [
      { feature: 'a', specPath: '.nax/features/a/spec.md', dependsOn: ['gone'] },
      { feature: 'b', specPath: 'docs/spec.txt', dependsOn: ['a'] },
    ] }))
    if (result.success) throw new Error('expected the probe to fail validation')
    return result.error.issues
  }

  test('picks the earlier row refinement over a later row field issue', () => {
    const issues = mixed()
    expect(issues.map(issue => issue.path.join('.'))).toEqual(['features.1.specPath', 'features.0.dependsOn'])
    expect(firstFlowStartIssue(issues)?.path).toEqual(['features', 0, 'dependsOn'])
  })

  test('orders rows before reviewer, supervisor and the cap', () => {
    const result = schema.safeParse(values({ features: [{ ...row, feature: 'bad name' }], roles: { reviewer: 'bad role', supervisor: 'bad role' }, costCapUsd: 0 }))
    if (result.success) throw new Error('expected the probe to fail validation')
    expect(firstFlowStartIssue(result.error.issues)?.message).toBe('fleet.flows.start.validation.feature')
    expect(firstFlowStartIssue([])).toBeUndefined()
  })

  test('orders the feature count, each row field, then reviewer, supervisor and the cap', () => {
    const issue = (path: (string | number)[]) => ({ code: 'custom' as const, path, message: path.join('.') })
    // Given in reverse: the selection must follow the design's order, not the input order.
    const issues = [
      issue(['costCapUsd']), issue(['roles', 'supervisor']), issue(['roles', 'reviewer']),
      issue(['features', 1, 'specPath']), issue(['features', 0, 'dependsOn']),
      issue(['features', 0, 'specPath']), issue(['features', 0, 'feature']), issue(['features']),
    ]
    const ordered: string[] = []
    let remaining = issues
    for (let taken = firstFlowStartIssue(remaining); taken; taken = firstFlowStartIssue(remaining)) {
      ordered.push(taken.message)
      remaining = remaining.filter(candidate => candidate !== taken)
    }
    expect(ordered).toEqual([
      'features', 'features.0.feature', 'features.0.specPath', 'features.0.dependsOn',
      'features.1.specPath', 'roles.reviewer', 'roles.supervisor', 'costCapUsd',
    ])
  })
})

describe('buildPreApprovalSchema', () => {
  test('uses the pre-approval validation message and cap rule', () => {
    expect(buildPreApprovalSchema(t).safeParse({ costCapUsd: 1000.0001 })).toMatchObject({
      success: false, error: { issues: [ { message: 'fleet.flows.preapproval.validation' } ] },
    })
  })
  test('coerces an allowed cap to a number', () => {
    expect(buildPreApprovalSchema(t).parse({ costCapUsd: '2.5' })).toEqual({ costCapUsd: 2.5 })
  })
})
