import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectMemberNames.ts')
const g = globalThis as Record<string, unknown>

describe('useProjectMemberNames', () => {
  beforeEach(() => { g.useApi = undefined; g.useAuth = undefined })

  test('loads 100 members and resolves names, falling back to email, null for an unknown id', async () => {
    const get = jest.fn(async () => ({
      records: [
        { userId: 'u1', email: 'ann@k.t', name: 'Ann', role: 'ADMIN', joinedAt: 'x' },
        { userId: 'u2', email: 'bob@k.t', name: null, role: 'DEVELOPER', joinedAt: 'x' },
      ],
    }))
    g.useApi = () => ({ $api: { get } })
    const { useProjectMemberNames } = await import(composablePath)
    const people = useProjectMemberNames('web')

    await people.load()

    expect(get).toHaveBeenCalledWith('/projects/web/members', { query: { size: '100' } })
    expect(people.nameOf('u1')).toBe('Ann')
    expect(people.nameOf('u2')).toBe('bob@k.t')
    expect(people.nameOf('gone')).toBeNull()
  })

  test('names the signed-in user when they are not a project member (a global admin)', async () => {
    const get = jest.fn(async () => ({ records: [] }))
    g.useApi = () => ({ $api: { get } })
    g.useAuth = () => ({ user: { value: { id: 'admin', email: 'root@k.t', name: 'Root' } } })
    const { useProjectMemberNames } = await import(composablePath)
    const people = useProjectMemberNames('web')

    await people.load()

    expect(people.nameOf('admin')).toBe('Root')
    expect(people.nameOf('gone')).toBeNull()
  })

  test('falls back to the signed-in email, and to null when no auth context exists', async () => {
    g.useApi = () => ({ $api: { get: jest.fn(async () => ({ records: [] })) } })
    g.useAuth = () => ({ user: { value: { id: 'admin', email: 'root@k.t' } } })
    const { useProjectMemberNames } = await import(composablePath)
    expect(useProjectMemberNames('web').nameOf('admin')).toBe('root@k.t')

    g.useAuth = undefined
    expect(useProjectMemberNames('web').nameOf('admin')).toBeNull()
  })
})
