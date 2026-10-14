import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ThreadWriteResult } from '~/lib/thread-types'

/**
 * US-004 AC-14: ThreadWriteMarker renders the latest Publish or Discard result. Runner-written
 * paths and reasons are `{{ }}` interpolation only, never markdown or HTML.
 */

const markerFile = webFile('components', 'fleet', 'threads', 'ThreadWriteMarker.vue')
const at = '2026-10-14T10:02:00.000Z'

const mountMarker = (write: ThreadWriteResult, useI18n = i18nStub) =>
  mountSfc(markerFile, {
    props: { write },
    components: uiStubs,
    globals: { useI18n: () => useI18n() },
  })

describe('US-004 ThreadWriteMarker', () => {
  test('AC-14: a published result whose paths are [<b>a.md</b>] renders one thread-write-marker-path item whose text is the literal <b>a.md</b>', () => {
    const app = mountMarker({ kind: 'published', jobId: 'w1', at, sha: 'abcdef1234567', paths: ['<b>a.md</b>'], ignored: [] })

    const items = app.find('[data-testid="thread-write-marker-path"]')
    expect(items).toHaveLength(1)
    expect(app.textOf(items[0])).toBe('<b>a.md</b>')
    expect(app.find('b')).toEqual([])
  })

  test('a published marker shows the published key with its sha and count params', () => {
    const app = mountMarker(
      { kind: 'published', jobId: 'w1', at, sha: 'abcdef1234567', paths: ['a.md', 'b.md'], ignored: [] },
      () => enI18n(),
    )

    expect(app.one('[data-testid="thread-write-marker"]')).toBeDefined()
    expect(app.text()).toContain('Published 2 paths as abcdef1')
  })

  test('ignored paths render under the markerIgnored label as their own list', () => {
    const app = mountMarker({ kind: 'published', jobId: 'w1', at, sha: 'abcdef1', paths: ['a.md'], ignored: ['node_modules/x.md'] })

    const ignored = app.find('[data-testid="thread-write-marker-ignored"]')
    expect(ignored).toHaveLength(1)
    expect(app.textOf(ignored[0])).toBe('node_modules/x.md')
    expect(app.text()).toContain('fleet.threads.handoff.markerIgnored')
  })

  test('a discarded marker renders no path list', () => {
    const app = mountMarker({ kind: 'discarded', jobId: 'w1', at, sha: 'abcdef1' })

    expect(app.find('[data-testid="thread-write-marker-path"]')).toEqual([])
    expect(app.find('details')).toEqual([])
    expect(app.text()).toContain('fleet.threads.handoff.marker.discarded')
  })

  test('a branch_moved publish failure renders the publishFailedBranchMoved key', () => {
    const app = mountMarker({ kind: 'publish_failed', jobId: 'w1', at, reason: 'branch_moved' })

    expect(app.text()).toContain('fleet.threads.handoff.marker.publishFailedBranchMoved')
  })

  test('a runner-written failure reason renders as literal text, never as HTML', () => {
    const app = mountMarker({ kind: 'discard_failed', jobId: 'w1', at, reason: '<img src=x onerror=alert(1)>' }, () => enI18n())

    expect(app.text()).toContain('<img src=x onerror=alert(1)>')
    expect(app.find('img')).toEqual([])
  })
})
