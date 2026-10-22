import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { CATALOG, fakeApi, role } from '../helpers/roles-fixtures'
import { useRoles } from '../../composables/useRoles'

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

function withApi(api: ReturnType<typeof fakeApi>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useRoles (US-010)', () => {
  test('load reads /roles into roles', async () => {
    const api = fakeApi([role()])
    withApi(api)
    const roles = useRoles()

    await roles.load()

    expect(api.get).toHaveBeenCalledWith('/roles')
    expect(roles.roles.value).toEqual([role()])
  })

  test('a failed load keeps the last loaded roles', async () => {
    const api = fakeApi([role()])
    withApi(api)
    const roles = useRoles()
    await roles.load()
    api.get.mockImplementationOnce(async () => { throw new Error('down') })

    await expect(roles.load()).rejects.toThrow('down')

    expect(roles.roles.value).toEqual([role()])
    expect(roles.pending.value).toBe(false)
  })

  test('loadCatalog reads /permissions/catalog and returns the entries', async () => {
    const api = fakeApi([])
    withApi(api)
    const roles = useRoles()

    const entries = await roles.loadCatalog()

    expect(api.get).toHaveBeenCalledWith('/permissions/catalog')
    expect(entries).toEqual(CATALOG)
    expect(roles.catalog.value).toEqual(CATALOG)
  })

  test('create posts to /roles, update patches /roles/<id>, remove deletes it', async () => {
    const api = fakeApi([])
    withApi(api)
    const roles = useRoles()

    await roles.create({ key: 'qa', name: 'QA', description: '', scope: 'PROJECT', permissions: ['ticket.read'] })
    await roles.update('r 1', { permissions: [] })
    await roles.remove('r 1')

    expect(api.post).toHaveBeenCalledWith('/roles', { key: 'qa', name: 'QA', description: '', scope: 'PROJECT', permissions: ['ticket.read'] })
    expect(api.patch).toHaveBeenCalledWith('/roles/r%201', { permissions: [] })
    expect(api.delete).toHaveBeenCalledWith('/roles/r%201')
    expect(jest.isMockFunction(api.delete)).toBe(true)
  })
})
