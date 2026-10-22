/**
 * Permissions P1 US-011 (AC-1): the bindings API the admin pages and the principal dialog share.
 * The fake `$api` records the HTTP calls, so a spec asserts the requests, not a composable double.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useRoleBindings.ts')

interface Binding {
  id: string
  principalType: string
  principalId: string
  roleId: string
  roleKey: string
  projectId: string | null
  grantedByType: string
  grantedById: string
  createdAt: string
}

const binding = (id: string, over: Partial<Binding> = {}): Binding => ({
  id,
  principalType: 'USER',
  principalId: 'u1',
  roleId: 'r1',
  roleKey: 'member',
  projectId: null,
  grantedByType: 'USER',
  grantedById: 'admin',
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
})

interface QueryOptions { query: Record<string, string> }

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

describe('AC-1: listGlobal pages GET /role-bindings until hasNext is false', () => {
  test('page 1 and page 2 are both requested and both pages\' records returned', async () => {
    const get = jest.fn(async (_path: string, options: QueryOptions) =>
      options.query.current === '1'
        ? { records: [binding('b1')], total: 2, current: 1, size: 200, hasNext: true, hasPrev: false }
        : { records: [binding('b2', { roleKey: 'developer' })], total: 2, current: 2, size: 200, hasNext: false, hasPrev: true })
    withApi({ get })
    const { useRoleBindings } = await import(composablePath)

    const records = await useRoleBindings().listGlobal('USER')

    expect(get).toHaveBeenNthCalledWith(1, '/role-bindings', {
      query: { principalType: 'USER', scope: 'global', size: '200', current: '1' },
    })
    expect(get).toHaveBeenNthCalledWith(2, '/role-bindings', {
      query: { principalType: 'USER', scope: 'global', size: '200', current: '2' },
    })
    expect(records.map((row: Binding) => row.id)).toEqual(['b1', 'b2'])
  })

  test('one page is enough when hasNext is false, and the composable keeps the records', async () => {
    const get = jest.fn(async () => ({ records: [binding('b1')], total: 1, current: 1, size: 200, hasNext: false, hasPrev: false }))
    withApi({ get })
    const { useRoleBindings } = await import(composablePath)
    const bindings = useRoleBindings()

    await bindings.listGlobal('AGENT')

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/role-bindings', {
      query: { principalType: 'AGENT', scope: 'global', size: '200', current: '1' },
    })
    expect(bindings.bindings.value.map((row: Binding) => row.id)).toEqual(['b1'])
  })

  test('a failure on page 2 keeps the last loaded bindings instead of a half page', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ records: [binding('b1')], total: 1, current: 1, size: 200, hasNext: false, hasPrev: false })
      .mockResolvedValueOnce({ records: [binding('b1')], total: 2, current: 1, size: 200, hasNext: true, hasPrev: false })
      .mockRejectedValueOnce(new Error('page 2 down'))
    withApi({ get })
    const { useRoleBindings } = await import(composablePath)
    const bindings = useRoleBindings()
    await bindings.listGlobal('USER')

    await expect(bindings.listGlobal('USER')).rejects.toThrow('page 2 down')

    expect(bindings.bindings.value.map((row: Binding) => row.id)).toEqual(['b1'])
  })

  // Fix round 1 / F3: a page cap silently published an incomplete listing.
  test('F3: pages to the end well past 50 pages instead of truncating the listing', async () => {
    const TOTAL_PAGES = 60
    const get = jest.fn(async (_path: string, options: QueryOptions) => {
      const current = Number(options.query.current)
      return {
        records: [binding(`b${current}`)],
        total: TOTAL_PAGES,
        current,
        size: 200,
        hasNext: current < TOTAL_PAGES,
        hasPrev: current > 1,
      }
    })
    withApi({ get })
    const { useRoleBindings } = await import(composablePath)

    const records = await useRoleBindings().listGlobal('USER')

    expect(get).toHaveBeenCalledTimes(TOTAL_PAGES)
    expect(records).toHaveLength(TOTAL_PAGES)
    expect(records[TOTAL_PAGES - 1].id).toBe(`b${TOTAL_PAGES}`)
  })

  // Fix round 1 / F3: paging to completion still needs a guard against a server that never advances.
  test('F3: a page that claims another page but returns no records rejects instead of spinning', async () => {
    const get = jest.fn(async () => ({ records: [], hasNext: true }))
    withApi({ get })
    const { useRoleBindings } = await import(composablePath)
    const bindings = useRoleBindings()

    await expect(bindings.listGlobal('USER')).rejects.toThrow(/no records/i)

    expect(bindings.bindings.value).toEqual([])
  })
})

describe('useRoleBindings writes', () => {
  test('create posts the principal, the role key and the project id', async () => {
    const post = jest.fn(async () => binding('b9', { roleKey: 'developer' }))
    withApi({ post })
    const { useRoleBindings } = await import(composablePath)

    const created = await useRoleBindings().create({
      principalType: 'USER', principalId: 'u2', roleKey: 'developer', projectId: null,
    })

    expect(post).toHaveBeenCalledWith('/role-bindings', {
      principalType: 'USER', principalId: 'u2', roleKey: 'developer', projectId: null,
    })
    expect(created.id).toBe('b9')
  })

  test('remove deletes the binding by its escaped id', async () => {
    const del = jest.fn(async () => undefined)
    withApi({ delete: del })
    const { useRoleBindings } = await import(composablePath)

    await useRoleBindings().remove('b 1')

    expect(del).toHaveBeenCalledWith('/role-bindings/b%201')
  })
})
