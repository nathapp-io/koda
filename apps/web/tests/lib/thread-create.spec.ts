import { describe, expect, test } from '@jest/globals'
import { buildThreadCreateSchema, eligibleModels, toCreateThreadBody } from '~/lib/thread-create'
import type { FleetRunnerSummary } from '~/lib/fleet-types'

const t = (key: string): string => key
const schema = buildThreadCreateSchema(t)

/**
 * A minimally valid form snapshot in the AC4 shape: `maxCostUsd` is the raw form text
 * ('5'), which the body conversion turns into the number 5. `baseRef` and `effort` are
 * the empty-string defaults (the select's "default" entries).
 */
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repoId: 'r1',
  baseRef: '',
  feature: 'add-auth',
  title: 'Auth spec',
  maxCostUsd: '5',
  model: 'm1',
  effort: '',
  ...over,
})

/** The i18n keys a failed parse produced; schema messages are keys (like buildDispatchSchema). */
const issueKeys = (values: unknown): string[] => {
  const r = schema.safeParse(values)
  return r.success ? [] : r.error.issues.map((issue) => issue.message)
}

/** A US-005 runner summary carrying `threadBackends` (SEAM-4). */
const runner = (over: Partial<FleetRunnerSummary> = {}): FleetRunnerSummary => ({
  id: 'rn1',
  name: 'mac-1',
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: [], acp: [] },
  ...over,
})

describe('buildThreadCreateSchema (US-005 AC1-AC3)', () => {
  test('accepts a minimally valid form (guard for AC1-AC3)', () => {
    expect(issueKeys(valid())).toEqual([])
  })

  test('AC1: rejects feature a..b', () => {
    const keys = issueKeys(valid({ feature: 'a..b' }))
    expect(keys).not.toEqual([])
    expect(keys.some((key) => key.startsWith('fleet.threads.new.'))).toBe(true)
  })

  test('AC2: rejects a 201-character title', () => {
    const keys = issueKeys(valid({ title: 't'.repeat(201) }))
    expect(keys).not.toEqual([])
    expect(keys.some((key) => key.startsWith('fleet.threads.new.'))).toBe(true)
  })

  test('AC3: rejects cap 1.23456 (more than 4 decimals)', () => {
    const keys = issueKeys(valid({ maxCostUsd: 1.23456 }))
    expect(keys).not.toEqual([])
    expect(keys.some((key) => key.startsWith('fleet.threads.new.'))).toBe(true)
  })
})

describe('toCreateThreadBody (US-005 AC4-AC6)', () => {
  test('AC4: drops empty baseRef and effort, coerces the cap text to a number and sends a native backend', () => {
    const body = toCreateThreadBody({
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: '5',
      model: 'm1',
      effort: '',
      baseRef: '',
    })
    expect(body).toEqual({
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
    })
    // The empty effort/baseRef are absent, not empty strings (or undefined keys) in the body.
    expect(body).not.toHaveProperty('baseRef')
    expect(body.backend).not.toHaveProperty('effort')
  })

  test('AC5: an effort of high travels inside the backend', () => {
    const body = toCreateThreadBody({
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: '5',
      model: 'm1',
      effort: 'high',
      baseRef: '',
    })
    expect(body.backend).toEqual({ kind: 'native', model: 'm1', effort: 'high' })
    expect(body).not.toHaveProperty('baseRef')
  })

  test('AC6: a baseRef of develop travels as a top-level baseRef', () => {
    const body = toCreateThreadBody({
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: '5',
      model: 'm1',
      effort: '',
      baseRef: 'develop',
    })
    expect(body.baseRef).toBe('develop')
    expect(body.backend).toEqual({ kind: 'native', model: 'm1' })
  })
})

describe('eligibleModels (US-005 AC7-AC8)', () => {
  test('AC7: sorted unique union of threadBackends.native over online enabled runners', () => {
    expect(eligibleModels([
      runner({ id: 'a', online: true, enabled: true, threadBackends: { native: ['m2', 'm1'], acp: [] } }),
      runner({ id: 'b', online: true, enabled: true, threadBackends: { native: ['m1'], acp: [] } }),
    ])).toEqual(['m1', 'm2'])
  })

  test('AC8: an offline runner offers no model even with threadBackends.native populated', () => {
    expect(eligibleModels([
      runner({ online: false, enabled: true, threadBackends: { native: ['m3'], acp: [] } }),
    ])).toEqual([])
  })
})