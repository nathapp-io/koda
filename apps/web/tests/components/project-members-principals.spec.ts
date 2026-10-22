/**
 * Permissions P1 US-013 (AC-1 .. AC-13): the rewritten project members panel.
 *
 * The real `.vue` file is compiled and rendered by the mount-sfc harness and the real
 * `useProjectMembers`, `useProjectRoles`, `useRoleBindings` and `useProjectPermissions` are injected
 * through Nuxt's auto-imports, so a spec asserts the HTTP calls the API receives and the keys the
 * panel actually resolved from `/me/permissions` — never a copy of the panel's rules.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile, type FakeNode, type Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { allById, byId, call, settle, typeInto } from '../helpers/roles-dom'
import { fakeAsyncData } from '../helpers/permission-nav'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useProjectMembers } from '../../composables/useProjectMembers'
import { useProjectRoles } from '../../composables/useProjectRoles'
import { useRoleBindings } from '../../composables/useRoleBindings'
import { useProjectPermissions } from '../../composables/usePermissions'

const panelFile = webFile('components', 'ProjectMembersPanel.vue')

const ROLES = [
  { id: 'r1', key: 'project-admin', name: 'Project Admin', description: '', system: true },
  { id: 'r2', key: 'developer', name: 'Developer', description: '', system: true },
  { id: 'r3', key: 'triager', name: 'Triager', description: '', system: false },
  { id: 'r4', key: 'reviewer', name: 'Reviewer', description: '', system: false },
  { id: 'r5', key: 'verifier', name: 'Verifier', description: '', system: false },
]

const AGENTS = [
  { id: 'a1', slug: 'listed-bot', name: 'Listed Bot', status: 'ONLINE' },
  { id: 'a2', slug: 'free-bot', name: 'Free Bot', status: 'ONLINE' },
]

interface RowFixture {
  principalType: 'USER' | 'AGENT'
  principalId: string
  userId: string | null
  email: string | null
  agentSlug: string | null
  name: string | null
  disabled: boolean
  joinedAt: string
  bindings: Array<{ id: string | null; roleKey: string; roleName: string }>
}

const userRow = (over: Partial<RowFixture> = {}): RowFixture => ({
  principalType: 'USER',
  principalId: 'u1',
  userId: 'u1',
  email: 'u1@example.test',
  agentSlug: null,
  name: 'User One',
  disabled: false,
  joinedAt: '2026-01-01T00:00:00Z',
  bindings: [{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }],
  ...over,
})

const agentRow = (over: Partial<RowFixture> = {}): RowFixture => ({
  principalType: 'AGENT',
  principalId: 'a1',
  userId: null,
  email: null,
  agentSlug: 'listed-bot',
  name: 'Listed Bot',
  disabled: false,
  joinedAt: '2026-02-01T00:00:00Z',
  bindings: [{ id: null, roleKey: 'viewer', roleName: 'Viewer' }],
  ...over,
})

const pageOf = (records: RowFixture[]) => ({
  records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false,
})

const binding = (id: string, body: Record<string, unknown>) => ({
  id,
  principalType: String(body.principalType),
  principalId: String(body.principalId),
  roleId: 'r4',
  roleKey: String(body.roleKey),
  projectId: (body.projectId as string | null) ?? null,
  grantedByType: 'USER',
  grantedById: 'me',
  createdAt: '2026-10-01T00:00:00Z',
})

interface MountOptions {
  /** The caller's project key set, as `/me/permissions?project=web` answers it. */
  keys?: readonly string[]
  rows?: RowFixture[]
  agents?: Array<{ id: string; slug: string; name: string; status?: string }>
  /** The signed-in user's id, so a spec can identify "my own row". */
  me?: string
  /** Forced outcomes for the write routes. */
  post?: jest.Mock
  delete?: jest.Mock
  /**
   * Held open to keep `GET /me/permissions` pending while the listings resolve — the client-navigation
   * order, where the project keys arrive after the members and roles pages.
   */
  permissionsGate?: Promise<void>
  /**
   * A paginated members listing: `pages[n]` answers `?current=n+1`. Used by the "Load more" and reload
   * specs; when absent the single-page `rows` fixture answers every request.
   */
  pages?: Array<{ rows: RowFixture[]; hasNext: boolean; total?: number }>
}

