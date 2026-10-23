/**
 * Permissions P1 US-012 (AC-1 … AC-6): the standalone agents page manages global role bindings
 * instead of the legacy `agent.roles` list, and every action is gated on its global key.
 *
 * The page is mounted for real: the real `useGlobalPermissions`, `useRoles` and `useRoleBindings`
 * run over a fake `$api`, and the real `PrincipalRolesDialog` and `CreateAgentDialog` are its
 * children. So a spec asserts the requests the API receives (including the query the binding listing
 * is asked with), the keys the mounted page actually resolved from `/me/permissions`, and the chips,
 * gates and toasts the admin sees — not a stub's placeholder.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { defineComponent, h } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile, type FakeNode, type Mounted } from '../helpers/mount-sfc'
import { enI18n, enLocale, uiStubs } from '../helpers/fleet-harness'
import { allById, byId, call, settle } from '../helpers/roles-dom'
import { fakeAsyncData } from '../helpers/permission-nav'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useGlobalPermissions } from '../../composables/usePermissions'
import { useRoles } from '../../composables/useRoles'
import { useRoleBindings } from '../../composables/useRoleBindings'
import type { Permissions } from '../../composables/usePermissions'
import type { Role } from '../../composables/useRoles'
import type { RoleBinding } from '../../composables/useRoleBindings'

const pagePath = webFile('pages', 'agents.vue')

const role = (over: Partial<Role>): Role => ({
  id: 'r0', key: 'member', name: 'Member', description: '', scope: 'GLOBAL',
  system: true, locked: false, permissions: [], expandedKeys: [], ...over,
})
const MEMBER = role({ id: 'r1', key: 'member', name: 'Member' })
const DEVELOPER = role({ id: 'r2', key: 'developer', name: 'Developer', scope: 'PROJECT' })
const REVIEWER = role({ id: 'r3', key: 'reviewer', name: 'Reviewer' })
const OWNER = role({ id: 'r4', key: 'owner', name: 'Owner', locked: true })
/**
 * The baseline role the API binds to a new agent (`MembershipService.bindBaseline` uses the `agent`
 * key for an AGENT principal). Kept out of the default listing so the AC-3 offer set stays exact.
 */
const AGENT_ROLE = role({ id: 'r5', key: 'agent', name: 'Agent' })
const ROLES = [MEMBER, DEVELOPER, REVIEWER, OWNER]

/**
 * Permissions P1 US-011: `GET /agents` answers no `roles` property — an agent's roles are its role
 * bindings, which is what the roles column renders. The fixture is the row the API sends today.
 */
