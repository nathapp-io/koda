/**
 * Permissions P1 US-011 (AC-2, AC-3, AC-4, AC-11 list half, AC-12): the Admin -> Users page manages
 * global role bindings instead of a MEMBER/ADMIN enum.
 *
 * The page is mounted for real: the real `useAdminUsers`, `useRoles` and `useRoleBindings` run over a
 * fake `$api`, and the real `PrincipalRolesDialog` and `CreateUserDialog` are its children. So a spec
 * asserts the requests the API receives and the chips, errors and gates the admin sees.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { computed, defineComponent, h, ref } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, loadSfc, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { allById, byId, call, settle } from '../helpers/roles-dom'
import { permissionSet } from '../../lib/permissions'
import { ApiError, extractApiError } from '../../composables/useApi'
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

function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/admin/users') return { records: USERS, total: USERS.length, current: 1, size: 20, hasNext: false, hasPrev: false }
      if (path === '/roles') return ROLES
      if (path === '/role-bindings') return { records: BINDINGS, total: BINDINGS.length, current: 1, size: 200, hasNext: false, hasPrev: false }
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
}

interface MountOptions {
  keys?: string[]
  api?: Partial<FakeApi>
  meId?: string
}

async function mountPage(options: MountOptions = {}): Promise<Mount> {
  const api = fakeApi(options.api)
  const toast = { success: jest.fn(), error: jest.fn() }
  const held = permissionSet(options.keys ?? ['role.read', 'role.binding.global', 'user.read'])
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const globals: Record<string, unknown> = {
    useI18n: () => enI18n(),
    useAppToast: () => toast,
    useAuth: () => ({ user: ref({ id: options.meId ?? 'u1' }) }),
    useGlobalPermissions: () => ({ permissions: computed(() => held) }),
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
  return { app, api, toast }
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

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

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
