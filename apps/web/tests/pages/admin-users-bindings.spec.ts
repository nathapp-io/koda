/**
 * Permissions P1 US-011 (AC-2, AC-3, AC-4, AC-11 list half, AC-12): the Admin -> Users page manages
 * global role bindings instead of a MEMBER/ADMIN enum.
 *
 * The page is mounted for real: the real `useGlobalPermissions`, `useAdminUsers`, `useRoles` and
 * `useRoleBindings` run over a fake `$api`, and the real `PrincipalRolesDialog` and
 * `CreateUserDialog` are its children. So a spec asserts the requests the API receives, the keys the
 * mounted page actually resolved from `/me/permissions`, and the chips, errors and gates the admin
 * sees.
 */
import { afterEach, describe, test, expect, beforeEach, jest } from '@jest/globals'
import { defineComponent, h, ref } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, loadSfc, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { allById, byId, call, settle } from '../helpers/roles-dom'
import { fakeAsyncData } from '../helpers/permission-nav'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useGlobalPermissions } from '../../composables/usePermissions'
import { useAdminUsers } from '../../composables/useAdminUsers'
import { useRoles } from '../../composables/useRoles'
import { useRoleBindings } from '../../composables/useRoleBindings'
import type { Role } from '../../composables/useRoles'
import type { RoleBinding } from '../../composables/useRoleBindings'

const pagePath = webFile('pages', 'admin', 'users.vue')

const role = (over: Partial<Role>): Role => ({
  id: 'r0', key: 'member', name: 'Member', description: '', scope: 'GLOBAL',
  system: true, locked: false, permissions: [], expandedKeys: [], ...over,
})
const MEMBER = role({ id: 'r1', key: 'member', name: 'Member' })
const DEVELOPER = role({ id: 'r2', key: 'developer', name: 'Developer', scope: 'PROJECT' })
const OWNER = role({ id: 'r3', key: 'owner', name: 'Owner', locked: true })
const ROLES = [MEMBER, DEVELOPER, OWNER]

const user = (id: string, over: Record<string, unknown> = {}) => ({
  id, email: `${id}@koda.test`, name: id.toUpperCase(), role: 'MEMBER', disabled: false,
  createdAt: '2026-10-01T00:00:00Z', ...over,
})
// `u1` is the signed-in admin: the page never offers to edit its own bindings.
const USERS = [user('u1', { role: 'ADMIN' }), user('u2')]

const binding = (id: string, over: Partial<RoleBinding> = {}): RoleBinding => ({
  id, principalType: 'USER', principalId: 'u2', roleId: 'r1', roleKey: 'member',
  projectId: null, grantedByType: 'USER', grantedById: 'u1', createdAt: '2026-10-01T00:00:00Z', ...over,
})
const BINDINGS = [binding('b1'), binding('b2', { roleId: 'r2', roleKey: 'developer' })]

interface FakeApi {
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  delete: jest.Mock
}

// A JSON response is a new object with a new array each time; a shared instance would make a ref see
// an unchanged value and skip the re-render.
const usersPage = (records: unknown[] = USERS) => ({
  records: [...records], total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false,
})
const bindingsPage = (records: RoleBinding[] = BINDINGS) => ({
  records: [...records], total: records.length, current: 1, size: 200, hasNext: false, hasPrev: false,
})

function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/admin/users') return usersPage()
      if (path === '/roles') return ROLES
      if (path === '/role-bindings') return bindingsPage()
      throw new Error(`unexpected GET ${path}`)
    }),
    post: jest.fn(async () => user('u9')),
    patch: jest.fn(async () => user('u2', { disabled: true })),
    delete: jest.fn(async () => undefined),
    ...over,
  }
}

/** The create-user dialog is mounted for real, so its form fields need the real vee-validate bridge. */
const FormField = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props, { slots }) {
    const { value, handleChange, handleBlur } = useField<string>(() => props.name)
    return () => slots.default?.({ componentField: {
      modelValue: value.value,
      'onUpdate:modelValue': handleChange,
      onBlur: handleBlur,
    } })
  },
})

const Input = defineComponent({
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => h('input', {
      ...attrs,
      value: props.modelValue,
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    })
  },
})