interface Mount {
  app: Mounted
  get: jest.Mock
  post: jest.Mock
  del: jest.Mock
  toast: { success: jest.Mock; error: jest.Mock }
  /** The server-side rows the fake `GET /projects/web/members` answers with. */
  rows: RowFixture[]
  /** Every members-page GET, in order, with the query it carried. */
  memberCalls: Array<{ path: string; query?: Record<string, string> }>
}

async function mountPanel(options: MountOptions = {}): Promise<Mount> {
  const keys = options.keys ?? ['member.add', 'role.binding.manage']
  const rows = [...(options.rows ?? [userRow()])]
  const pages = options.pages
  const agents = options.agents ?? AGENTS
  const memberCalls: Array<{ path: string; query?: Record<string, string> }> = []

  const get = jest.fn(async (path: string, request?: { query?: Record<string, string> }) => {
    if (path === '/me/permissions') {
      if (options.permissionsGate) await options.permissionsGate
      return { scope: 'project', projectSlug: 'web', keys: [...keys] }
    }
    if (path === '/projects/web/members') {
      memberCalls.push({ path, query: request?.query })
      if (!pages) return pageOf(rows)
      const pageNumber = Number(request?.query?.current ?? '1')
      const page = pages[pageNumber - 1] ?? { rows: [], hasNext: false }
      return {
        records: page.rows,
        total: page.total ?? pages.reduce((sum, entry) => sum + entry.rows.length, 0),
        current: pageNumber,
        size: 20,
        hasNext: page.hasNext,
        hasPrev: pageNumber > 1,
      }
    }
    if (path === '/projects/web/roles') return ROLES
    if (path === '/agents') return agents
    throw new Error(`unexpected GET ${path}`)
  })

  const post = options.post ?? jest.fn(async (path: string, body: Record<string, unknown>) => {
    if (path === '/projects/web/members') {
      return userRow({
        principalId: 'u9', userId: 'u9', email: String(body.email), name: null,
        bindings: [{ id: 'b9', roleKey: String(body.roleKey), roleName: 'Triager' }],
      })
    }
    if (path === '/role-bindings') return binding('b7', body)
    throw new Error(`unexpected POST ${path}`)
  })
  const del = options.delete ?? jest.fn(async () => undefined)
  const toast = { success: jest.fn(), error: jest.fn() }

  const host = globalThis as Record<string, unknown>
  host.useAsyncData = fakeAsyncData
  host.useApi = () => ({ $api: { get, post, delete: del } })
  ;(globalThis as Record<string, unknown>).window = { confirm: () => true }

  const app = mountSfc(panelFile, {
    props: { slug: 'web', projectId: 'p1' },
    components: uiStubs,
    globals: {
      useApi: () => ({ $api: { get, post, delete: del } }),
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useProjectPermissions,
      useProjectMembers,
      useProjectRoles,
      useRoleBindings,
      useAuth: () => ({ user: ref({ id: options.me ?? 'me' }) }),
    },
  })
  await settle()
  return { app, get, post, del, toast, rows, memberCalls }
}

const rows = (app: Mounted): FakeNode[] => allById(app, 'member-row')

/** The one row whose name cell reads `name` — how a spec picks a row out of the list. */
function rowOf(app: Mounted, name: string): FakeNode {
  const found = rows(app).find((row) => app.textOf(byId(app, 'member-name', row)) === name)
  expect(found).toBeDefined()
  return found as FakeNode
}