const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${id.toUpperCase()}`,
  slug: `agent-${id}`,
  capabilities: [{ capability: 'code.write' }],
  status: 'ACTIVE',
  ...over,
})
const AGENTS = [agent('a1'), agent('a2')]

const binding = (id: string, over: Partial<RoleBinding> = {}): RoleBinding => ({
  id, principalType: 'AGENT', principalId: 'a1', roleId: 'r1', roleKey: 'member',
  projectId: null, grantedByType: 'USER', grantedById: 'u1', createdAt: '2026-10-01T00:00:00Z', ...over,
})
const BINDINGS = [binding('b1'), binding('b2', { roleId: 'r2', roleKey: 'developer' })]

interface FakeApi {
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  delete: jest.Mock
}

// A JSON response is a new object (and a new array) each time: a shared instance would make a ref
// see an unchanged value and skip the re-render.
const agents = () => AGENTS.map((row) => ({ ...row }))
const bindingsPage = (records: RoleBinding[] = BINDINGS) => ({
  records: [...records], total: records.length, current: 1, size: 200, hasNext: false, hasPrev: false,
})

function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/agents') return agents()
      if (path === '/roles') return [...ROLES]
      if (path === '/role-bindings') return bindingsPage()
      throw new Error(`unexpected GET ${path}`)
    }),
    post: jest.fn(async () => ({ apiKey: 'koda_key_123', ...agent('a9') })),
    patch: jest.fn(async () => agent('a1')),
    delete: jest.fn(async () => undefined),
    ...over,
  }
}

/** The create dialog's form fields need the real vee-validate bridge (the UI stubs are inert). */
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
  props: { modelValue: [String, Number] },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => h('input', {
      ...attrs,
      value: props.modelValue,
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    })
  },
})

/** A component this spec does not assert on: it renders nothing, so it cannot influence a result. */
const inert = (name: string) => defineComponent({ name, setup: () => () => null })

interface MountOptions {
  keys?: string[]
  api?: Partial<FakeApi>
  /** What `GET /me/permissions` answers, so a spec can hand the page a failed key read. */
  permissionsGet?: () => Promise<unknown>
}

interface Mount {
  app: Mounted
  api: FakeApi
  toast: { success: jest.Mock; error: jest.Mock }
  /** Every global permission set the real composable handed the page and its dialog. */
  resolved: Permissions['permissions'][]
}

async function mountPage(options: MountOptions = {}): Promise<Mount> {
  const api = fakeApi(options.api)
  const toast = { success: jest.fn(), error: jest.fn() }
  const keys = options.keys ?? []
  const permissionsGet = options.permissionsGet ?? (async () => ({ scope: 'global', projectSlug: null, keys }))
  const resolved: Permissions['permissions'][] = []
  const $api = {
    ...api,
    // Only `/me/permissions` is answered here; every other path reaches the recording fake with the
    // exact arguments the composable used.
    get: jest.fn(async (path: string, query?: unknown) => {
      if (path === '/me/permissions') return permissionsGet()
      return query === undefined ? api.get(path) : api.get(path, query)
    }),
  }
  const useApiStub = () => ({ $api })
  // Two ways in: the mounted SFC takes its auto-imports from `globals`, while the real composables
  // this spec imports through Jest (useGlobalPermissions and the ones it pulls in) resolve their
  // free `useApi` / `useAsyncData` from the global object.
  const host = globalThis as Record<string, unknown>
  host.useApi = useApiStub
  host.useAsyncData = fakeAsyncData
  const globals: Record<string, unknown> = {
    useI18n: () => enI18n(),
    useAppToast: () => toast,
    useApi: useApiStub,
    useAsyncData: fakeAsyncData,
    // The real composable, with its resolved set recorded: AC-3 has to show that the caller really
    // does hold role.binding.owner while the dialog still withholds the owner role from an agent.
    useGlobalPermissions: () => {
      const permissions = useGlobalPermissions()
      resolved.push(permissions.permissions)
      return permissions
    },
    useRoles,
    useRoleBindings,
  }
  const app = mountSfc(pagePath, {
    components: {
      ...uiStubs,
      FormField,
      Input,
      EditAgentCapabilitiesDialog: inert('StubEditAgentCapabilitiesDialog'),
      RotateKeyDialog: inert('StubRotateKeyDialog'),
      DeleteAgentDialog: inert('StubDeleteAgentDialog'),
    },
    globals,
  })
  await settle()
  return { app, api, toast, resolved }
}

const rowFor = (app: Mounted, id: string): FakeNode =>
  allById(app, 'agent-row').find((row) => row.props['data-agent'] === id) as FakeNode

/** The copy a chip shows, read from the real en.json tree so the assertion is i18n-driven. */
const allProjectsCopy = (name: string): string => {
  const template = (enLocale.admin as Record<string, Record<string, Record<string, string>>>).bindings.chip.allProjects
  return template.replace('{name}', name)
}
const noRolesCopy = (enLocale.agents as Record<string, string>).noRoles

/** The dialog a node sits in, found by walking up to the Dialog stub that owns it. */
function dialogOf(node: FakeNode): FakeNode {
  let current: FakeNode | null = node.parent
  while (current) {
    if (current.props['data-stub'] === 'dialog') return current
    current = current.parent
  }
  throw new Error('node is not inside a dialog')
}

const AGENT_GLOBAL_QUERY = { principalType: 'AGENT', scope: 'global', size: '200', current: '1' }
const ROLE_MANAGER_KEYS = ['role.read', 'role.binding.global']

const bindingListCalls = (api: FakeApi): number =>
  api.get.mock.calls.filter(([path]) => path === '/role-bindings').length

// The auto-imports are installed on both the mount globals and (for the Jest-imported composables)
// the global object; these hooks keep a leaked global from masking a missing one.
beforeEach(() => {
  const host = globalThis as Record<string, unknown>
  delete host.useApi
  delete host.useAsyncData
})

afterEach(() => {
  const host = globalThis as Record<string, unknown>
  delete host.useApi
  delete host.useAsyncData
})

describe('AC-1: the roles column comes from the global AGENT bindings', () => {
  test('one chip per binding, named by the joined role', async () => {
    const m = await mountPage({ keys: ROLE_MANAGER_KEYS })

    // The listing is asked for the agent principals that apply everywhere.
    expect(m.api.get).toHaveBeenCalledWith('/role-bindings', { query: AGENT_GLOBAL_QUERY })
    expect(m.api.get).toHaveBeenCalledWith('/roles')

    const chips = allById(m.app, 'agent-role-chip', rowFor(m.app, 'a1'))
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toBe('Member')
    // A PROJECT-scope role bound with no project applies everywhere.
    expect(m.app.textOf(chips[1])).toBe(allProjectsCopy('Developer'))
    expect(chips.map((chip) => chip.props['data-role'])).toEqual(['member', 'developer'])
  })

  test('AC-5: an agent the API answers without a roles property still shows its Developer chip', async () => {
    // Permissions P1 US-011: `roles` is gone from the response, so the column may only be the
    // binding join. The rows below carry the exact fields `GET /agents` sends today.
    const rows = [
      { id: 'a1', name: 'Agent A1', slug: 'agent-a1', capabilities: [{ capability: 'code.write' }], status: 'ACTIVE' },
    ]
    const m = await mountPage({
      keys: ROLE_MANAGER_KEYS,
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/agents') return rows.map((row) => ({ ...row }))
          if (path === '/roles') return [...ROLES]
          if (path === '/role-bindings') {
            return bindingsPage([binding('b1', { roleId: DEVELOPER.id, roleKey: DEVELOPER.key })])
          }
          throw new Error(`unexpected GET ${path}`)
        }),
      },
    })

    const row = rowFor(m.app, 'a1')
    expect(allById(m.app, 'agent-roles-cell', row)).toHaveLength(1)
    const chips = allById(m.app, 'agent-role-chip', row)
    expect(chips).toHaveLength(1)
    expect(chips[0]?.props['data-role']).toBe('developer')
    expect(m.app.textOf(chips[0] as FakeNode)).toBe(allProjectsCopy('Developer'))
  })

  test('an agent with no binding has the cell and the empty copy, not a chip', async () => {
    const m = await mountPage({ keys: ROLE_MANAGER_KEYS })

    const row = rowFor(m.app, 'a2')
    expect(allById(m.app, 'agent-roles-cell', row)).toHaveLength(1)
    expect(allById(m.app, 'agent-role-chip', row)).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'agent-roles-empty', row))).toBe(noRolesCopy)
  })

  test('a refused listing shows the load error in the column and no chips', async () => {
    const err = new ApiError(50000, 'bindings are down')
    const m = await mountPage({
      keys: ROLE_MANAGER_KEYS,
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/agents') return agents()
          if (path === '/roles') return [...ROLES]
          throw err
        }),
      },
    })

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'agent-role-chip')).toHaveLength(0)
    expect(m.app.textOf(byId(m.app, 'agent-roles-error', rowFor(m.app, 'a1')))).toBe(extractApiError(err))
  })
})

describe('AC-2: Edit roles opens the shared dialog on that agent', () => {
  test('the dialog carries the agent principal and posts the binding with projectId null', async () => {
    const m = await mountPage({ keys: ROLE_MANAGER_KEYS })

    call(byId(m.app, 'agent-edit-roles', rowFor(m.app, 'a1')), 'onClick')
    await settle()

    // Opened from the real page, on that agent: its own bindings and its own name in the title.
    const body = byId(m.app, 'principal-roles-body')
    expect(m.app.textOf(dialogOf(body))).toContain('Agent A1')
    const chips = allById(m.app, 'binding-chip', body)
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toContain('Member')

    call(byId(m.app, 'binding-role-select'), 'onChange', { target: { value: 'reviewer' } })
    await settle()
    call(byId(m.app, 'binding-add'), 'onClick')
    await settle()

    expect(m.api.post).toHaveBeenCalledTimes(1)
    expect(m.api.post).toHaveBeenCalledWith('/role-bindings', {
      principalType: 'AGENT', principalId: 'a1', roleKey: 'reviewer', projectId: null,
    })

    // `changed` reloads the page's binding state.
    expect(bindingListCalls(m.api)).toBe(2)
  })
})

describe('AC-3: owner is never offered for an agent', () => {
  test('even holding role.binding.owner, the agent dialog omits the owner role', async () => {
    const m = await mountPage({ keys: [...ROLE_MANAGER_KEYS, 'role.binding.owner'] })

    // The guard against a vacuous pass: the real composable did resolve the owner key.
    expect(m.resolved.some((set) => set.value.has('role.binding.owner'))).toBe(true)

    call(byId(m.app, 'agent-edit-roles', rowFor(m.app, 'a1')), 'onClick')
    await settle()

    const offered = m.app.find('option').map((option) => String(option.props.value))
    expect(offered).not.toContain('owner')
    // member and developer are already bound; reviewer is the only free role.
    expect(offered).toEqual(['', 'reviewer'])
  })
})

describe('AC-4: every action needs its own global key', () => {
  test('with no keys there is no create button and no row action at all', async () => {
    const m = await mountPage({ keys: [] })

    expect(allById(m.app, 'agent-row')).toHaveLength(2)
    expect(allById(m.app, 'agent-create')).toHaveLength(0)
    for (const id of [
      'agent-edit-roles', 'agent-edit-capabilities', 'agent-rotate-key', 'agent-delete',
      'agent-status-ACTIVE', 'agent-status-PAUSED', 'agent-status-OFFLINE',
    ]) {
      expect(allById(m.app, id)).toHaveLength(0)
    }
    // No role key means the roles column is not even asked for (it would be a 403).
    expect(m.api.get.mock.calls.filter(([path]) => path === '/roles' || path === '/role-bindings')).toHaveLength(0)
    expect(allById(m.app, 'agent-roles-cell')).toHaveLength(0)
  })

  test('agent.create renders the create button and nothing else', async () => {
    const m = await mountPage({ keys: ['agent.create'] })

    expect(allById(m.app, 'agent-create')).toHaveLength(1)
    expect(allById(m.app, 'agent-edit-roles')).toHaveLength(0)
    expect(allById(m.app, 'agent-rotate-key')).toHaveLength(0)
    expect(allById(m.app, 'agent-delete')).toHaveLength(0)
    expect(allById(m.app, 'agent-status-ACTIVE')).toHaveLength(0)
  })

  test.each([
    ['agent.capabilities.update', 'agent-edit-capabilities', ['agent-delete', 'agent-rotate-key']],
    ['agent.key.rotate', 'agent-rotate-key', ['agent-delete', 'agent-edit-capabilities']],
    ['agent.delete', 'agent-delete', ['agent-rotate-key', 'agent-edit-capabilities']],
    ['agent.update', 'agent-status-ACTIVE', ['agent-delete', 'agent-rotate-key']],
  ])('%s alone renders %s only', async (key, testId, withheld) => {
    const m = await mountPage({ keys: [key] })

    expect(allById(m.app, testId)).toHaveLength(2)
    expect(allById(m.app, 'agent-create')).toHaveLength(0)
    expect(allById(m.app, 'agent-edit-roles')).toHaveLength(0)
    for (const id of withheld) expect(allById(m.app, id)).toHaveLength(0)
  })

  test('Edit roles needs role.read and role.binding.global together', async () => {
    const both = await mountPage({ keys: ROLE_MANAGER_KEYS })
    expect(allById(both.app, 'agent-edit-roles')).toHaveLength(2)

    const onlyBinding = await mountPage({ keys: ['role.binding.global'] })
    expect(allById(onlyBinding.app, 'agent-edit-roles')).toHaveLength(0)
    expect(allById(onlyBinding.app, 'agent-roles-cell')).toHaveLength(0)
    // No role.read means the roles listing is never even asked for (it would be a 403).
    expect(onlyBinding.api.get.mock.calls.filter(([path]) => path === '/roles')).toHaveLength(0)

    const onlyRead = await mountPage({ keys: ['role.read'] })
    expect(allById(onlyRead.app, 'agent-edit-roles')).toHaveLength(0)
    expect(allById(onlyRead.app, 'agent-roles-cell')).toHaveLength(0)
  })

  test('a failed /me/permissions closes every gate', async () => {
    const m = await mountPage({ permissionsGet: async () => { throw new Error('permissions down') } })

    expect(allById(m.app, 'agent-row')).toHaveLength(2)
    for (const id of [
      'agent-create', 'agent-edit-roles', 'agent-edit-capabilities', 'agent-rotate-key',
      'agent-delete', 'agent-status-PAUSED',
    ]) {
      expect(allById(m.app, id)).toHaveLength(0)
    }
  })

  test('role.binding.global + role.read renders every row control when the caller holds the rest', async () => {
    const m = await mountPage({
      keys: ['agent.create', 'agent.update', 'agent.capabilities.update', 'agent.key.rotate', 'agent.delete', ...ROLE_MANAGER_KEYS],
    })

    for (const id of [
      'agent-create', 'agent-edit-roles', 'agent-edit-capabilities', 'agent-rotate-key', 'agent-delete',
      'agent-status-ACTIVE', 'agent-status-PAUSED', 'agent-status-OFFLINE',
    ]) {
      expect(allById(m.app, id).length).toBeGreaterThan(0)
    }

    // The trigger names the menu, not one of its items: it holds edit/rotate/delete as well as the
    // three statuses, and it is the only label a caller without agent.update would see.
    const menuLabel = (enLocale.agents as Record<string, Record<string, string>>).actions.menu
    expect(m.app.textOf(allById(m.app, 'agent-actions')[0])).toBe(menuLabel)
  })
})

describe('AC-5: the create dialog is role-less', () => {
  test('submitting a name and slug posts /agents with no roles property', async () => {
    const m = await mountPage({ keys: ['agent.create'] })

    const form = byId(m.app, 'create-agent-form')
    const inputs = m.app.find('input', form)
    expect(inputs).toHaveLength(4)
    call(inputs[0], 'onInput', { target: { value: 'New Bot' } })
    call(inputs[1], 'onInput', { target: { value: 'new-bot' } })
    await settle()

    await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: () => undefined } as unknown as Event)
    await settle()

    expect(m.api.post).toHaveBeenCalledTimes(1)
    const [path, body] = m.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/agents')
    expect(body).not.toHaveProperty('roles')
    expect(body).toEqual({ name: 'New Bot', slug: 'new-bot', capabilities: [], maxConcurrentTickets: 3 })
  })

  test('the form renders no roles field at all', async () => {
    const m = await mountPage({ keys: ['agent.create'] })

    const form = byId(m.app, 'create-agent-form')
    // The legacy field was a list of raw checkboxes labelled with the AGENT_ROLES values.
    expect(m.app.find('input', form).filter((input) => input.props.type === 'checkbox')).toHaveLength(0)
    expect(m.app.textOf(form)).not.toContain(enI18n().t('agents.form.roles'))
  })
})

describe('AC-6: a refused binding write', () => {
  test('toasts the API error, keeps the chips and leaves the dialog open', async () => {
    const err = new ApiError(40003, 'You cannot grant a role you do not hold')
    const m = await mountPage({
      keys: ROLE_MANAGER_KEYS,
      api: { post: jest.fn(async () => { throw err }) },
    })

    call(byId(m.app, 'agent-edit-roles', rowFor(m.app, 'a1')), 'onClick')
    await settle()
    const body = byId(m.app, 'principal-roles-body')

    call(byId(m.app, 'binding-role-select'), 'onChange', { target: { value: 'reviewer' } })
    await settle()
    call(byId(m.app, 'binding-add'), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    const chips = allById(m.app, 'binding-chip', body)
    expect(chips).toHaveLength(2)
    expect(m.app.textOf(chips[0])).toContain('Member')
    expect(dialogOf(body).props.open).toBe(true)
    // The page's chips are untouched too: the write never succeeded, so nothing was reloaded.
    expect(bindingListCalls(m.api)).toBe(1)
    expect(allById(m.app, 'agent-role-chip', rowFor(m.app, 'a1'))).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 1
// ─────────────────────────────────────────────────────────────────────────────

describe('F1: a created agent shows the baseline binding the API granted', () => {
  test('creating reloads the bindings, so the new row carries the agent role', async () => {
    const rows = [...AGENTS]
    const bindings = [...BINDINGS]
    const m = await mountPage({
      keys: [...ROLE_MANAGER_KEYS, 'agent.create'],
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/agents') return rows.map((row) => ({ ...row }))
          if (path === '/roles') return [...ROLES, AGENT_ROLE]
          if (path === '/role-bindings') return bindingsPage(bindings)
          throw new Error(`unexpected GET ${path}`)
        }),
        post: jest.fn(async () => {
          const created = agent('a9', { name: 'New Bot', slug: 'new-bot' })
          rows.push(created)
          // AgentsService.generateApiKey binds the baseline 'agent' role inside the create
          // transaction, so the new principal already holds a global binding.
          bindings.push(binding('b9', { principalId: 'a9', roleId: AGENT_ROLE.id, roleKey: AGENT_ROLE.key }))
          return { apiKey: 'koda_key_123', ...created }
        }),
      },
    })

    const form = byId(m.app, 'create-agent-form')
    const inputs = m.app.find('input', form)
    call(inputs[0], 'onInput', { target: { value: 'New Bot' } })
    call(inputs[1], 'onInput', { target: { value: 'new-bot' } })
    await settle()
    await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: () => undefined } as unknown as Event)
    await settle()

    // The dialog reveals the key; dismissing it is what emits `created` and puts the row on the page.
    const done = m.app.find('[data-stub="button"]')
      .find((button) => m.app.textOf(button) === enI18n().t('common.done'))
    expect(done).toBeDefined()
    call(done as FakeNode, 'onClick')
    await settle()

    // The binding listing is re-read after the create, so the new row is joined like any other.
    expect(bindingListCalls(m.api)).toBe(2)
    const row = rowFor(m.app, 'a9')
    const chips = allById(m.app, 'agent-role-chip', row)
    expect(chips).toHaveLength(1)
    expect(m.app.textOf(chips[0])).toBe(AGENT_ROLE.name)

    // And the dialog for the new agent does not offer the role it already holds.
    call(byId(m.app, 'agent-edit-roles', row), 'onClick')
    await settle()
    expect(m.app.find('option').map((option) => String(option.props.value))).not.toContain(AGENT_ROLE.key)
  })
})

describe('F2: every gated agent action shows the API refusal', () => {
  test('a refused create toasts the extracted API error', async () => {
    const err = new ApiError(40003, 'You may not create agents')
    const m = await mountPage({ keys: ['agent.create'], api: { post: jest.fn(async () => { throw err }) } })

    const form = byId(m.app, 'create-agent-form')
    const inputs = m.app.find('input', form)
    call(inputs[0], 'onInput', { target: { value: 'New Bot' } })
    call(inputs[1], 'onInput', { target: { value: 'new-bot' } })
    await settle()
    await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: () => undefined } as unknown as Event)
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    // The form stays up so the admin can retry, and the key is never revealed.
    expect(allById(m.app, 'create-agent-form')).toHaveLength(1)
  })

  test('a refused status change toasts the extracted API error', async () => {
    const err = new ApiError(40003, 'You may not change this agent')
    const m = await mountPage({ keys: ['agent.update'], api: { patch: jest.fn(async () => { throw err }) } })

    call(byId(m.app, 'agent-status-PAUSED', rowFor(m.app, 'a1')), 'onClick')
    await settle()

    expect(m.api.patch).toHaveBeenCalledWith('/agents/agent-a1', { status: 'PAUSED' })
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
  })
})

describe('F3: overlapping reloads publish only the latest snapshot', () => {
  /** A deferred `$api.get` queue, so a spec can settle two reloads in the order it chooses. */
  function deferredGet() {
    const queue: Array<{
      promise: Promise<unknown>
      resolve: (value: unknown) => void
      reject: (err: unknown) => void
    }> = []
    const deferred = () => {
      let resolve!: (value: unknown) => void
      let reject!: (err: unknown) => void
      const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
      const entry = { promise, resolve, reject }
      queue.push(entry)
      return entry
    }
    return { queue, deferred }
  }

  /**
   * Reads the page's listing requests through a `$api.get` that answers the first pass immediately
   * and every later pass from the deferred queue, one pair per reload (roles, then bindings).
   */
  async function mountWithQueuedReloads() {
    const roles = deferredGet()
    const bindings = deferredGet()
    let pass = 0
    const m = await mountPage({
      keys: ROLE_MANAGER_KEYS,
      api: {
        get: jest.fn(async (path: string) => {
          if (path === '/agents') return agents()
          if (path === '/roles') {
            pass += 1
            return pass === 1 ? [...ROLES] : roles.deferred().promise
          }
          if (path === '/role-bindings') return pass === 1 ? bindingsPage() : bindings.deferred().promise
          throw new Error(`unexpected GET ${path}`)
        }),
      },
    })
    expect(pass).toBe(1)
    return { m, roles, bindings }
  }

  /** Two successive binding writes: each success emits `changed`, which reloads the listings. */
  async function addReviewer(m: Mount): Promise<void> {
    call(byId(m.app, 'binding-role-select'), 'onChange', { target: { value: 'reviewer' } })
    await settle()
    call(byId(m.app, 'binding-add'), 'onClick')
    await settle()
  }

  test('an older rejection cannot re-block a newer successful snapshot', async () => {
    const { m, roles, bindings } = await mountWithQueuedReloads()
    call(byId(m.app, 'agent-edit-roles', rowFor(m.app, 'a1')), 'onClick')
    await settle()
    expect(allById(m.app, 'binding-chip')).toHaveLength(2)

    await addReviewer(m) // reload A: both listings pending
    await addReviewer(m) // reload B: both listings pending
    expect(roles.queue).toHaveLength(2)
    expect(bindings.queue).toHaveLength(2)

    // The newer run lands first, with the reviewer binding the writes added.
    bindings.queue[1].resolve(bindingsPage([...BINDINGS, binding('b3', { roleId: REVIEWER.id, roleKey: 'reviewer' })]))
    roles.queue[1].resolve([...ROLES])
    await settle()
    expect(allById(m.app, 'agent-role-chip', rowFor(m.app, 'a1'))).toHaveLength(3)

    // Then the older run is refused. It is stale, so it neither re-blocks the column nor the dialog.
    roles.queue[0].reject(new ApiError(50000, 'the older roles read failed'))
    bindings.queue[0].reject(new ApiError(50000, 'the older bindings read failed'))
    await settle()

    expect(allById(m.app, 'agent-roles-error')).toHaveLength(0)
    expect(allById(m.app, 'agent-role-chip', rowFor(m.app, 'a1'))).toHaveLength(3)
    expect(allById(m.app, 'binding-chip')).toHaveLength(3)
    expect(byId(m.app, 'binding-role-select').props.disabled).toBe(false)
  })

  test('an older success cannot overwrite the newer snapshot', async () => {
    const { m, roles, bindings } = await mountWithQueuedReloads()
    call(byId(m.app, 'agent-edit-roles', rowFor(m.app, 'a1')), 'onClick')
    await settle()

    await addReviewer(m) // reload A
    await addReviewer(m) // reload B

    // B lands with three chips, then A lands with the two-record listing it read earlier.
    bindings.queue[1].resolve(bindingsPage([...BINDINGS, binding('b3', { roleId: REVIEWER.id, roleKey: 'reviewer' })]))
    roles.queue[1].resolve([...ROLES])
    await settle()
    bindings.queue[0].resolve(bindingsPage(BINDINGS))
    roles.queue[0].resolve([...ROLES])
    await settle()

    expect(allById(m.app, 'agent-role-chip', rowFor(m.app, 'a1'))).toHaveLength(3)
    expect(allById(m.app, 'binding-chip')).toHaveLength(3)
    expect(allById(m.app, 'agent-roles-error')).toHaveLength(0)
  })
})

