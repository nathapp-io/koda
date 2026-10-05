import { describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetAnalytics.ts')
const g = globalThis as Record<string, unknown>
const W = { from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' }

describe('useFleetAnalytics (S2b §4.2, D388)', () => {
  test('project routes encode the slug and send string query values', async () => {
    const get = jest.fn(async () => ({}))
    g.useApi = () => ({ $api: { get } })
    const { useFleetAnalytics } = await import(composablePath)
    const api = useFleetAnalytics('my proj')

    await api.spend(W, 'stage', 7)
    await api.spend(W, 'role')
    await api.quality(W)
    await api.stories(W, 'attempts', 10)
    await api.jobs(W, 10)
    await api.ingest(W)
    await api.job('j/1')

    expect(get.mock.calls).toEqual([
      ['/projects/my%20proj/fleet/analytics/spend', { query: { ...W, groupBy: 'stage', top: '7' } }],
      ['/projects/my%20proj/fleet/analytics/spend', { query: { ...W, groupBy: 'role' } }],
      ['/projects/my%20proj/fleet/analytics/quality', { query: W }],
      ['/projects/my%20proj/fleet/analytics/stories', { query: { ...W, sort: 'attempts', limit: '10' } }],
      ['/projects/my%20proj/fleet/analytics/jobs', { query: { ...W, sort: 'cost', limit: '10' } }],
      ['/projects/my%20proj/fleet/analytics/ingest', { query: W }],
      ['/projects/my%20proj/fleet/jobs/j%2F1/analytics'],
    ])
  })

  test('admin routes: cross-project spend, the ingest list page and the re-ingest actions', async () => {
    const get = jest.fn(async () => ({}))
    const post = jest.fn(async () => ({ queued: 1 }))
    g.useApi = () => ({ $api: { get, post } })
    const { useFleetAnalyticsAdmin } = await import(composablePath)
    const api = useFleetAnalyticsAdmin()

    await api.spend(W, 'project', 7)
    await api.ingestList(undefined, 1)
    await api.ingestList('failed', 3)
    await api.backfill()
    await api.rerun('j/1')
    await api.rerunOutdated()

    expect(get.mock.calls).toEqual([
      ['/fleet/analytics/spend', { query: { ...W, groupBy: 'project', top: '7' } }],
      ['/fleet/ingest', { query: { size: '20' } }],
      ['/fleet/ingest', { query: { size: '20', status: 'failed', current: '3' } }],
    ])
    expect(post.mock.calls).toEqual([['/fleet/ingest/backfill'], ['/fleet/ingest/jobs/j%2F1/rerun'], ['/fleet/ingest/rerun-outdated']])
  })
})
