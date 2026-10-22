/**
 * Permissions P1 US-011 (AC-5, AC-6, AC-7, AC-8, AC-10): the reusable principal-roles dialog.
 *
 * The dialog is mounted for real over a fake `$api` with the real `useRoleBindings`, so a spec
 * asserts the HTTP calls the API receives and the `changed` event the owning page reacts to. Roles
 * and bindings arrive as props (the page reads them from `GET /roles` and `GET /role-bindings`); the
 * caller's keys arrive through the real `useGlobalPermissions` contract.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile, type Mounted } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { allById, byId, call, settle } from '../helpers/roles-dom'
import { permissionSet } from '../../lib/permissions'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useRoleBindings } from '../../composables/useRoleBindings'
import type { RoleBinding } from '../../composables/useRoleBindings'
import type { Role } from '../../composables/useRoles'

const dialogPath = webFile('components', 'PrincipalRolesDialog.vue')

const MEMBER = { id: 'r1', key: 'member', name: 'Member', description: '', scope: 'GLOBAL', system: true, locked: false, permissions: [], expandedKeys: [] } as Role
const DEVELOPER = { id: 'r2', key: 'developer', name: 'Developer', description: '', scope: 'PROJECT', system: true, locked: false, permissions: [], expandedKeys: [] } as Role
const OWNER = { id: 'r3', key: 'owner', name: 'Owner', description: '', scope: 'GLOBAL', system: true, locked: true, permissions: [], expandedKeys: [] } as Role
const ALL_ROLES = [MEMBER, DEVELOPER, OWNER]

const binding = (id: string, over: Partial<RoleBinding> = {}): RoleBinding => ({
  id,
  principalType: 'USER',
  principalId: 'u2',
  roleId: 'r1',
  roleKey: 'member',
  projectId: null,
  grantedByType: 'USER',
  grantedById: 'admin',
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
})

interface FakeApi { get: jest.Mock; post: jest.Mock; delete: jest.Mock }

function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async () => ({ records: [], hasNext: false })),
    post: jest.fn(async (_path: string, body: Record<string, unknown>) => binding('b9', { roleKey: String(body.roleKey) })),
    delete: jest.fn(async () => undefined),
    ...over,
  }
}

interface MountOptions {
  keys?: string[]
  principal?: { type: 'USER' | 'AGENT'; id: string; label: string }
  bindings?: RoleBinding[]
  roles?: Role[]
  api?: Partial<FakeApi>
}

interface Mount {
  app: Mounted
  api: FakeApi
  toast: { success: jest.Mock; error: jest.Mock }
}

async function mountDialog(options: MountOptions = {}): Promise<Mount> {
  const api = fakeApi(options.api)
  const toast = { success: jest.fn(), error: jest.fn() }
  const held = permissionSet(options.keys ?? ['role.read', 'role.binding.global'])
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const app = mountSfc(dialogPath, {
    props: {
      open: true,
      principal: options.principal ?? { type: 'USER', id: 'u2', label: 'Bob' },
      bindings: options.bindings ?? [binding('b1')],
      roles: options.roles ?? ALL_ROLES,
    },
    components: uiStubs,
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useGlobalPermissions: () => ({ permissions: computed(() => held) }),
      useRoleBindings,
    },
  })
  await settle()
  return { app, api, toast }
}

/** The copy a chip shows, read from the real en.json tree so the assertion is i18n-driven. */
const allProjectsCopy = (name: string): string => {
  const template = (enLocale.admin as Record<string, Record<string, Record<string, string>>>).bindings.chip.allProjects
  return template.replace('{name}', name)
}

const offeredKeys = (app: Mounted): string[] => app.find('option').map((option) => String(option.props.value))

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

