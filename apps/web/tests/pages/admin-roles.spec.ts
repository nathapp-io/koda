/**
 * Permissions P1 US-010 (AC-1, AC-2, AC-8 list half, AC-9, AC-11): the Admin -> Roles page, mounted
 * for real over a fake `$api`. The real `useRoles` and the real editor dialog run underneath it.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { fakeApi, role, settle, type FakeApi } from '../helpers/roles-fixtures'
import { allById, byId, call } from '../helpers/roles-dom'
import { permissionSet } from '../../lib/permissions'
import * as apiModule from '../../composables/useApi'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useRoles } from '../../composables/useRoles'
import type { Role } from '../../composables/useRoles'

const pagePath = webFile('pages', 'admin', 'roles.vue')

const SYSTEM = role({ id: 's1', key: 'developer', name: 'Developer', scope: 'PROJECT', system: true, permissions: ['ticket.read'] })
const LOCKED = role({ id: 'l1', key: 'owner', name: 'Owner', scope: 'PROJECT', system: true, locked: true, permissions: ['*'] })
const CUSTOM = role({ id: 'c1', key: 'qa', name: 'QA', scope: 'GLOBAL' })

interface Mount { app: Mounted; api: FakeApi; toast: { error: jest.Mock; success: jest.Mock }; confirm: jest.Mock }

async function mountPage(roles: Role[], options: { keys?: string[]; api?: Partial<FakeApi>; confirm?: boolean } = {}): Promise<Mount> {
  const api = fakeApi(roles, options.api)
  const toast = { error: jest.fn(), success: jest.fn() }
  const confirm = jest.fn(() => options.confirm ?? true)
  ;(globalThis as Record<string, unknown>).window = { confirm }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const held = permissionSet(options.keys ?? ['role.read', 'role.manage'])
  const app = mountSfc(pagePath, {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useRoles,
      useGlobalPermissions: () => ({ permissions: computed(() => held) }),
    },
  })
  await settle()
  return { app, api, toast, confirm }
}

const rowFor = (app: Mounted, key: string): FakeNode =>
  allById(app, 'role-row').find((r) => r.props['data-key'] === key) as FakeNode
const copy = (key: string): string => {
  const value = key.split('.').reduce<unknown>((n, p) => (n as Record<string, unknown> | undefined)?.[p], enLocale)
  expect(typeof value).toBe('string')
  return value as string
}

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

describe('AC-1: the list shows name, key, scope and the system and locked badges', () => {
  test('two roles list their name, key and scope; only the system role has a system badge, only the locked a locked badge', async () => {
    const m = await mountPage([SYSTEM, LOCKED])

    expect(m.api.get).toHaveBeenCalledWith('/roles')
    expect(allById(m.app, 'role-row')).toHaveLength(2)

    const system = rowFor(m.app, 'developer')
    expect(m.app.textOf(system)).toContain('Developer')
    expect(m.app.textOf(byId(m.app, 'role-key-cell', system))).toBe('developer')
    expect(m.app.textOf(byId(m.app, 'role-scope-cell', system))).toBe(copy('admin.roles.scope.PROJECT'))
    expect(allById(m.app, 'role-system-badge', system)).toHaveLength(1)
    expect(allById(m.app, 'role-locked-badge', system)).toHaveLength(0)

    const locked = rowFor(m.app, 'owner')
    expect(allById(m.app, 'role-locked-badge', locked)).toHaveLength(1)
  })

  test('a custom role carries neither badge', async () => {
    const m = await mountPage([CUSTOM])

    const row = rowFor(m.app, 'qa')
    expect(allById(m.app, 'role-system-badge', row)).toHaveLength(0)
    expect(allById(m.app, 'role-locked-badge', row)).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'role-scope-cell', row))).toBe(copy('admin.roles.scope.GLOBAL'))
  })
})

describe('AC-2: a refused list shows the admin-only message', () => {
  test('GET /roles rejecting with 40003 renders the message and no role list', async () => {
    const m = await mountPage([SYSTEM], { api: { get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) as never } })

    expect(m.app.text()).toContain(copy('admin.roles.adminOnly'))
    expect(allById(m.app, 'role-row')).toHaveLength(0)
    expect(allById(m.app, 'roles-table')).toHaveLength(0)
    expect(m.toast.error).not.toHaveBeenCalled()
  })

  test('any other load failure toasts the API error and shows no admin-only message', async () => {
    const err = new ApiError(50000, 'boom')
    const m = await mountPage([], { api: { get: jest.fn(async () => { throw err }) as never } })

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.text()).not.toContain(copy('admin.roles.adminOnly'))
  })
})

describe('AC-8 (list half): a system role has no delete button', () => {
  test('system and locked rows have no delete; a custom row has one', async () => {
    const m = await mountPage([SYSTEM, LOCKED, CUSTOM])

    expect(allById(m.app, 'role-delete', rowFor(m.app, 'developer'))).toHaveLength(0)
    expect(allById(m.app, 'role-delete', rowFor(m.app, 'owner'))).toHaveLength(0)
    expect(allById(m.app, 'role-delete', rowFor(m.app, 'qa'))).toHaveLength(1)
  })
})

describe('AC-9: deleting a custom role', () => {
  test('confirming sends DELETE /roles/<id> and reloads the list', async () => {
    const m = await mountPage([CUSTOM])
    const reads = m.api.get.mock.calls.filter(([p]) => p === '/roles').length

    call(byId(m.app, 'role-delete', rowFor(m.app, 'qa')), 'onClick')
    await settle()

    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.api.delete).toHaveBeenCalledTimes(1)
    expect((m.api.delete.mock.calls[0] as [string])[0]).toBe('/roles/c1')
    expect(m.api.get.mock.calls.filter(([p]) => p === '/roles').length).toBe(reads + 1)
  })

  test('declining the confirmation sends nothing', async () => {
    const m = await mountPage([CUSTOM], { confirm: false })

    call(byId(m.app, 'role-delete', rowFor(m.app, 'qa')), 'onClick')
    await settle()

    expect(m.api.delete).not.toHaveBeenCalled()
  })

  test('a 409 rejection toasts extractApiError(err) and the role stays listed', async () => {
    const err = new ApiError(409, 'A binding still uses this role')
    const m = await mountPage([CUSTOM], { api: { delete: jest.fn(async () => { throw err }) as never } })

    call(byId(m.app, 'role-delete', rowFor(m.app, 'qa')), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'role-row')).toHaveLength(1)
    expect(rowFor(m.app, 'qa')).toBeDefined()
  })
})

describe('AC-11: controls need role.manage', () => {
  test('with role.read alone there is no create, edit or delete control', async () => {
    const m = await mountPage([SYSTEM, LOCKED, CUSTOM], { keys: ['role.read'] })

    expect(allById(m.app, 'role-row')).toHaveLength(3)
    expect(allById(m.app, 'role-create')).toHaveLength(0)
    expect(allById(m.app, 'role-edit')).toHaveLength(0)
    expect(allById(m.app, 'role-delete')).toHaveLength(0)
  })

  test('with role.manage the page shows create, an edit per row and delete on custom rows', async () => {
    const m = await mountPage([SYSTEM, LOCKED, CUSTOM], { keys: ['role.read', 'role.manage'] })

    expect(allById(m.app, 'role-create')).toHaveLength(1)
    expect(allById(m.app, 'role-edit')).toHaveLength(3)
    expect(allById(m.app, 'role-delete')).toHaveLength(1)
  })

  test('the edit control opens the editor on that role', async () => {
    const m = await mountPage([CUSTOM])

    call(byId(m.app, 'role-edit', rowFor(m.app, 'qa')), 'onClick')
    await settle()

    expect(byId(m.app, 'role-name').props.modelValue).toBe('QA')
  })
})
