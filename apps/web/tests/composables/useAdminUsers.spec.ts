import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useAdminUsers.ts')
const u = (id: string, over: Record<string, unknown> = {}) => ({ id, email: `${id}@k.t`, name: id, role: 'MEMBER', disabled: false, createdAt: '2026-09-26T00:00:00Z', ...over })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useAdminUsers', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('buildUserQuery trims the email and sends current only past page 1', async () => {
    const { buildUserQuery } = await import(composablePath)
    expect(buildUserQuery({})).toEqual({})
    expect(buildUserQuery({ email: '  bob ', page: 1 })).toEqual({ email: 'bob' })
    expect(buildUserQuery({ page: 3 })).toEqual({ current: '3' })
  })

  test('load reads records, total, current and hasNext', async () => {
    const get = jest.fn(async () => ({ records: [u('a')], total: 21, current: 1, size: 20, hasNext: true, hasPrev: false }))
    withApi({ get })
    const { useAdminUsers } = await import(composablePath)
    const users = useAdminUsers()

    await users.load({ email: 'a' })

    expect(get).toHaveBeenCalledWith('/admin/users', { query: { email: 'a' } })
    expect(users.users.value).toHaveLength(1)
    expect(users.total.value).toBe(21)
    expect(users.hasNext.value).toBe(true)
  })

  test('setDisabled patches and replaces the row without mutating the old array', async () => {
    const get = jest.fn(async () => ({ records: [u('a'), u('b')], total: 2, current: 1, size: 20, hasNext: false, hasPrev: false }))
    const patch = jest.fn(async () => u('b', { disabled: true }))
    withApi({ get, patch })
    const { useAdminUsers } = await import(composablePath)
    const users = useAdminUsers()
    await users.load()
    const before = users.users.value

    await users.setDisabled('b', true)

    expect(patch).toHaveBeenCalledWith('/admin/users/b', { disabled: true })
    expect(users.users.value[1].disabled).toBe(true)
    expect(before[1].disabled).toBe(false)
  })

  test('setRole patches the role', async () => {
    const get = jest.fn(async () => ({ records: [u('a')], total: 1, current: 1, size: 20, hasNext: false, hasPrev: false }))
    const patch = jest.fn(async () => u('a', { role: 'ADMIN' }))
    withApi({ get, patch })
    const { useAdminUsers } = await import(composablePath)
    const users = useAdminUsers()
    await users.load()

    await users.setRole('a', 'ADMIN')

    expect(patch).toHaveBeenCalledWith('/admin/users/a', { role: 'ADMIN' })
    expect(users.users.value[0].role).toBe('ADMIN')
  })
})