describe('AC-5: the dialog offers the unbound roles and grants one', () => {
  test('member is already bound, owner is withheld without role.binding.owner, developer is offered', async () => {
    const m = await mountDialog()

    expect(offeredKeys(m.app)).toEqual(['', 'developer'])
  })

  test('choosing developer posts the binding with projectId null and emits changed', async () => {
    const m = await mountDialog()

    call(byId(m.app, 'binding-role-select'), 'onChange', { target: { value: 'developer' } })
    await settle()
    call(byId(m.app, 'binding-add'), 'onClick')
    await settle()

    expect(m.api.post).toHaveBeenCalledTimes(1)
    expect(m.api.post).toHaveBeenCalledWith('/role-bindings', {
      principalType: 'USER', principalId: 'u2', roleKey: 'developer', projectId: null,
    })
    expect(m.app.emitted('changed')).toHaveLength(1)
  })

  test('the chips carry each role name, and a PROJECT-scope role reads "(all projects)"', async () => {
    const m = await mountDialog({ bindings: [binding('b1'), binding('b2', { roleId: 'r2', roleKey: 'developer' })] })

    const chips = allById(m.app, 'binding-chip')
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toContain('Member')
    expect(m.app.textOf(chips[1])).toContain(allProjectsCopy('Developer'))
  })
})

describe('AC-6: removing a chip', () => {
  test('sends DELETE /role-bindings/<id> and emits changed', async () => {
    const m = await mountDialog()

    call(byId(m.app, 'binding-remove'), 'onClick')
    await settle()

    expect(m.api.delete).toHaveBeenCalledWith('/role-bindings/b1')
    expect(m.app.emitted('changed')).toHaveLength(1)
  })
})

describe('AC-7: the owner role is offered only to a caller holding role.binding.owner, for a user', () => {
  test('a caller with role.binding.owner sees owner for a user principal', async () => {
    const m = await mountDialog({ keys: ['role.read', 'role.binding.global', 'role.binding.owner'], bindings: [] })

    expect(offeredKeys(m.app)).toEqual(['', 'member', 'developer', 'owner'])
  })

  test('without role.binding.owner the owner role is not offered', async () => {
    const m = await mountDialog({ bindings: [] })

    expect(offeredKeys(m.app)).not.toContain('owner')
  })

  test('an agent principal is never offered owner, even for a caller holding role.binding.owner', async () => {
    const m = await mountDialog({
      keys: ['role.read', 'role.binding.global', 'role.binding.owner'],
      bindings: [],
      principal: { type: 'AGENT', id: 'a1', label: 'Fleet bot' },
    })

    expect(offeredKeys(m.app)).not.toContain('owner')
    expect(offeredKeys(m.app)).toEqual(['', 'member', 'developer'])
  })
})

describe('AC-8: a refused grant', () => {
  test('toasts the API error, emits no changed and keeps the chips and the dialog open', async () => {
    const err = new ApiError(40003, 'You cannot grant a role you do not hold')
    const m = await mountDialog({ api: { post: jest.fn(async () => { throw err }) } })

    call(byId(m.app, 'binding-role-select'), 'onChange', { target: { value: 'developer' } })
    await settle()
    call(byId(m.app, 'binding-add'), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.emitted('changed')).toHaveLength(0)
    const chips = allById(m.app, 'binding-chip')
    expect(chips).toHaveLength(1)
    expect(m.app.textOf(chips[0])).toContain('Member')
    expect(allById(m.app, 'principal-roles-body')).toHaveLength(1)
  })
})

describe('AC-10: a refused removal', () => {
  test('toasts the API error, keeps the last chips and leaves the dialog open', async () => {
    const err = new ApiError(409, 'The last owner cannot be removed')
    const m = await mountDialog({ api: { delete: jest.fn(async () => { throw err }) } })

    call(byId(m.app, 'binding-remove'), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.emitted('changed')).toHaveLength(0)
    expect(allById(m.app, 'binding-chip')).toHaveLength(1)
    expect(allById(m.app, 'principal-roles-body')).toHaveLength(1)
  })
})
