import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectMembers.ts')
const namesPath = join(__dirname, '../..', 'composables', 'useProjectMemberNames.ts')

/** Permissions P1 US-013: the unified principal row the members list now returns. */
const row = (over: Record<string, unknown> = {}) => ({
  principalType: 'USER',
  principalId: 'a',
  userId: 'a',
  email: 'a@k.t',
  agentSlug: null,
  name: 'a',
  disabled: false,
  joinedAt: '2026-09-26T00:00:00Z',
  bindings: [{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }],
  ...over,
})
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({
  records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over,
})

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useProjectMembers', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load fetches page 1 of every principal kind; loadMore appends the next page', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => pageOf([row()], { total: 2, hasNext: true }))
      .mockImplementationOnce(async () => pageOf([row({ principalId: 'b', userId: 'b', email: 'b@k.t' })], { total: 2, current: 2, hasPrev: true }))
    withApi({ get })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')

    await members.load()
    await members.loadMore()

    expect(get).toHaveBeenNthCalledWith(1, '/projects/team/members', { query: { principals: 'all' } })
    expect(get).toHaveBeenNthCalledWith(2, '/projects/team/members', { query: { principals: 'all', current: '2' } })
    expect(members.members.value.map((x: { principalId: string }) => x.principalId)).toEqual(['a', 'b'])
    expect(members.hasNext.value).toBe(false)
  })

  test('AC-10: add(email, roleKey) posts the role key and appends the returned row', async () => {
    const get = jest.fn(async () => pageOf([row()]))
    const added = row({ principalId: 'b', userId: 'b', email: 'a@b.io', name: null, bindings: [{ id: 'b2', roleKey: 'triager', roleName: 'Triager' }] })
    const post = jest.fn(async () => added)
    withApi({ get, post })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('web')
    await members.load()

    await members.add('a@b.io', 'triager')

    expect(post).toHaveBeenCalledWith('/projects/web/members', { email: 'a@b.io', roleKey: 'triager' })
    expect(members.members.value.map((x: { principalId: string }) => x.principalId)).toEqual(['a', 'b'])
    expect(members.total.value).toBe(2)
  })

  test('a rejected add throws and appends nothing', async () => {
    const get = jest.fn(async () => pageOf([row()]))
    const post = jest.fn(async () => { throw new Error('nope') })
    withApi({ get, post })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')
    await members.load()

    await expect(members.add('a@b.io', 'triager')).rejects.toThrow('nope')
    expect(members.members.value.map((x: { principalId: string }) => x.principalId)).toEqual(['a'])
  })

  test('reload refetches the current page instead of resetting to page 1', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => pageOf([row()], { total: 2, hasNext: true }))
      .mockImplementationOnce(async () => pageOf([row({ principalId: 'b', userId: 'b' })], { total: 2, current: 2 }))
      .mockImplementationOnce(async () => pageOf([row({ principalId: 'b', userId: 'b' })], { total: 2, current: 2 }))
    withApi({ get })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')

    await members.load()
    await members.loadMore()
    await members.reload()

    expect(get).toHaveBeenNthCalledWith(3, '/projects/team/members', { query: { principals: 'all', current: '2' } })
    expect(members.members.value.map((x: { principalId: string }) => x.principalId)).toEqual(['b'])
  })

  test('an agent row keeps its own principal identity', async () => {
    const get = jest.fn(async () => pageOf([
      row({ principalType: 'AGENT', principalId: 'ag1', userId: null, email: null, agentSlug: 'bot', name: 'Bot', bindings: [] }),
    ]))
    withApi({ get })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')

    await members.load()

    const only = members.members.value[0] as { principalType: string; agentSlug: string | null; userId: string | null }
    expect(only.principalType).toBe('AGENT')
    expect(only.agentSlug).toBe('bot')
    expect(only.userId).toBeNull()
  })

  test('the legacy member writer surface is gone', async () => {
    withApi({ get: jest.fn(async () => pageOf([])) })
    const module_ = await import(composablePath) as Record<string, unknown>
    const members = (module_.useProjectMembers as (slug: string) => Record<string, unknown>)('team')

    expect(module_.ASSIGNABLE_MEMBER_ROLES).toBeUndefined()
    expect(members.changeRole).toBeUndefined()
    expect(members.remove).toBeUndefined()
    expect(members.add).toBeInstanceOf(Function)
  })
})

describe('useProjectMemberNames (US-013 keeps the default page)', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('AC-10: load still asks the members route for one page of users only', async () => {
    const get = jest.fn(async () => ({ records: [{ userId: 'u1', email: 'u1@k.t', name: 'One', role: 'DEVELOPER', joinedAt: '2026-09-26T00:00:00Z', disabled: false }] }))
    withApi({ get })
    const { useProjectMemberNames } = await import(namesPath)
    const names = useProjectMemberNames('web')

    await names.load()

    expect(get).toHaveBeenCalledWith('/projects/web/members', { query: { size: '100' } })
    expect(names.nameOf('u1')).toBe('One')
    expect(names.nameOf('missing')).toBeNull()
  })
})
