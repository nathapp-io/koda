import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetDispatchOptions.ts')
const g = globalThis as Record<string, unknown>
const page = (records: unknown[], hasNext = false) => ({ records, total: records.length, current: 1, size: 100, hasNext, hasPrev: false })
const runner = (id: string, name: string, profiles: string[], labels: string[]) => ({ id, name, os: 'linux', arch: 'x64', labels, enabled: true, online: true, profiles })
const repo = (id: string, owner: string, name: string) => ({ id, projectId: 'p1', provider: 'github', owner, name, defaultBranch: 'main', githubInstallationId: '7', createdAt: 'x' })

describe('useFleetDispatchOptions', () => {
  beforeEach(() => { g.useApi = undefined })

  test('loads repos and runner summaries, 100 each, and flags more', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/repos')
      ? page([repo('r1', 'acme', 'app')])
      : page([runner('n1', 'mac-1', ['fast', 'review'], ['mac']), runner('n2', 'lin-1', ['fast', 'cheap'], ['linux', 'mac'])], true)))
    g.useApi = () => ({ $api: { get } })
    const { useFleetDispatchOptions } = await import(composablePath)
    const options = useFleetDispatchOptions('web')

    await options.load()

    expect(get).toHaveBeenCalledWith('/projects/web/fleet/repos', { query: { size: '100' } })
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/runners', { query: { size: '100' } })
    expect(options.moreRepos.value).toBe(false)
    expect(options.moreRunners.value).toBe(true)
    expect(options.profileOptions.value).toEqual(['cheap', 'fast', 'review'])
    expect(options.labelOptions.value).toEqual(['linux', 'mac'])
    expect(options.repoName('r1')).toBe('acme/app')
    expect(options.repoName('gone')).toBe('gone')
    expect(options.runnerName('n2')).toBe('lin-1')
    expect(options.runnerName(null)).toBeNull()
    expect(options.runnerName('deleted')).toBe('deleted')
  })
})
