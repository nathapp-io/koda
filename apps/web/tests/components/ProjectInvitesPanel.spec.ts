/**
 * US-007 — Project invites panel (create / resend / cancel).
 *
 * Behavioural mount tests: the real .vue file is compiled and rendered by the
 * mount-sfc harness, the Nuxt auto-import `useProjectInvites` is aliased to a
 * recording double, and every assertion reads the rendered tree or the emitted
 * events — never the source text.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { existsSync } from 'fs'
import { h, ref, nextTick } from 'vue'
import { mountSfc, webFile, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'

const ORIGIN = 'http://localhost:3101'
const panelPath = webFile('components', 'ProjectInvitesPanel.vue')
const settingsPath = webFile('pages', '[project]', 'settings.vue')

/** A window the compiled component can read for `window.location.origin` / `window.confirm`. */
function setWindow(confirmFn: (message?: string) => boolean = () => true): void {
  (globalThis as Record<string, unknown>).window = {
    location: { origin: ORIGIN },
    confirm: confirmFn,
  }
}

/** Resolve an i18n key against the real en.json tree, asserting the key exists. */
function copyOf(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), enLocale)
  expect(typeof value).toBe('string')
  return value as string
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await nextTick()
  }
}

function node(app: Mounted, id: string): FakeNode {
  const found = app.one(`[data-testid="${id}"]`)
  expect(found).toBeDefined()
  return found as FakeNode
}

/** The first field whose name, id or data-testid matches. */
function field(app: Mounted, name: string): FakeNode {
  const result = [...app.find('input'), ...app.find('select'), ...app.find('[data-stub="input"]')]
    .find((n) => n.props.name === name || n.props.id === name || n.props['data-testid'] === name)
  expect(result).toBeDefined()
  return result as FakeNode
}

function fill(target: FakeNode, value: string): void {
  const update = target.props['onUpdate:modelValue']
  expect(update).toBeInstanceOf(Function)
  ;(update as (v: string) => void)(value)
}

function fire(target: FakeNode, event: string): void {
  const fn = target.props[event]
  expect(fn).toBeInstanceOf(Function)
  ;(fn as (e: { target: Record<string, unknown>, preventDefault: () => void }) => unknown)({
    target: {}, preventDefault: () => undefined,
  })
}

function linkText(app: Mounted): string {
  const link = node(app, 'invite-link')
  return String(link.props.value ?? app.textOf(link))
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  const invites = ref([{ id: 'i1', email: 'pending@x.io', role: 'DEVELOPER', status: 'PENDING' }])
  const api = {
    invites,
    canManage: ref(true),
    load: jest.fn(async () => undefined),
    create: jest.fn(async () => ({ outcome: 'INVITED', invitePath: '/invite/tok123', emailed: true })),
    resend: jest.fn(async () => ({ invitePath: '/invite/tok456', emailed: false })),
    cancel: jest.fn(async () => undefined),
    ...overrides,
  }
  const toast = { error: jest.fn(), success: jest.fn() }
  const app = mountSfc(panelPath, {
    props: { slug: 'my-project' },
    components: uiStubs,
    alias: { '~/composables/useProjectInvites': { useProjectInvites: () => api } },
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
    },
  })
  return { app, api, toast }
}

/** Submit the create form with the given email (role defaults to DEVELOPER). */
async function submitCreate(p: ReturnType<typeof mountPanel>, email: string, role = 'DEVELOPER'): Promise<void> {
  fill(field(p.app, 'email'), email)
  fill(field(p.app, 'role'), role)
  await nextTick()
  fire(node(p.app, 'invite-create-form'), 'onSubmit')
  await settle()
}

