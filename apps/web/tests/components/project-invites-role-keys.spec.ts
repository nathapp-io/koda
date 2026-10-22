/**
 * Permissions P1 US-014 (AC-1 .. AC-8): project invites carry a project role key.
 *
 * The real `.vue` file is compiled and rendered by the mount-sfc harness, and the real
 * `useProjectInvites`, `useProjectRoles` and `useProjectPermissions` are injected through Nuxt's
 * auto-imports. `/me/permissions` is the double that answers the project key set, so every gate
 * assertion exercises the keys the panel actually resolved — never a stubbed `PermissionSet`.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile, type FakeNode, type Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { allById, byId, call, settle, typeInto } from '../helpers/roles-dom'
import { fakeAsyncData } from '../helpers/permission-nav'
import { useProjectInvites } from '../../composables/useProjectInvites'
import { useProjectRoles } from '../../composables/useProjectRoles'
import { useProjectPermissions } from '../../composables/usePermissions'

const panelFile = webFile('components', 'ProjectInvitesPanel.vue')
const ORIGIN = 'http://localhost:3101'

const ROLES = [
  { id: 'r1', key: 'project-admin', name: 'Project Admin', description: '', system: true },
  { id: 'r2', key: 'developer', name: 'Developer', description: '', system: true },
  { id: 'r3', key: 'triager', name: 'Triager', description: '', system: false },
]

interface InviteFixture {
  id: string
  email: string
  role: string | null
  roleKey: string | null
  roleName: string | null
  status: string
  inviterName: string | null
  expiresAt: string
  createdAt: string
}

const invite = (over: Partial<InviteFixture> = {}): InviteFixture => ({
  id: 'i1',
  email: 'pending@example.test',
  role: null,
  roleKey: 'developer',
  roleName: 'Developer',
  status: 'PENDING',
  inviterName: 'Ada',
  expiresAt: '2026-12-01T00:00:00Z',
  createdAt: '2026-11-01T00:00:00Z',
  ...over,
})

interface MountOptions {
  /** The caller's project key set, as `/me/permissions?project=web` answers it. */
  keys?: readonly string[]
  invites?: InviteFixture[]
  /** Forced outcomes for the write routes. */
  post?: jest.Mock
  delete?: jest.Mock
}

interface Mount {
  app: Mounted
  get: jest.Mock
  post: jest.Mock
  del: jest.Mock
  toast: { success: jest.Mock; error: jest.Mock }
  /** Exactly what `GET /projects/web/invites` answers; a reload re-reads it. */
  invites: InviteFixture[]
  /** Every invites list read, so a spec can prove a reload did (or did not) happen. */
  listCalls: number
}

async function mountPanel(options: MountOptions = {}): Promise<Mount> {
  const keys = options.keys ?? ['invite.read', 'invite.create', 'invite.resend', 'invite.cancel']
  const invites = [...(options.invites ?? [invite()])]
  const state = { listCalls: 0 }

  const get = jest.fn(async (path: string) => {
    if (path === '/me/permissions') return { scope: 'project', projectSlug: 'web', keys: [...keys] }
    if (path === '/projects/web/roles') return ROLES
    if (path === '/projects/web/invites') {
      state.listCalls += 1
      return [...invites]
    }
    throw new Error(`unexpected GET ${path}`)
  })
  const post = options.post ?? jest.fn(async () => ({ outcome: 'INVITED', invitePath: '/invite/tok123', emailed: true }))
  const del = options.delete ?? jest.fn(async () => undefined)
  const toast = { success: jest.fn(), error: jest.fn() }

  const host = globalThis as Record<string, unknown>
  host.useAsyncData = fakeAsyncData
  host.useApi = () => ({ $api: { get, post, delete: del } })
  host.window = { location: { origin: ORIGIN }, confirm: () => true }

  const app = mountSfc(panelFile, {
    props: { slug: 'web' },
    components: uiStubs,
    globals: {
      useApi: () => ({ $api: { get, post, delete: del } }),
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useProjectPermissions,
      useProjectInvites,
      useProjectRoles,
      useAuth: () => ({ user: ref({ id: 'me' }) }),
    },
  })
  await settle()
  return {
    app,
    get,
    post,
    del,
    toast,
    invites,
    get listCalls() { return state.listCalls },
  }
}

/** The options a select offers, by value. */
function optionsOf(app: Mounted, testId: string): string[] {
  return app.find('option', byId(app, testId)).map((option) => String(option.props.value))
}

function submitCreate(app: Mounted): void {
  call(byId(app, 'invite-create-form'), 'onSubmit', { preventDefault: () => undefined, target: {} })
}

/** The one-time link's text: a `<code>` carries it as a text child, not as a prop. */
function linkText(app: Mounted): string {
  const link = byId(app, 'invite-link')
  return String(link.props.value ?? app.textOf(link))
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
  delete host.window
})

