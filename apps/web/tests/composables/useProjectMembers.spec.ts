import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectMembers.ts')
const m = (userId: string, role = 'DEVELOPER') => ({ userId, email: `${userId}@k.t`, name: userId, role, joinedAt: '2026-09-26T00:00:00Z' })
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useProjectMembers', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load fetches page 1; loadMore appends the next page', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => pageOf([m('a')], { total: 2, hasNext: true }))
      .mockImplementationOnce(async () => pageOf([m('b')], { total: 2, current: 2, hasPrev: true }))
    withApi({ get })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')

    await members.load()
    await members.loadMore()

    expect(get).toHaveBeenNthCalledWith(1, '/projects/team/members', { query: {} })
    expect(get).toHaveBeenNthCalledWith(2, '/projects/team/members', { query: { current: '2' } })
    expect(members.members.value.map((x: { userId: string }) => x.userId)).toEqual(['a', 'b'])
    expect(members.hasNext.value).toBe(false)
  })

  test('add appends, changeRole replaces, remove filters', async () => {
    const get = jest.fn(async () => pageOf([m('a', 'ADMIN')]))
    const post = jest.fn(async () => m('b', 'VIEWER'))
    const patch = jest.fn(async () => m('b', 'DEVELOPER'))
    const del = jest.fn(async () => ({}))
    withApi({ get, post, patch, delete: del })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')
    await members.load()

    await members.add('b@k.t', 'VIEWER')
    await members.changeRole('b', 'DEVELOPER')
    await members.remove('a')

    expect(post).toHaveBeenCalledWith('/projects/team/members', { email: 'b@k.t', role: 'VIEWER' })
    expect(patch).toHaveBeenCalledWith('/projects/team/members/b', { role: 'DEVELOPER' })
    expect(del).toHaveBeenCalledWith('/projects/team/members/a')
    expect(members.members.value).toEqual([m('b', 'DEVELOPER')])
    expect(members.total.value).toBe(1)
  })

  test('canManageMembers: global admin or project ADMIN member only', async () => {
    const { canManageMembers } = await import(composablePath)
    const list = [m('pa', 'ADMIN'), m('dev', 'DEVELOPER')]
    expect(canManageMembers({ id: 'root', role: 'ADMIN' }, list)).toBe(true)
    expect(canManageMembers({ id: 'pa', role: 'MEMBER' }, list)).toBe(true)
    expect(canManageMembers({ id: 'dev', role: 'MEMBER' }, list)).toBe(false)
    expect(canManageMembers(null, list)).toBe(false)
  })
})
