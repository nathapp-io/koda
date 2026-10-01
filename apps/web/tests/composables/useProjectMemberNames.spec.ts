import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectMemberNames.ts')
const g = globalThis as Record<string, unknown>

describe('useProjectMemberNames', () => {
  beforeEach(() => { g.useApi = undefined })

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
})