describe('AC-1: the role select lists project roles and posts a role key', () => {
  test('it offers GET /projects/web/roles and posts { email, roleKey }', async () => {
    const m = await mountPanel()

    expect(m.get).toHaveBeenCalledWith('/projects/web/roles')
    expect(optionsOf(m.app, 'invite-role')).toEqual(['', ...ROLES.map((role) => role.key)])

    typeInto(byId(m.app, 'invite-email'), 'new@example.test')
    await settle()
    call(byId(m.app, 'invite-role'), 'onChange', { target: { value: 'developer' } })
    await settle()
    submitCreate(m.app)
    await settle()

    expect(m.post).toHaveBeenCalledWith('/projects/web/invites', { email: 'new@example.test', roleKey: 'developer' })
    m.app.unmount()
  })

  test('boundary: no role chosen means no request, so no role is granted by accident', async () => {
    const m = await mountPanel()

    typeInto(byId(m.app, 'invite-email'), 'new@example.test')
    await settle()
    submitCreate(m.app)
    await settle()

    expect(m.post).not.toHaveBeenCalled()
    m.app.unmount()
  })
})

describe('AC-2: each invite row renders its roleName', () => {
  test('a custom role shows the name the API sent', async () => {
    const m = await mountPanel({
      invites: [
        invite({ id: 'i1', email: 'one@example.test', roleKey: 'triager', roleName: 'Triager' }),
        invite({ id: 'i2', email: 'two@example.test', roleKey: 'project-admin', roleName: 'Project Admin' }),
      ],
    })

    const rows = allById(m.app, 'invite-row')
    expect(rows).toHaveLength(2)
    // Scoped to the row, so the select's option labels cannot satisfy the assertion.
    expect(m.app.textOf(rows[0] as FakeNode)).toContain('Triager')
    expect(m.app.textOf(rows[1] as FakeNode)).toContain('Project Admin')
    // The row shows the role's name, never the raw key.
    expect(allById(m.app, 'invite-row-role').map((cell) => m.app.textOf(cell))).toEqual(['Triager', 'Project Admin'])
    m.app.unmount()
  })
})

describe('AC-3: independent invite gates', () => {
  test('without invite.read the panel renders nothing', async () => {
    const m = await mountPanel({ keys: ['invite.create', 'invite.resend', 'invite.cancel'] })

    expect(m.app.text()).toBe('')
    expect(m.app.one('[data-testid="invite-create-form"]')).toBeUndefined()
    expect(allById(m.app, 'invite-row')).toHaveLength(0)
    // A refused read would only earn a 403 toast, so the list is never asked for.
    expect(m.get).not.toHaveBeenCalledWith('/projects/web/invites')
    m.app.unmount()
  })

  test('with invite.read but not invite.create it renders the list and no form', async () => {
    const m = await mountPanel({ keys: ['invite.read', 'invite.resend', 'invite.cancel'] })

    expect(allById(m.app, 'invite-row')).toHaveLength(1)
    expect(m.app.one('[data-testid="invite-create-form"]')).toBeUndefined()
    // Resend and cancel are their own keys, not a side effect of invite.read.
    expect(m.app.one('[data-testid="invite-resend-i1"]')).toBeDefined()
    expect(m.app.one('[data-testid="invite-cancel-i1"]')).toBeDefined()
    m.app.unmount()
  })

  test('resend and cancel follow their own keys', async () => {
    const noResend = await mountPanel({ keys: ['invite.read', 'invite.cancel'] })
    expect(allById(noResend.app, 'invite-row')).toHaveLength(1)
    expect(noResend.app.one('[data-testid="invite-resend-i1"]')).toBeUndefined()
    expect(noResend.app.one('[data-testid="invite-cancel-i1"]')).toBeDefined()
    noResend.app.unmount()

    const noCancel = await mountPanel({ keys: ['invite.read', 'invite.resend'] })
    expect(noCancel.app.one('[data-testid="invite-resend-i1"]')).toBeDefined()
    expect(noCancel.app.one('[data-testid="invite-cancel-i1"]')).toBeUndefined()
    noCancel.app.unmount()
  })
})

describe('AC-4: the public invite page shows the preview roleName', () => {
  test('the preview answers roleName and the page renders it', async () => {
    const pagePath = webFile('pages', 'invite', '[token].vue')
    const get = jest.fn(async () => ({
      projectName: 'Acme Project',
      projectSlug: 'web',
      email: 'new@example.test',
      role: null,
      roleKey: 'triager',
      roleName: 'Triager',
      expiresAt: '2026-12-01T00:00:00Z',
    }))
    const app = mountSfc(pagePath, {
      components: uiStubs,
      globals: {
        useRoute: () => ({ params: { token: 'tok123' } }),
        useApi: () => ({ $api: { get } }),
        useAuth: () => ({ isAuthenticated: ref(false), acceptInvite: jest.fn() }),
        navigateTo: jest.fn(),
        useI18n: () => enI18n(),
        useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
        definePageMeta: () => undefined,
      },
    })
    await settle()

    expect(byId(app, 'invite-role-name')).toBeDefined()
    expect(app.text()).toContain('Triager')
    app.unmount()
  })
})