interface Mount {
  app: Mounted
  api: FakeApi
  toast: { success: jest.Mock; error: jest.Mock }
  /** The `useAsyncData` handles the page and the dialog hold, so a spec can drive a permission refresh. */
  permissionData: AsyncCallHandle[]
}

interface AsyncCallHandle {
  data: { value: unknown }
  pending: { value: boolean }
  error: { value: unknown }
}

interface MountOptions {
  keys?: string[]
  api?: Partial<FakeApi>
  meId?: string
  /** What `GET /me/permissions` answers; a promise lets a spec hold the keys back (F1). */
  permissionsGet?: () => Promise<unknown>
}

async function mountPage(options: MountOptions = {}): Promise<Mount> {
  const api = fakeApi(options.api)
  const toast = { success: jest.fn(), error: jest.fn() }
  const keys = options.keys ?? ['role.read', 'role.binding.global', 'user.read']
  const permissionsGet = options.permissionsGet ?? (async () => ({ scope: 'global', projectSlug: null, keys }))
  const host = globalThis as Record<string, unknown>
  const permissionData: AsyncCallHandle[] = []
  // The real permission composable is what the page gates on, so it resolves its own keys from
  // `/me/permissions` through the two Nuxt auto-imports a mounted SFC does not supply to it. Each
  // handle is kept so a spec can put the composable back into its pending state (a refresh).
  host.useAsyncData = <T,>(key: string, run: () => Promise<T>, opts?: { default?: () => T }) => {
    const result = fakeAsyncData(key, run, opts)
    permissionData.push(result as unknown as AsyncCallHandle)
    return result
  }
  host.useApi = () => ({
    $api: {
      ...api,
      // Only `/me/permissions` is answered here; every other path reaches the recording fake with the
      // exact arguments the composable used.
      get: jest.fn(async (path: string, query?: unknown) => {
        if (path === '/me/permissions') return permissionsGet()
        return query === undefined ? api.get(path) : api.get(path, query)
      }),
    },
  })
  const globals: Record<string, unknown> = {
    useI18n: () => enI18n(),
    useAppToast: () => toast,
    useAuth: () => ({ user: ref({ id: options.meId ?? 'u1' }) }),
    useGlobalPermissions,
    useAdminUsers,
    useRoles,
    useRoleBindings,
  }
  const app = mountSfc(pagePath, {
    components: {
      ...uiStubs,
      FormField,
      Input,
      CreateUserDialog: loadSfc(webFile('components', 'CreateUserDialog.vue'), globals),
    },
    globals,
  })
  await settle()
  return { app, api, toast, permissionData }
}

const rowFor = (app: Mounted, id: string): FakeNode =>
  allById(app, 'user-row').find((row) => row.props['data-user'] === id) as FakeNode

const allProjectsCopy = (name: string): string => {
  const template = (enLocale.admin as Record<string, Record<string, Record<string, string>>>).bindings.chip.allProjects
  return template.replace('{name}', name)
}

/** The dialog a node sits in, found by walking up to the Dialog stub that owns it. */
function dialogOf(node: FakeNode): FakeNode {
  let current: FakeNode | null = node.parent
  while (current) {
    if (current.props['data-stub'] === 'dialog') return current
    current = current.parent
  }
  throw new Error('node is not inside a dialog')
}

beforeEach(() => {
  const host = globalThis as Record<string, unknown>
  host.useApi = undefined
  host.useAsyncData = undefined
})

afterEach(() => {
  const host = globalThis as Record<string, unknown>
  delete host.useApi
  delete host.useAsyncData
})

describe('AC-2: the role column shows one chip per global binding', () => {
  test("each chip carries the role's name and a PROJECT-scope role reads \"(all projects)\"", async () => {
    const m = await mountPage()

    expect(m.api.get).toHaveBeenCalledWith('/roles')
    expect(m.api.get).toHaveBeenCalledWith('/role-bindings', {
      query: { principalType: 'USER', scope: 'global', size: '200', current: '1' },
    })

    const bob = rowFor(m.app, 'u2')
    const chips = allById(m.app, 'user-role-chip', bob)
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toBe('Member')
    expect(m.app.textOf(chips[1])).toBe(allProjectsCopy('Developer'))

    // A user with no binding has the column but no chip.
    expect(allById(m.app, 'user-roles-cell', rowFor(m.app, 'u1'))).toHaveLength(1)
    expect(allById(m.app, 'user-role-chip', rowFor(m.app, 'u1'))).toHaveLength(0)
  })
})

