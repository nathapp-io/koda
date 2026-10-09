/**
 * US-007 — public invite accept page (`pages/invite/[token].vue`).
 *
 * Mounts the real page with the mount-sfc harness: Nuxt auto-imports (useRoute,
 * useApi, useAuth, navigateTo, useI18n, useAppToast) are supplied as globals and
 * every assertion reads the rendered tree or the recorded calls.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { existsSync } from 'fs'
import { ref, nextTick } from 'vue'
import { mountSfc, webFile, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'

const pagePath = webFile('pages', 'invite', '[token].vue')

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

function submit(app: Mounted): void {
  const form = node(app, 'invite-accept-form')
  const fn = form.props.onSubmit
  expect(fn).toBeInstanceOf(Function)
  ;(fn as (e: { target: Record<string, unknown>, preventDefault: () => void }) => unknown)({
    target: {}, preventDefault: () => undefined,
  })
}

interface PageOverrides {
  token?: string
  isAuthenticated?: boolean
  get?: jest.Mock
  acceptInvite?: jest.Mock
}

function mountPage(over: PageOverrides = {}) {
  const get = over.get ?? jest.fn(async () => ({ projectName: 'Acme Project', projectSlug: 'my-project', email: 'a@x.io' }))
  const acceptInvite = over.acceptInvite ?? jest.fn(async () => ({ project: { slug: 'my-project' } }))
  const navigateTo = jest.fn(() => undefined)
  const auth = { isAuthenticated: ref(over.isAuthenticated ?? false), acceptInvite }
  const toast = { error: jest.fn(), success: jest.fn() }
  const app = mountSfc(pagePath, {
    components: uiStubs,
    globals: {
      useRoute: () => ({ params: { token: over.token ?? 'tok123' } }),
      useApi: () => ({ $api: { get } }),
      useAuth: () => auth,
      navigateTo,
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      definePageMeta: () => undefined,
    },
  })
  return { app, get, auth, navigateTo, toast }
}

describe('/invite/[token] (US-007)', () => {
  beforeEach(() => {
    // RED guard: the page must exist before behaviour can be exercised.
    expect(existsSync(pagePath)).toBe(true)
  })

  test('AC8: loads and GETs /invites/<token>, displaying the preview projectName', async () => {
    expect(existsSync(pagePath)).toBe(true)
    const p = mountPage()
    await settle()

    expect(p.get).toHaveBeenCalledTimes(1)
    expect(p.get.mock.calls[0]?.[0]).toBe('/invites/tok123')
    expect(p.app.text()).toContain('Acme Project')
    p.app.unmount()
  })

  test('AC8 boundary: the token used is taken from the route param', async () => {
    const p = mountPage({ token: 'tokXYZ' })
    await settle()

    expect(p.get.mock.calls[0]?.[0]).toBe('/invites/tokXYZ')
    p.app.unmount()
  })

  test('AC9: a 404 preview shows invite.invalid and hides the accept form', async () => {
    const get = jest.fn(async () => { throw { status: 404 } })
    const p = mountPage({ get })
    await settle()

    expect(p.app.text()).toContain(copyOf('invite.invalid'))
    expect(p.app.one('[data-testid="invite-accept-form"]')).toBeUndefined()
    p.app.unmount()
  })

  test('AC9 boundary: a valid preview does not show the invalid notice', async () => {
    const p = mountPage()
    await settle()

    expect(p.app.text()).not.toContain(copyOf('invite.invalid'))
    p.app.unmount()
  })

  test('AC10: an authenticated visitor sees invite-signed-in instead of the accept form', async () => {
    const p = mountPage({ isAuthenticated: true })
    await settle()

    expect(node(p.app, 'invite-signed-in')).toBeDefined()
    expect(p.app.one('[data-testid="invite-accept-form"]')).toBeUndefined()
    p.app.unmount()
  })

  test('AC10 boundary: an unauthenticated visitor sees the accept form, not invite-signed-in', async () => {
    const p = mountPage({ isAuthenticated: false })
    await settle()

    expect(node(p.app, 'invite-accept-form')).toBeDefined()
    expect(p.app.one('[data-testid="invite-signed-in"]')).toBeUndefined()
    p.app.unmount()
  })

  test('AC11: submitting the accept form calls acceptInvite(token, { name, password })', async () => {
    const p = mountPage()
    await settle()

    fill(field(p.app, 'name'), 'Jane Doe')
    fill(field(p.app, 'password'), 'Secret123!')
    await nextTick()
    submit(p.app)
    await settle()

    expect(p.auth.acceptInvite).toHaveBeenCalledTimes(1)
    expect(p.auth.acceptInvite).toHaveBeenCalledWith('tok123', { name: 'Jane Doe', password: 'Secret123!' })
    p.app.unmount()
  })

  test('AC11 boundary: the route token is forwarded to acceptInvite', async () => {
    const p = mountPage({ token: 'tokXYZ' })
    await settle()

    fill(field(p.app, 'name'), 'Jane Doe')
    fill(field(p.app, 'password'), 'Secret123!')
    await nextTick()
    submit(p.app)
    await settle()

    expect(p.auth.acceptInvite).toHaveBeenCalledWith('tokXYZ', { name: 'Jane Doe', password: 'Secret123!' })
    p.app.unmount()
  })

  test('AC12: after acceptInvite resolves the page navigates to /<projectSlug>', async () => {
    const p = mountPage()
    await settle()

    fill(field(p.app, 'name'), 'Jane Doe')
    fill(field(p.app, 'password'), 'Secret123!')
    await nextTick()
    submit(p.app)
    await settle()

    expect(p.navigateTo).toHaveBeenCalledTimes(1)
    expect(p.navigateTo).toHaveBeenCalledWith('/my-project')
    p.app.unmount()
  })

  test('AC12 boundary: a rejected acceptInvite does not navigate', async () => {
    const acceptInvite = jest.fn(async () => { throw { status: 500 } })
    const p = mountPage({ acceptInvite })
    await settle()

    fill(field(p.app, 'name'), 'Jane Doe')
    fill(field(p.app, 'password'), 'Secret123!')
    await nextTick()
    submit(p.app)
    await settle()

    expect(p.navigateTo).not.toHaveBeenCalled()
    p.app.unmount()
  })

  test('AC14: a 409 accept rejection shows invite.accountExists and does not navigate', async () => {
    const acceptInvite = jest.fn(async () => { throw { status: 409 } })
    const p = mountPage({ acceptInvite })
    await settle()

    fill(field(p.app, 'name'), 'Jane Doe')
    fill(field(p.app, 'password'), 'Secret123!')
    await nextTick()
    submit(p.app)
    await settle()

    expect(p.app.text()).toContain(copyOf('invite.accountExists'))
    expect(p.navigateTo).not.toHaveBeenCalled()
    p.app.unmount()
  })

  test('AC14 boundary: a non-409 rejection does not show invite.accountExists', async () => {
    const acceptInvite = jest.fn(async () => { throw { status: 400 } })
    const p = mountPage({ acceptInvite })
    await settle()

    fill(field(p.app, 'name'), 'Jane Doe')
    fill(field(p.app, 'password'), 'Secret123!')
    await nextTick()
    submit(p.app)
    await settle()

    expect(p.app.text()).not.toContain(copyOf('invite.accountExists'))
    p.app.unmount()
  })
})
