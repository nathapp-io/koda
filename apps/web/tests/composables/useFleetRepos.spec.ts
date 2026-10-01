import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetRepos.ts')
const repo = (id: string) => ({ id, projectId: 'p1', provider: 'github', owner: 'acme', name: id, defaultBranch: 'main', githubInstallationId: '7', createdAt: '2026-10-01T00:00:00Z' })
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })
const ok = (repoId: string) => ({ repoId, reachable: true, reason: null, checkedAt: '2026-10-01T00:00:00Z' })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useFleetRepos', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load asks for one page of 100', async () => {
    const get = jest.fn(async () => pageOf([repo('a')], { hasNext: true }))
    withApi({ get })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()

    await fleet.load()

    expect(get).toHaveBeenCalledWith('/fleet/repos', { query: { size: '100' } })
    expect(fleet.repos.value).toHaveLength(1)
    expect(fleet.hasMore.value).toBe(true)
  })

  test('loadProjects keeps id, slug and name', async () => {
    const get = jest.fn(async () => [{ id: 'p1', slug: 'koda', name: 'Koda', key: 'KODA' }])
    withApi({ get })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()

    await fleet.loadProjects()

    expect(get).toHaveBeenCalledWith('/projects')
    expect(fleet.projects.value).toEqual([{ id: 'p1', slug: 'koda', name: 'Koda' }])
  })

  test('check records checking, then the result; a failed request becomes an error state', async () => {
    const post = jest.fn()
      .mockImplementationOnce(async () => ok('a'))
      .mockImplementationOnce(async () => { throw new Error('network down') })
    withApi({ get: jest.fn(), post })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()

    const pending = fleet.check('a')
    expect(fleet.checks.value.a).toEqual({ status: 'checking' })
    await pending
    await fleet.check('b')

    expect(post).toHaveBeenNthCalledWith(1, '/fleet/repos/a/check', {})
    expect(fleet.checks.value.a).toEqual({ status: 'done', result: ok('a') })
    expect(fleet.checks.value.b).toEqual({ status: 'error', message: 'network down' })
  })

  test('checkAll checks every loaded repo with at most CHECK_CONCURRENCY in flight', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    let inFlight = 0
    let peak = 0
    const post = jest.fn(async (path: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return ok(path.split('/')[3])
    })
    withApi({ get: jest.fn(async () => pageOf(ids.map(repo))), post })
    const { useFleetRepos, CHECK_CONCURRENCY } = await import(composablePath)
    const fleet = useFleetRepos()
    await fleet.load()

    await fleet.checkAll()

    expect(post).toHaveBeenCalledTimes(ids.length)
    expect(peak).toBeLessThanOrEqual(CHECK_CONCURRENCY)
    expect(Object.keys(fleet.checks.value).sort()).toEqual(ids)
  })

  test('a check still in flight when its repo is removed does not bring its state back', async () => {
    let release: (value: unknown) => void = () => undefined
    const post = jest.fn(() => new Promise((resolve) => { release = resolve }))
    withApi({ get: jest.fn(async () => pageOf([repo('a')])), post, delete: jest.fn(async () => ({})) })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()
    await fleet.load()

    const checking = fleet.check('a')
    await fleet.remove('a')
    release(ok('a'))
    await checking

    expect(fleet.checks.value).toEqual({})
  })

  test('create posts the body and appends; remove deletes, drops the row and its check', async () => {
    const post = jest.fn()
      .mockImplementationOnce(async () => repo('b'))
      .mockImplementationOnce(async () => ok('a'))
    const del = jest.fn(async () => ({}))
    withApi({ get: jest.fn(async () => pageOf([repo('a')])), post, delete: del })
    const { useFleetRepos } = await import(composablePath)
    const fleet = useFleetRepos()
    await fleet.load()

    await fleet.create({ projectSlug: 'koda', provider: 'github', owner: 'acme', name: 'b' })
    await fleet.check('a')
    await fleet.remove('a')

    expect(post).toHaveBeenNthCalledWith(1, '/fleet/repos', { projectSlug: 'koda', provider: 'github', owner: 'acme', name: 'b' })
    expect(del).toHaveBeenCalledWith('/fleet/repos/a')
    expect(fleet.repos.value.map((x: { id: string }) => x.id)).toEqual(['b'])
    expect(fleet.checks.value).toEqual({})
  })
})