describe('AC-3: Edit roles is for other users and needs role.read + role.binding.global', () => {
  test('an admin holding both keys gets one Edit roles button, for the other user only', async () => {
    const m = await mountPage()

    const buttons = allById(m.app, 'user-edit-roles')
    expect(buttons).toHaveLength(1)
    expect(m.app.textOf(buttons[0])).toBe(enLocale.admin && (enLocale.admin as Record<string, Record<string, string>>).users.editRoles)
    expect(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u2'))).toHaveLength(1)
    expect(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u1'))).toHaveLength(0)
  })

  test('without role.binding.global there is no Edit roles and no roles column', async () => {
    const m = await mountPage({ keys: ['role.read'] })

    expect(allById(m.app, 'user-row')).toHaveLength(2)
    expect(allById(m.app, 'user-edit-roles')).toHaveLength(0)
    expect(allById(m.app, 'user-roles-cell')).toHaveLength(0)
  })

  test('without role.read there is no Edit roles and no roles column', async () => {
    const m = await mountPage({ keys: ['role.binding.global'] })

    expect(allById(m.app, 'user-row')).toHaveLength(2)
    expect(allById(m.app, 'user-edit-roles')).toHaveLength(0)
    expect(allById(m.app, 'user-roles-cell')).toHaveLength(0)
    // No role.read means the roles listing is never even asked for (it would be a 403).
    expect(m.api.get.mock.calls.filter(([path]) => path === '/roles')).toHaveLength(0)
  })
})

describe('AC-4: a refused binding list', () => {
  test('toasts the API error, shows it in the roles column and renders no chips', async () => {
    const err = new ApiError(50000, 'bindings are down')
    const m = await mountPage({
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return { records: USERS, total: 2, current: 1, size: 20, hasNext: false, hasPrev: false }
          if (path === '/roles') return ROLES
          throw err
        }),
      },
    })

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'user-role-chip')).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'user-roles-cell', rowFor(m.app, 'u2')))).toContain(extractApiError(err))
  })
})

describe('AC-12: a refused role list', () => {
  test('shows the load error in the roles column and renders no chips', async () => {
    const err = new ApiError(50000, 'roles are down')
    const m = await mountPage({
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return { records: USERS, total: 2, current: 1, size: 20, hasNext: false, hasPrev: false }
          if (path === '/role-bindings') return { records: BINDINGS, total: 2, current: 1, size: 200, hasNext: false, hasPrev: false }
          throw err
        }),
      },
    })

    expect(allById(m.app, 'user-role-chip')).toHaveLength(0)
    expect(allById(m.app, 'user-roles-error')).toHaveLength(2)
    expect(m.app.textOf(allById(m.app, 'user-roles-error')[0])).toBe(extractApiError(err))
  })
})