function submitForm(app: Mounted, testId: string): void {
  call(byId(app, testId), 'onSubmit', { preventDefault: () => undefined, target: {} })
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

describe('AC-1: the panel loads both listings and renders one row per record', () => {
  test('it asks for every principal kind and the project roles', async () => {
    const m = await mountPanel()

    expect(m.get).toHaveBeenCalledWith('/projects/web/members', { query: { principals: 'all' } })
    expect(m.get).toHaveBeenCalledWith('/projects/web/roles')
    m.app.unmount()
  })

  test('a user row shows its name, an agent row its name, an agent badge and the slug', async () => {
    const m = await mountPanel({
      rows: [
        userRow(),
        userRow({ principalId: 'u2', userId: 'u2', email: 'nameless@example.test', name: null }),
        agentRow(),
      ],
    })

    expect(rows(m.app)).toHaveLength(3)
    expect(m.app.textOf(byId(m.app, 'member-name', rowOf(m.app, 'User One')))).toBe('User One')
    // No name: the email is the row's name.
    expect(m.app.textOf(byId(m.app, 'member-name', rowOf(m.app, 'nameless@example.test')))).toBe('nameless@example.test')

    const agent = rowOf(m.app, 'Listed Bot')
    expect(allById(m.app, 'member-agent-badge', agent)).toHaveLength(1)
    expect(m.app.textOf(byId(m.app, 'member-agent-slug', agent))).toBe('listed-bot')
    // The user rows carry no agent badge.
    expect(allById(m.app, 'member-agent-badge', rowOf(m.app, 'User One'))).toHaveLength(0)
    m.app.unmount()
  })
})

describe('AC-2: one chip per binding, legacy chips are not removable', () => {
  test('each binding renders its roleName, and a null-id chip has no remove button', async () => {
    const m = await mountPanel({
      rows: [
        userRow({
          bindings: [
            { id: 'b1', roleKey: 'developer', roleName: 'Developer' },
            { id: 'b2', roleKey: 'verifier', roleName: 'Verifier' },
            { id: null, roleKey: 'viewer', roleName: 'Viewer' },
          ],
        }),
      ],
    })

    const row = rowOf(m.app, 'User One')
    const chips = allById(m.app, 'member-chip', row)
    expect(chips.map((chip) => m.app.textOf(chip))).toEqual(['Developer', 'Verifier', 'Viewer'])

    // One remove control per real binding (b1, b2) and none for the legacy chip.
    expect(allById(m.app, 'member-chip-remove', row)).toHaveLength(2)
    const legacy = chips[2]
    if (!legacy) throw new Error('legacy chip not rendered')
    expect(allById(m.app, 'member-chip-remove', legacy)).toHaveLength(0)
    m.app.unmount()
  })

  test('a row with no bindings renders no chip at all', async () => {
    const m = await mountPanel({ rows: [userRow({ bindings: [] })] })

    expect(allById(m.app, 'member-chip', rowOf(m.app, 'User One'))).toHaveLength(0)
    m.app.unmount()
  })
})

describe('AC-3: adding a user by email and role key', () => {
  test('submitting the form posts the role key and appends the returned member', async () => {
    const m = await mountPanel()

    typeInto(byId(m.app, 'member-add-email'), 'new@example.test')
    await settle()
    call(byId(m.app, 'member-add-role'), 'onChange', { target: { value: 'triager' } })
    await settle()
    submitForm(m.app, 'member-add-form')
    await settle()

    expect(m.post).toHaveBeenCalledWith('/projects/web/members', { email: 'new@example.test', roleKey: 'triager' })
    expect(rows(m.app)).toHaveLength(2)
    const added = rowOf(m.app, 'new@example.test')
    expect(m.app.textOf(byId(m.app, 'member-chip', added))).toBe('Triager')
    m.app.unmount()
  })

  test('the role select offers the project roles from GET /projects/:slug/roles', async () => {
    const m = await mountPanel()

    // The empty option is the "choose a role" placeholder: no role is preselected, so a member is
    // never granted a role the caller did not pick.
    const options = m.app.find('option', byId(m.app, 'member-add-role')).map((option) => String(option.props.value))
    expect(options).toEqual(['', ...ROLES.map((role) => role.key)])
    m.app.unmount()
  })
})

describe('AC-4: adding an agent that is not listed yet', () => {
  test('agents already in the list are not offered, and the binding is created then the list reloaded', async () => {
    const m = await mountPanel({ rows: [userRow(), agentRow()] })

    const offered = m.app.find('option', byId(m.app, 'agent-add-select')).map((option) => String(option.props.value))
    expect(offered).toContain('a2')
    expect(offered).not.toContain('a1')

    const reloadsBefore = m.memberCalls.length
    call(byId(m.app, 'agent-add-select'), 'onChange', { target: { value: 'a2' } })
    await settle()
    call(byId(m.app, 'agent-add-role'), 'onChange', { target: { value: 'reviewer' } })
    await settle()
    submitForm(m.app, 'agent-add-form')
    await settle()

    expect(m.post).toHaveBeenCalledWith('/role-bindings', {
      principalType: 'AGENT', principalId: 'a2', roleKey: 'reviewer', projectId: 'p1',
    })
    expect(m.memberCalls.length).toBeGreaterThan(reloadsBefore)
    m.app.unmount()
  })

  // Fix round 1 / F1: the project keys can resolve AFTER the members and roles pages (a client
  // navigation, or a slow /me/permissions). The picker then appears later, so /agents has to be
  // fetched when the gate opens rather than once at mount.
  test('the picker still loads when the project keys arrive after both listings', async () => {
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const m = await mountPanel({ rows: [userRow(), agentRow()], permissionsGate: gate })

    // The listings resolved while the keys were still pending: no picker, and no wasted request.
    expect(m.memberCalls).toHaveLength(1)
    expect(allById(m.app, 'agent-add-form')).toHaveLength(0)
    expect(m.get.mock.calls.map((args) => args[0])).not.toContain('/agents')

    openGate()
    await settle()

    expect(allById(m.app, 'agent-add-form')).toHaveLength(1)
    expect(m.get.mock.calls.filter((args) => args[0] === '/agents')).toHaveLength(1)
    const offered = m.app.find('option', byId(m.app, 'agent-add-select')).map((option) => String(option.props.value))
    expect(offered).toContain('a2')
    expect(offered).not.toContain('a1')

    // Deduplicated: a later re-render must not fire a second /agents request.
    await settle()
    expect(m.get.mock.calls.filter((args) => args[0] === '/agents')).toHaveLength(1)
    m.app.unmount()
  })

  test('an agent can be granted after the delayed permission answer (the picker is usable)', async () => {
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const m = await mountPanel({ rows: [userRow(), agentRow()], permissionsGate: gate })
    openGate()
    await settle()

    // A usable picker, not just a visible form: the candidates are there to choose from.
    const offered = m.app.find('option', byId(m.app, 'agent-add-select')).map((option) => String(option.props.value))
    expect(offered).toContain('a2')

    call(byId(m.app, 'agent-add-select'), 'onChange', { target: { value: 'a2' } })
    await settle()
    call(byId(m.app, 'agent-add-role'), 'onChange', { target: { value: 'reviewer' } })
    await settle()
    submitForm(m.app, 'agent-add-form')
    await settle()

    expect(m.post).toHaveBeenCalledWith('/role-bindings', {
      principalType: 'AGENT', principalId: 'a2', roleKey: 'reviewer', projectId: 'p1',
    })
    m.app.unmount()
  })
})

describe('AC-5: adding and removing a role chip on a row', () => {
  test('adding verifier posts the USER binding for that row', async () => {
    const m = await mountPanel()
    const row = rowOf(m.app, 'User One')

    call(byId(m.app, 'member-chip-add-role', row), 'onChange', { target: { value: 'verifier' } })
    await settle()
    call(byId(m.app, 'member-chip-add', row), 'onClick')
    await settle()

    expect(m.post).toHaveBeenCalledWith('/role-bindings', {
      principalType: 'USER', principalId: 'u1', roleKey: 'verifier', projectId: 'p1',
    })
    m.app.unmount()
  })

  test('the row select does not offer a role the row already holds', async () => {
    const m = await mountPanel()
    const row = rowOf(m.app, 'User One')

    const offered = m.app.find('option', byId(m.app, 'member-chip-add-role', row)).map((option) => String(option.props.value))
    expect(offered).toContain('verifier')
    expect(offered).not.toContain('developer')
    m.app.unmount()
  })

  test('removing a chip deletes its binding and drops the chip', async () => {
    const m = await mountPanel()
    const row = rowOf(m.app, 'User One')

    call(byId(m.app, 'member-chip-remove', row), 'onClick')
    await settle()

    expect(m.del).toHaveBeenCalledWith('/role-bindings/b1')
    expect(allById(m.app, 'member-chip', rowOf(m.app, 'User One'))).toHaveLength(0)
    m.app.unmount()
  })
})

describe('AC-6: removing a row deletes each real binding and reloads', () => {
  test('null-id bindings are skipped and no other delete is sent', async () => {
    const m = await mountPanel({
      rows: [
        userRow({
          bindings: [
            { id: 'b1', roleKey: 'developer', roleName: 'Developer' },
            { id: 'b2', roleKey: 'verifier', roleName: 'Verifier' },
            { id: null, roleKey: 'viewer', roleName: 'Viewer' },
          ],
        }),
      ],
    })
    const reloadsBefore = m.memberCalls.length

    call(byId(m.app, 'member-row-remove', rowOf(m.app, 'User One')), 'onClick')
    await settle()

    expect(m.del.mock.calls.map((args) => args[0])).toEqual(['/role-bindings/b1', '/role-bindings/b2'])
    expect(m.memberCalls.length).toBeGreaterThan(reloadsBefore)
    m.app.unmount()
  })

  // Fix round 1 / F2: the reload after a removal used to replace the accumulated list with the last
  // page alone, so removing the only row of the last page emptied the panel while earlier members
  // still existed.
  test('removing the only row of the last loaded page keeps the earlier members listed', async () => {
    const pages = [
      {
        rows: [
          userRow(),
          userRow({ principalId: 'u2', userId: 'u2', email: 'u2@example.test', name: 'User Two', bindings: [{ id: 'b2', roleKey: 'developer', roleName: 'Developer' }] }),
        ],
        hasNext: true,
        total: 3,
      },
      {
        rows: [userRow({ principalId: 'u3', userId: 'u3', email: 'u3@example.test', name: 'User Three', bindings: [{ id: 'b3', roleKey: 'developer', roleName: 'Developer' }] })],
        hasNext: false,
        total: 3,
      },
    ]
    const m = await mountPanel({ pages })
    call(byId(m.app, 'member-load-more'), 'onClick')
    await settle()
    expect(rows(m.app)).toHaveLength(3)

    // The API now holds two members in one page: `b3` was the last row of the last page.
    const firstPage = pages[0]
    if (!firstPage) throw new Error('page 1 fixture missing')
    pages[0] = { rows: firstPage.rows, hasNext: false, total: 2 }
    pages[1] = { rows: [], hasNext: false, total: 2 }

    call(byId(m.app, 'member-row-remove', rowOf(m.app, 'User Three')), 'onClick')
    await settle()

    expect(m.del.mock.calls.map((args) => args[0])).toEqual(['/role-bindings/b3'])
    // The earlier members survive and the list does not claim another page.
    expect(rows(m.app).map((row) => m.app.textOf(byId(m.app, 'member-name', row)))).toEqual(['User One', 'User Two'])
    expect(allById(m.app, 'member-load-more')).toHaveLength(0)
    m.app.unmount()
  })
})

describe('AC-7: a binding delete that fails mid-row', () => {
  test('the API message is toasted and the list is reloaded anyway', async () => {
    const err = new ApiError(409, 'The last project admin cannot be removed')
    const del = jest.fn()
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => { throw err })
    const m = await mountPanel({
      delete: del,
      rows: [
        userRow({
          bindings: [
            { id: 'b1', roleKey: 'developer', roleName: 'Developer' },
            { id: 'b2', roleKey: 'verifier', roleName: 'Verifier' },
          ],
        }),
      ],
    })
    const reloadsBefore = m.memberCalls.length

    call(byId(m.app, 'member-row-remove', rowOf(m.app, 'User One')), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(del).toHaveBeenCalledTimes(2)
    expect(m.memberCalls.length).toBeGreaterThan(reloadsBefore)
    m.app.unmount()
  })
})

describe('AC-8: member.add without role.binding.manage', () => {
  test('the add-user form renders and every binding control is absent', async () => {
    const m = await mountPanel({ keys: ['member.add'], rows: [userRow()] })

    expect(allById(m.app, 'member-add-form')).toHaveLength(1)
    expect(allById(m.app, 'agent-add-form')).toHaveLength(0)
    expect(allById(m.app, 'member-chip-add-role')).toHaveLength(0)
    expect(allById(m.app, 'member-chip-add')).toHaveLength(0)
    expect(allById(m.app, 'member-chip-remove')).toHaveLength(0)
    expect(allById(m.app, 'member-row-remove')).toHaveLength(0)
    // Without the binding key the agent picker is not even fetched.
    expect(m.get.mock.calls.map((args) => args[0])).not.toContain('/agents')
    m.app.unmount()
  })

  test('control: with role.binding.manage the same row does render them', async () => {
    const m = await mountPanel({ rows: [userRow()] })

    expect(allById(m.app, 'agent-add-form')).toHaveLength(1)
    expect(allById(m.app, 'member-chip-add', rowOf(m.app, 'User One'))).toHaveLength(1)
    expect(allById(m.app, 'member-chip-remove', rowOf(m.app, 'User One'))).toHaveLength(1)
    expect(allById(m.app, 'member-row-remove', rowOf(m.app, 'User One'))).toHaveLength(1)
    m.app.unmount()
  })
})

describe('AC-9: the signed-in user\'s own row is read-only', () => {
  test('no chip add, chip remove or row remove on my row, while another row keeps them', async () => {
    const m = await mountPanel({
      me: 'u1',
      rows: [
        userRow(),
        userRow({ principalId: 'u2', userId: 'u2', email: 'u2@example.test', name: 'User Two', bindings: [{ id: 'b3', roleKey: 'developer', roleName: 'Developer' }] }),
      ],
    })

    const mine = rowOf(m.app, 'User One')
    expect(allById(m.app, 'member-chip-add-role', mine)).toHaveLength(0)
    expect(allById(m.app, 'member-chip-add', mine)).toHaveLength(0)
    expect(allById(m.app, 'member-chip-remove', mine)).toHaveLength(0)
    expect(allById(m.app, 'member-row-remove', mine)).toHaveLength(0)

    const other = rowOf(m.app, 'User Two')
    expect(allById(m.app, 'member-chip-add', other)).toHaveLength(1)
    expect(allById(m.app, 'member-chip-remove', other)).toHaveLength(1)
    expect(allById(m.app, 'member-row-remove', other)).toHaveLength(1)
    m.app.unmount()
  })
})

describe('AC-11: a row with only legacy bindings offers no row removal', () => {
  test('no remove-row button even with role.binding.manage', async () => {
    const m = await mountPanel({
      rows: [agentRow({ bindings: [{ id: null, roleKey: 'viewer', roleName: 'Viewer' }] })],
    })

    expect(allById(m.app, 'member-row-remove', rowOf(m.app, 'Listed Bot'))).toHaveLength(0)
    // The chip is still there; it simply cannot be removed.
    expect(allById(m.app, 'member-chip', rowOf(m.app, 'Listed Bot'))).toHaveLength(1)
    m.app.unmount()
  })
})

describe('AC-12: a refused member add', () => {
  test('the API message is toasted and no row is appended', async () => {
    const err = new ApiError(40003, 'You cannot grant a role you do not hold')
    const m = await mountPanel({ post: jest.fn(async () => { throw err }) })

    typeInto(byId(m.app, 'member-add-email'), 'new@example.test')
    await settle()
    call(byId(m.app, 'member-add-role'), 'onChange', { target: { value: 'triager' } })
    await settle()
    submitForm(m.app, 'member-add-form')
    await settle()

    expect(m.post).toHaveBeenCalledTimes(1)
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(rows(m.app)).toHaveLength(1)
    m.app.unmount()
  })
})

describe('AC-13: refused binding writes keep the last loaded state', () => {
  test('a refused agent grant is toasted and the rows stay as loaded', async () => {
    const err = new ApiError(403, 'Missing role.binding.manage')
    const m = await mountPanel({
      rows: [userRow(), agentRow()],
      post: jest.fn(async () => { throw err }),
    })

    call(byId(m.app, 'agent-add-select'), 'onChange', { target: { value: 'a2' } })
    await settle()
    call(byId(m.app, 'agent-add-role'), 'onChange', { target: { value: 'reviewer' } })
    await settle()
    submitForm(m.app, 'agent-add-form')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(rows(m.app)).toHaveLength(2)
    m.app.unmount()
  })

  test('a refused chip add keeps the row\'s chips', async () => {
    const err = new ApiError(403, 'Missing role.binding.manage')
    const m = await mountPanel({ post: jest.fn(async () => { throw err }) })
    const row = rowOf(m.app, 'User One')

    call(byId(m.app, 'member-chip-add-role', row), 'onChange', { target: { value: 'verifier' } })
    await settle()
    call(byId(m.app, 'member-chip-add', row), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'member-chip', rowOf(m.app, 'User One'))).toHaveLength(1)
    m.app.unmount()
  })

  test('a refused chip removal keeps the chip', async () => {
    const err = new ApiError(409, 'The last project admin cannot be removed')
    const m = await mountPanel({ delete: jest.fn(async () => { throw err }) })
    const row = rowOf(m.app, 'User One')

    call(byId(m.app, 'member-chip-remove', row), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(allById(m.app, 'member-chip', rowOf(m.app, 'User One'))).toHaveLength(1)
    m.app.unmount()
  })
})

describe('the disabled-user anchor still holds (US-007 regression)', () => {
  test('a disabled member keeps the badge and gets no binding controls', async () => {
    const m = await mountPanel({ rows: [userRow({ disabled: true })] })

    const row = rowOf(m.app, 'User One')
    expect(allById(m.app, 'member-disabled-badge', row)).toHaveLength(1)
    expect(allById(m.app, 'member-chip-add', row)).toHaveLength(0)
    expect(allById(m.app, 'member-chip-remove', row)).toHaveLength(0)
    expect(allById(m.app, 'member-row-remove', row)).toHaveLength(0)
    m.app.unmount()
  })
})
