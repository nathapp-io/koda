import { describe, expect, test } from '@jest/globals'
import { buildThreadCreateSchema, eligibleModels, toCreateThreadBody } from '~/lib/thread-create'
import type { ThreadCreateValues } from '~/lib/thread-create'
import type { FleetRunnerSummary } from '~/lib/fleet-types'

/**
 * US-007 (fleet S5b): the scope-aware half of the new-thread form helpers. A PROJECT thread carries
 * no repository, base ref or feature: the schema skips those rules, the body omits those keys even
 * when the hidden fields still hold REPO values, and only runners advertising `projectThreads`
 * offer models for it.
 */

const t = (key: string): string => key
const schema = buildThreadCreateSchema(t)

/** A runner summary as the API sends it: `projectThreads` gates PROJECT threads (S5b-R9). */
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
  projectThreads: false,
  ...over,
})

/** A PROJECT form: no repo and no feature (the fields the form hides). */
const projectValues = (over: Partial<ThreadCreateValues> = {}): ThreadCreateValues => ({
  kind: 'PROJECT',
  repoId: '',
  baseRef: '',
  feature: '',
  title: 'Chat about the project',
  maxCostUsd: '5',
  model: 'm1',
  effort: '',
  ...over,
})

describe('buildThreadCreateSchema scope (US-007 AC1-AC2)', () => {
  test('AC1: accepts a PROJECT form with an empty repoId, an empty feature, a title, a cap and a model', () => {
    expect(schema.safeParse(projectValues()).success).toBe(true)
  })

  test('AC1 (edge): a PROJECT form keeps parsing when the hidden feature holds a stale REPO value', () => {
    expect(schema.safeParse(projectValues({ repoId: 'r1', feature: 'a..b' })).success).toBe(true)
  })

  test('AC2: rejects a REPO form with an empty repoId with repoRequired at path repoId', () => {
    const result = schema.safeParse(projectValues({ kind: 'REPO', repoId: '' }))

    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues
    expect(issues.map(issue => [issue.path.join('.'), issue.message]))
      .toContainEqual(['repoId', 'fleet.threads.new.validation.repoRequired'])
  })

  test('AC2 (guard): the moved REPO rules still report base-ref and feature on their own fields', () => {
    const result = schema.safeParse(projectValues({ kind: 'REPO', repoId: 'r1', feature: 'a..b', baseRef: 'x'.repeat(256) }))

    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues
    expect(issues.map(issue => [issue.path.join('.'), issue.message])).toEqual(expect.arrayContaining([
      ['baseRef', 'fleet.threads.new.validation.baseRef'],
      ['feature', 'fleet.threads.new.validation.feature'],
    ]))
  })
})

describe('toCreateThreadBody scope (US-007 AC3-AC4)', () => {
  test('AC3: a PROJECT body is kind PROJECT with no repoId, feature or baseRef key', () => {
    const body = toCreateThreadBody(projectValues())

    expect(body.kind).toBe('PROJECT')
    expect(body).toEqual({
      kind: 'PROJECT',
      title: 'Chat about the project',
      maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
    })
  })

  test('AC3 (edge): REPO values left in the hidden fields never reach a PROJECT body', () => {
    const body = toCreateThreadBody(projectValues({ repoId: 'r1', baseRef: 'main', feature: 'add-auth' }))

    expect(Object.keys(body).sort()).toEqual(['backend', 'kind', 'maxCostUsd', 'title'])
  })

  test('AC4: a REPO body is today\'s body plus kind REPO', () => {
    const body = toCreateThreadBody({
      kind: 'REPO',
      repoId: 'r1',
      baseRef: '',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: '5',
      model: 'm1',
      effort: '',
    })

    expect(body).toEqual({
      kind: 'REPO',
      repoId: 'r1',
      feature: 'add-auth',
      title: 'Auth spec',
      maxCostUsd: 5,
      backend: { kind: 'native', model: 'm1' },
    })
  })
})

describe('eligibleModels scope (US-007 AC5-AC6)', () => {
  test('AC5: PROJECT returns only models of online, enabled runners whose projectThreads is true', () => {
    const models = eligibleModels([
      runner({ id: 'a', projectThreads: true, threadBackends: { native: ['m2', 'm1'], acp: [] } }),
      runner({ id: 'b', projectThreads: false, threadBackends: { native: ['m3'], acp: [] } }),
      runner({ id: 'c', projectThreads: true, online: false, threadBackends: { native: ['m4'], acp: [] } }),
      runner({ id: 'd', projectThreads: true, enabled: false, threadBackends: { native: ['m5'], acp: [] } }),
    ], 'PROJECT')

    expect(models).toEqual(['m1', 'm2'])
  })

  test('AC6: REPO returns models of online, enabled runners regardless of projectThreads', () => {
    const models = eligibleModels([
      runner({ id: 'a', projectThreads: true, threadBackends: { native: ['m1'], acp: [] } }),
      runner({ id: 'b', projectThreads: false, threadBackends: { native: ['m2'], acp: [] } }),
      runner({ id: 'c', online: false, projectThreads: false, threadBackends: { native: ['m3'], acp: [] } }),
    ], 'REPO')

    expect(models).toEqual(['m1', 'm2'])
  })
})