describe('Edit roles opens the shared dialog on that user', () => {
  test('the dialog shows the clicked user\'s bindings and offers only unbound roles', async () => {
    const m = await mountPage()

    call(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u2'))[0], 'onClick')
    await settle()

    expect(allById(m.app, 'principal-roles-body')).toHaveLength(1)
    const chips = allById(m.app, 'binding-chip')
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toContain('Member')
    // Member and Developer are bound; owner needs role.binding.owner, which this caller lacks.
    expect(m.app.find('option').map((option) => option.props.value)).toEqual([''])
    expect(allById(m.app, 'binding-no-roles')).toHaveLength(1)
  })
})

describe('AC-11: a refused user creation', () => {
  test('toasts the API error, keeps the dialog open and leaves the loaded user list alone', async () => {
    const err = new ApiError(409, 'A user with that email already exists')
    const post = jest.fn(async () => { throw err })
    const m = await mountPage({ api: { post } })

    call(byId(m.app, 'user-create'), 'onClick')
    await settle()
    const form = byId(m.app, 'create-user-form')
    const inputs = m.app.find('input', form)
    expect(inputs).toHaveLength(3)
    call(inputs[0], 'onInput', { target: { value: 'new@koda.test' } })
    call(inputs[1], 'onInput', { target: { value: 'New User' } })
    call(inputs[2], 'onInput', { target: { value: 'StrongPass1!' } })
    await settle()
    await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: () => undefined } as unknown as Event)
    await settle()

    expect(post).toHaveBeenCalledWith('/admin/users', { email: 'new@koda.test', name: 'New User', password: 'StrongPass1!' })
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(dialogOf(form).props.open).toBe(true)
    expect(m.api.get.mock.calls.filter(([path]) => path === '/admin/users')).toHaveLength(1)
    expect(allById(m.app, 'user-row')).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 1
// ─────────────────────────────────────────────────────────────────────────────

describe('F1: the role data loads when the permission keys arrive late', () => {
  test('a delayed /me/permissions still ends in chips, Edit roles and the two role requests', async () => {
    let release!: (value: unknown) => void
    // One shared promise: the page and the (always mounted) dialog each read /me/permissions.
    const gated = new Promise((resolve) => { release = resolve })
    const m = await mountPage({ permissionsGet: jest.fn(() => gated) })

    // The users list is loaded; the keys are not, so every gate is still closed.
    expect(allById(m.app, 'user-row')).toHaveLength(2)
    expect(allById(m.app, 'user-edit-roles')).toHaveLength(0)
    expect(allById(m.app, 'user-roles-cell')).toHaveLength(0)
    expect(m.api.get.mock.calls.filter(([path]) => path === '/roles' || path === '/role-bindings')).toHaveLength(0)

    release({ scope: 'global', projectSlug: null, keys: ['role.read', 'role.binding.global', 'user.read'] })
    await settle()

    expect(m.api.get).toHaveBeenCalledWith('/roles')
    expect(m.api.get).toHaveBeenCalledWith('/role-bindings', {
      query: { principalType: 'USER', scope: 'global', size: '200', current: '1' },
    })
    expect(allById(m.app, 'user-edit-roles')).toHaveLength(1)
    expect(allById(m.app, 'user-role-chip', rowFor(m.app, 'u2'))).toHaveLength(2)
  })
})

describe('F4: the gates read the real /me/permissions answer', () => {
  test('a failed /me/permissions closes both gates and asks for no role listing', async () => {
    const m = await mountPage({ permissionsGet: async () => { throw new Error('permissions down') } })

    expect(allById(m.app, 'user-row')).toHaveLength(2)
    expect(allById(m.app, 'user-edit-roles')).toHaveLength(0)
    expect(allById(m.app, 'user-roles-cell')).toHaveLength(0)
    expect(m.api.get.mock.calls.filter(([path]) => path === '/roles' || path === '/role-bindings')).toHaveLength(0)
  })
})

describe('F2: a created user shows the baseline binding the API granted', () => {
  test('creating a user reloads the bindings, so the new row carries Member and the dialog does not re-offer it', async () => {
    const users = [...USERS]
    const bindings = [...BINDINGS]
    const m = await mountPage({
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return usersPage(users)
          if (path === '/roles') return ROLES
          if (path === '/role-bindings') return bindingsPage(bindings)
          throw new Error(`unexpected GET ${path}`)
        }),
        post: jest.fn(async () => {
          const created = user('u9', { email: 'new@koda.test', name: 'New User' })
          users.push(created)
          // The API grants the baseline member binding as part of creating the account.
          bindings.push(binding('b9', { principalId: 'u9' }))
          return created
        }),
      },
    })

    call(byId(m.app, 'user-create'), 'onClick')
    await settle()
    const form = byId(m.app, 'create-user-form')
    const inputs = m.app.find('input', form)
    call(inputs[0], 'onInput', { target: { value: 'new@koda.test' } })
    call(inputs[1], 'onInput', { target: { value: 'New User' } })
    call(inputs[2], 'onInput', { target: { value: 'StrongPass1!' } })
    await settle()
    await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: () => undefined } as unknown as Event)
    await settle()

    const row = rowFor(m.app, 'u9')
    expect(row).toBeDefined()
    const chips = allById(m.app, 'user-role-chip', row)
    expect(chips).toHaveLength(1)
    expect(m.app.textOf(chips[0])).toBe('Member')
    expect(m.api.get.mock.calls.filter(([path]) => path === '/role-bindings')).toHaveLength(2)

    // The dialog for the new user does not offer the role it already holds.
    call(allById(m.app, 'user-edit-roles', row)[0], 'onClick')
    await settle()
    expect(m.app.find('option').map((option) => option.props.value)).not.toContain('member')
  })
})