describe('AC-5: a rejected invite create is surfaced and changes nothing', () => {
  test('it toasts extractApiError and leaves the loaded list untouched', async () => {
    const m = await mountPanel({ post: jest.fn(async () => { throw { data: { message: 'Not allowed' } } }) })

    typeInto(byId(m.app, 'invite-email'), 'new@example.test')
    await settle()
    call(byId(m.app, 'invite-role'), 'onChange', { target: { value: 'triager' } })
    await settle()
    const before = m.app.text()
    const readsBefore = m.listCalls
    submitCreate(m.app)
    await settle()

    expect(m.toast.error).toHaveBeenCalledTimes(1)
    expect(m.toast.error.mock.calls[0]?.[0]).toBe('Not allowed')
    // No reload and no local edit: the list is exactly what the last successful read returned.
    expect(m.listCalls).toBe(readsBefore)
    expect(m.app.text()).toBe(before)
    m.app.unmount()
  })
})

describe('AC-6: rejected resend and cancel writes are surfaced and leave the list alone', () => {
  test('a rejected resend toasts and keeps the list', async () => {
    const m = await mountPanel({ post: jest.fn(async () => { throw { data: { message: 'Resend refused' } } }) })
    const before = m.app.text()
    const readsBefore = m.listCalls

    call(byId(m.app, 'invite-resend-i1'), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledTimes(1)
    expect(m.toast.error.mock.calls[0]?.[0]).toBe('Resend refused')
    // The refusal came from the API: the write really was attempted.
    expect(m.post).toHaveBeenCalledWith('/projects/web/invites/i1/resend')
    expect(m.listCalls).toBe(readsBefore)
    expect(m.app.text()).toBe(before)
    m.app.unmount()
  })

  test('a rejected cancel toasts and keeps the list', async () => {
    const m = await mountPanel({ delete: jest.fn(async () => { throw { data: { message: 'Cancel refused' } } }) })
    const before = m.app.text()
    const readsBefore = m.listCalls

    call(byId(m.app, 'invite-cancel-i1'), 'onClick')
    await settle()

    expect(m.toast.error).toHaveBeenCalledTimes(1)
    expect(m.toast.error.mock.calls[0]?.[0]).toBe('Cancel refused')
    expect(m.del).toHaveBeenCalledWith('/projects/web/invites/i1')
    expect(m.listCalls).toBe(readsBefore)
    expect(m.app.text()).toBe(before)
    m.app.unmount()
  })
})

describe('AC-7: an INVITED outcome keeps the one-time link and the emailed result', () => {
  test('it shows the returned invitePath with the current origin and reloads the list', async () => {
    const m = await mountPanel({
      post: jest.fn(async () => ({ outcome: 'INVITED', invitePath: '/invite/tok123', emailed: false })),
    })
    const readsBefore = m.listCalls

    typeInto(byId(m.app, 'invite-email'), 'new@example.test')
    await settle()
    call(byId(m.app, 'invite-role'), 'onChange', { target: { value: 'developer' } })
    await settle()
    submitCreate(m.app)
    await settle()

    expect(linkText(m.app)).toBe(`${ORIGIN}/invite/tok123`)
    // emailed === false still shows the "share the link" notice: the link is what matters.
    expect(m.app.text()).toContain('The invite email could not be sent. Share the link below.')
    expect(m.listCalls).toBeGreaterThan(readsBefore)
    m.app.unmount()
  })
})

describe('AC-8: an ADDED outcome emits member-added and reloads', () => {
  test('the existing settings listener still gets member-added', async () => {
    const m = await mountPanel({ post: jest.fn(async () => ({ outcome: 'ADDED' })) })
    const readsBefore = m.listCalls

    typeInto(byId(m.app, 'invite-email'), 'existing@example.test')
    await settle()
    call(byId(m.app, 'invite-role'), 'onChange', { target: { value: 'triager' } })
    await settle()
    submitCreate(m.app)
    await settle()

    expect(m.app.emitted('member-added')).toHaveLength(1)
    expect(m.listCalls).toBeGreaterThan(readsBefore)
    // ADDED allocates no invite link.
    expect(m.app.one('[data-testid="invite-link"]')).toBeUndefined()
    m.app.unmount()
  })
})
