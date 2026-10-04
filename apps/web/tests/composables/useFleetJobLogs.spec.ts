import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetJobLogs.ts')
const g = globalThis as Record<string, unknown>

describe('useFleetJobLogs (S2a §3)', () => {
  beforeEach(() => {
    g.useRuntimeConfig = () => ({ public: { apiBaseUrl: '/api' } })
  })

  test('list and entries call the read routes with encoded segments and the given query', async () => {
    const get = jest.fn(async () => ({}))
    g.useApi = () => ({ $api: { get } })
    const { useFleetJobLogs } = await import(composablePath)
    const logs = useFleetJobLogs('my proj', 'j/1')

    await logs.list()
    await logs.entries('stdout', { direction: 'backward', limit: '200' })

    expect(get).toHaveBeenNthCalledWith(1, '/projects/my%20proj/fleet/jobs/j%2F1/logs')
    expect(get).toHaveBeenNthCalledWith(2, '/projects/my%20proj/fleet/jobs/j%2F1/logs/stdout/entries', { query: { direction: 'backward', limit: '200' } })
  })

  test('downloadHref is a proxied raw download URL for one attempt', async () => {
    g.useApi = () => ({ $api: { get: jest.fn() } })
    const { useFleetJobLogs } = await import(composablePath)
    expect(useFleetJobLogs('web', 'j1').downloadHref('run', 2))
      .toBe('/api/projects/web/fleet/jobs/j1/logs/run/raw?download=1&leaseEpoch=2')
  })
})