describe('F5: a load error keeps the shared dialog honest', () => {
  test('with GET /roles rejecting, Edit roles shows the load error instead of raw-key chips', async () => {
    const err = new ApiError(50000, 'roles are down')
    const m = await mountPage({
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return usersPage()
          if (path === '/role-bindings') return bindingsPage()
          throw err
        }),
      },
    })

    call(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u2'))[0], 'onClick')
    await settle()

    expect(allById(m.app, 'binding-chip')).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'principal-roles-error'))).toBe(extractApiError(err))
  })

  test('a failed bindings refresh after a removal leaves no stale chip in the dialog', async () => {
    const err = new ApiError(50000, 'bindings are down')
    let failBindings = false
    const del = jest.fn(async () => { failBindings = true })
    const m = await mountPage({
      api: {
        delete: del,
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return usersPage()
          if (path === '/roles') return ROLES
          if (failBindings) throw err
          return bindingsPage()
        }),
      },
    })

    call(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u2'))[0], 'onClick')
    await settle()
    expect(allById(m.app, 'binding-chip')).toHaveLength(2)

    call(byId(m.app, 'binding-remove'), 'onClick')
    await settle()

    expect(del).toHaveBeenCalledWith('/role-bindings/b1')
    expect(allById(m.app, 'binding-chip')).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'principal-roles-error'))).toBe(extractApiError(err))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 2
// ─────────────────────────────────────────────────────────────────────────────

describe('F5 (round 2): a permission refresh does not reopen a failed snapshot', () => {
  test('the dialog keeps the load error and no chips while permissions are pending and after they return', async () => {
    const err = new ApiError(50000, 'roles are down')
    const m = await mountPage({
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return usersPage()
          if (path === '/role-bindings') return bindingsPage()
          throw err
        }),
      },
    })

    call(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u2'))[0], 'onClick')
    await settle()
    expect(m.app.textOf(byId(m.app, 'principal-roles-error'))).toBe(extractApiError(err))
    expect(allById(m.app, 'binding-chip')).toHaveLength(0)

    // A permission refresh puts the keys back into the pending state: the failed snapshot must stay
    // invalid rather than reopen with raw role keys and usable remove buttons.
    for (const handle of m.permissionData) handle.pending.value = true
    await settle()
    expect(allById(m.app, 'binding-chip')).toHaveLength(0)
    expect(allById(m.app, 'binding-remove')).toHaveLength(0)

    // And when the keys come back, the error is still there until a reload actually succeeds.
    for (const handle of m.permissionData) handle.pending.value = false
    await settle()
    expect(allById(m.app, 'binding-chip')).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'principal-roles-error'))).toBe(extractApiError(err))
  })

  test('a successful reload after the failure is what clears it', async () => {
    const err = new ApiError(50000, 'roles are down')
    let rolesFail = true
    const m = await mountPage({
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/admin/users') return usersPage()
          if (path === '/role-bindings') return bindingsPage()
          if (rolesFail) throw err
          return ROLES
        }),
      },
    })

    call(allById(m.app, 'user-edit-roles', rowFor(m.app, 'u2'))[0], 'onClick')
    await settle()
    expect(allById(m.app, 'binding-chip')).toHaveLength(0)

    rolesFail = false
    for (const handle of m.permissionData) handle.pending.value = true
    await settle()
    for (const handle of m.permissionData) handle.pending.value = false
    await settle()

    expect(allById(m.app, 'principal-roles-error')).toHaveLength(0)
    const chips = allById(m.app, 'binding-chip')
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toBe('Member')
  })
})
