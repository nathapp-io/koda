import { describe, expect, test } from '@jest/globals'
import { flowStartRows, flowStartState } from '~/lib/fleet-flow-start'
import type { ThreadDto } from '~/lib/thread-types'

const thread = (overrides: Partial<ThreadDto> = {}): ThreadDto => ({
  id: 't1', kind: 'REPO', repoId: 'r1', baseRef: 'main', feature: 'f-min', title: 'Plan', createdById: 'u1',
  runnerId: 'rn1', backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: '.nax/features/f-min/spec.md', pendingQuestion: null, session: null,
  lastActivityAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', activeJob: null,
  writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null, preApproval: null,
  ...overrides,
})
const published = (paths: string[]): ThreadDto['lastWrite'] => ({
  kind: 'published', jobId: 'j1', at: '2026-01-01T00:00:00.000Z', sha: 'abc', paths, ignored: [],
})

describe('flow start rows', () => {
  test('AC-1 own feature is first row', () => {
    expect(flowStartRows(thread())).toEqual([{ feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }])
  })
  test('AC-2 published paths add unique feature rows and chain dependencies', () => {
    expect(flowStartRows(thread({ lastWrite: published(['.nax/features/f-min/spec.md', 'docs/design.md', '.nax/features/f-clamp/spec.md']) }))).toEqual([
      { feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] },
      { feature: 'f-clamp', specPath: '.nax/features/f-clamp/spec.md', dependsOn: ['f-min'] },
    ])
  })
  test('AC-3 each subsequent published row depends on its predecessor', () => {
    expect(flowStartRows(thread({ feature: 'a', specPath: '.nax/features/a/spec.md', lastWrite: published(['.nax/features/b/spec.md', '.nax/features/c/spec.md']) }))).toEqual([
      { feature: 'a', specPath: '.nax/features/a/spec.md', dependsOn: [] },
      { feature: 'b', specPath: '.nax/features/b/spec.md', dependsOn: ['a'] },
      { feature: 'c', specPath: '.nax/features/c/spec.md', dependsOn: ['b'] },
    ])
  })
  test.each(['discarded', 'publish_failed'] as const)('AC-4/13 ignores %s writes', kind => {
    const lastWrite = kind === 'discarded'
      ? { kind, jobId: 'j1', at: 'now', sha: 'abc' } as const
      : { kind, jobId: 'j1', at: 'now', reason: 'failed' } as const
    expect(flowStartRows(thread({ lastWrite }))).toHaveLength(1)
  })
  test('AC-5 feature rows can come from publish without an own feature', () => {
    expect(flowStartRows(thread({ feature: null, specPath: null, lastWrite: published(['.nax/features/x/spec.md']) }))).toEqual([
      { feature: 'x', specPath: '.nax/features/x/spec.md', dependsOn: [] },
    ])
  })
  test('AC-14 duplicate published paths produce only one row', () => {
    expect(flowStartRows(thread({ feature: 'a', specPath: '.nax/features/a/spec.md', lastWrite: published(['.nax/features/b/spec.md', '.nax/features/b/spec.md']) }))).toHaveLength(2)
  })
})

describe('flow start availability', () => {
  test('AC-6 published eligible REPO thread is enabled', () => {
    expect(flowStartState(thread({ specPublished: true, publishedSha: 'abc' }), { canCreate: true, liveFlow: false })).toEqual({ visible: true, enabled: true, reason: null })
  })
  test('AC-7 PROJECT thread is hidden', () => {
    expect(flowStartState(thread({ kind: 'PROJECT' }), { canCreate: true, liveFlow: false }).visible).toBe(false)
  })
  test('AC-8 archived thread is hidden', () => {
    expect(flowStartState(thread({ archivedAt: 'now' }), { canCreate: true, liveFlow: false }).visible).toBe(false)
  })
  test('AC-9 without create permission is hidden', () => {
    expect(flowStartState(thread(), { canCreate: false, liveFlow: false }).visible).toBe(false)
  })
  test('AC-10 unpublished takes precedence over a live flow', () => {
    expect(flowStartState(thread({ specPublished: false, publishedSha: 'abc' }), { canCreate: true, liveFlow: true })).toEqual({ visible: true, enabled: false, reason: 'notPublished' })
  })
  test('AC-11 null published sha blocks start', () => {
    expect(flowStartState(thread({ specPublished: true, publishedSha: null }), { canCreate: true, liveFlow: false })).toEqual({ visible: true, enabled: false, reason: 'notPublished' })
  })
  test('AC-12 live flow blocks a published thread', () => {
    expect(flowStartState(thread({ specPublished: true, publishedSha: 'abc' }), { canCreate: true, liveFlow: true })).toEqual({ visible: true, enabled: false, reason: 'flowLive' })
  })
})