describe('ProjectInvitesPanel (US-007)', () => {
  beforeEach(() => {
    setWindow()
    // RED guard: the component must exist before behaviour can be exercised.
    expect(existsSync(panelPath)).toBe(true)
  })

  test('AC1: submitting email new@x.io and role DEVELOPER calls create("new@x.io", "DEVELOPER")', async () => {
    expect(existsSync(panelPath)).toBe(true)
    const p = mountPanel()
    await settle()

    await submitCreate(p, 'new@x.io', 'DEVELOPER')

    expect(p.api.create).toHaveBeenCalledTimes(1)
    expect(p.api.create).toHaveBeenCalledWith('new@x.io', 'DEVELOPER')
    p.app.unmount()
  })

  test('AC1 boundary: a rejected create surfaces the API error through the toast', async () => {
    const p = mountPanel({ create: jest.fn(async () => { throw { data: { message: 'Invite failed' } } }) })
    await settle()

    await submitCreate(p, 'new@x.io')

    expect(p.toast.error).toHaveBeenCalledTimes(1)
    expect(p.app.emitted('member-added')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC2: outcome INVITED shows invite-link with origin joined to the returned invitePath', async () => {
    const p = mountPanel()
    await settle()

    await submitCreate(p, 'new@x.io')

    expect(linkText(p.app)).toBe(`${ORIGIN}/invite/tok123`)
    p.app.unmount()
  })

  test('AC2 boundary: no invite-link is shown before an invite is created', async () => {
    const p = mountPanel()
    await settle()

    expect(p.app.one('[data-testid="invite-link"]')).toBeUndefined()
    p.app.unmount()
  })

  test('AC3: emailed false displays the text of projects.invites.notEmailed', async () => {
    const p = mountPanel({
      create: jest.fn(async () => ({ outcome: 'INVITED', invitePath: '/invite/tok123', emailed: false })),
    })
    await settle()

    await submitCreate(p, 'new@x.io')

    expect(p.app.text()).toContain(copyOf('projects.invites.notEmailed'))
    p.app.unmount()
  })

  test('AC3 boundary: emailed true does not display the notEmailed notice', async () => {
    const p = mountPanel({
      create: jest.fn(async () => ({ outcome: 'INVITED', invitePath: '/invite/tok123', emailed: true })),
    })
    await settle()

    await submitCreate(p, 'new@x.io')

    expect(p.app.text()).not.toContain(copyOf('projects.invites.notEmailed'))
    p.app.unmount()
  })

  test('AC4: outcome ADDED emits member-added', async () => {
    const p = mountPanel({ create: jest.fn(async () => ({ outcome: 'ADDED' })) })
    await settle()

    await submitCreate(p, 'new@x.io')

    expect(p.app.emitted('member-added')).toHaveLength(1)
    p.app.unmount()
  })

  test('AC4 boundary: outcome INVITED emits no member-added', async () => {
    const p = mountPanel()
    await settle()

    await submitCreate(p, 'new@x.io')

    expect(p.app.emitted('member-added')).toHaveLength(0)
    p.app.unmount()
  })

  test('AC5: resending invite i1 shows invite-link with the invitePath resend returned', async () => {
    const p = mountPanel()
    await settle()

    fire(node(p.app, 'invite-resend-i1'), 'onClick')
    await settle()

    expect(p.api.resend).toHaveBeenCalledTimes(1)
    expect(p.api.resend).toHaveBeenCalledWith('i1')
    expect(linkText(p.app)).toBe(`${ORIGIN}/invite/tok456`)
    p.app.unmount()
  })

  test('AC5 boundary: resend is not called before the resend control is used', async () => {
    const p = mountPanel()
    await settle()

    expect(p.api.resend).not.toHaveBeenCalled()
    p.app.unmount()
  })

  test('AC6: cancel("i1") is called only when window.confirm returns true', async () => {
    const confirmCalls: string[] = []
    let allowed = false
    setWindow((message) => { confirmCalls.push(String(message)); return allowed })
    const p = mountPanel()
    await settle()

    fire(node(p.app, 'invite-cancel-i1'), 'onClick')
    await settle()
    expect(p.api.cancel).not.toHaveBeenCalled()

    allowed = true
    fire(node(p.app, 'invite-cancel-i1'), 'onClick')
    await settle()
    expect(p.api.cancel).toHaveBeenCalledTimes(1)
    expect(p.api.cancel).toHaveBeenCalledWith('i1')
    // The confirmation names the invite so the admin confirms the right row.
    expect(confirmCalls.some((message) => message.includes('pending@x.io'))).toBe(true)
    p.app.unmount()
  })

  test('AC4 wiring: settings refreshes its member data when the panel emits member-added', async () => {
    expect(existsSync(settingsPath)).toBe(true)
    const reload = jest.fn(async () => undefined)
    const app = mountSfc(settingsPath, {
      components: {
        ...uiStubs,
        ProjectInvitesPanel: {
          name: 'StubInvitesPanel',
          setup(_props: unknown, { attrs }: { attrs: Record<string, unknown> }) {
            return () => h('div', { 'data-testid': 'invites-child', ...attrs })
          },
        },
      },
      globals: {
        useRoute: () => ({ params: { project: 'my-project' } }),
        useApi: () => ({ $api: { get: jest.fn(async () => ({})) } }),
        useI18n: () => enI18n(),
        useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
        useAsyncData: () => ({ data: ref({ slug: 'my-project' }), pending: ref(false), error: ref(null), refresh: reload }),
        definePageMeta: () => undefined,
      },
    })
    await settle()

    fire(node(app, 'invites-child'), 'onMemberAdded')
    await settle()

    expect(reload.mock.calls.length).toBeGreaterThan(0)
    app.unmount()
  })

  test('locale: zh defines every projects.invites key that en defines', async () => {
    const zh = (await import('../../i18n/locales/zh.json')).default as Record<string, unknown>
    const flatten = (tree: unknown): string[] => {
      if (!tree || typeof tree !== 'object') return []
      return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
        value && typeof value === 'object' ? flatten(value).map((k) => `${key}.${k}`) : [key],
      )
    }
    const nesting = (locale: Record<string, unknown>): unknown =>
      (locale.projects as Record<string, unknown> | undefined)?.invites
    const enInvites = flatten(nesting(enLocale))
    expect(enInvites.length).toBeGreaterThan(0)
    const missing = enInvites.filter((key) => !flatten(nesting(zh)).includes(key))
    expect(missing).toEqual([])
  })
})
