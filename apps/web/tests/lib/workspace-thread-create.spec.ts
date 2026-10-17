import { describe, expect, test } from '@jest/globals'
import { buildWorkspaceThreadCreateSchema, toCreateWorkspaceThreadBody } from '~/lib/workspace-thread-create'

/**
 * US-004 (fleet S5b 1d): the new-workspace-thread form helpers. A WORKSPACE thread is not
 * project-scoped, so the body carries no repository keys at all: the form offers a home project
 * (empty = Automatic, the API then picks the host) and the native backend.
 */

/** A translator that marks its keys, so a test proves the schema used the injected `t`. */
const t = (key: string): string => `msg:${key}`
const schema = buildWorkspaceThreadCreateSchema(t)

/** A minimally valid form snapshot: `maxCostUsd` is the raw field text, as the form holds it. */
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  homeProject: '',
  title: 'Plan the rollout',
  model: 'm1',
  effort: '',
  maxCostUsd: '5',
  ...over,
})

/** The messages a failed parse produced; schema messages are translated keys. */
const issueKeys = (values: unknown): string[] => {
  const r = schema.safeParse(values)
  return r.success ? [] : r.error.issues.map((issue) => issue.message)
}

describe('buildWorkspaceThreadCreateSchema (US-004 AC-14)', () => {
  test('AC-14 (guard): accepts a minimally valid form with an automatic home project', () => {
    expect(issueKeys(valid())).toEqual([])
  })

  test('AC-14: rejects an empty model with the message the injected t answers for validation.required', () => {
    expect(issueKeys(valid({ model: '' }))).toContain(t('fleet.threads.new.validation.required'))
  })

  test('AC-14 (boundary): a cap of 1.23456 (more than 4 decimals) is rejected too', () => {
    expect(issueKeys(valid({ maxCostUsd: 1.23456 }))).not.toEqual([])
  })
})

describe('toCreateWorkspaceThreadBody (US-004 AC-12-AC-13)', () => {
  test('AC-12: an empty home project and an empty effort are absent, not empty keys', () => {
    const body = toCreateWorkspaceThreadBody({ homeProject: '', title: 't', model: 'm1', effort: '', maxCostUsd: 5 })

    expect(body).toEqual({ title: 't', maxCostUsd: 5, backend: { kind: 'native', model: 'm1' } })
    expect(body).not.toHaveProperty('homeProject')
    expect(body.backend).not.toHaveProperty('effort')
  })

  test('AC-13: a home project of web travels as homeProject', () => {
    const body = toCreateWorkspaceThreadBody({ homeProject: 'web', title: 't', model: 'm1', effort: '', maxCostUsd: 5 })

    expect(body.homeProject).toBe('web')
    // The body still carries no repository keys: a WORKSPACE thread has none.
    expect(body).not.toHaveProperty('repoId')
    expect(body).not.toHaveProperty('feature')
  })

  test('AC-13 (boundary): the schema-parsed values carry the effort into the backend', () => {
    const values = schema.parse({ homeProject: 'web', title: 't', model: 'm1', effort: 'high', maxCostUsd: '5' })
    const body = toCreateWorkspaceThreadBody(values)

    expect(body.backend).toEqual({ kind: 'native', model: 'm1', effort: 'high' })
    expect(body.maxCostUsd).toBe(5)
    expect(body.homeProject).toBe('web')
  })
})
