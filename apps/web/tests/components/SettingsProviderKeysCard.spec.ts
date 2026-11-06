import { describe, test, expect, jest, afterEach } from '@jest/globals'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { Mounted } from '../helpers/mount-sfc'
import { uiStubs, i18nStub, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { projectPermissionsStub } from '../helpers/permission-nav'

const cardFile = webFile('components', 'SettingsProviderKeysCard.vue')
const row = (overrides: Record<string, unknown> = {}) => ({ id: 'c1', scope: 'PROJECT', repoId: null, providerId: 'openrouter', name: 'Main', last4: '1234', fingerprint: 'abcdef012345', disabled: false, ...overrides })
const get = jest.fn(async (path: string): Promise<unknown> => path.endsWith('/fleet/repos') ? { records: [{ id: 'r1', owner: 'acme', name: 'app' }] } : { records: [row(), row({ id: 'c2', scope: 'REPO', repoId: 'r1', name: 'Repo key' })] })
const post = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => row())
const patch = jest.fn(async (_path: string, _body?: unknown): Promise<unknown> => row())
const remove = jest.fn(async (_path: string): Promise<unknown> => ({}))
const toast = toastRecorder()
async function flush() { for (let i = 0; i < 5; i++) await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
async function mountCard(keys: readonly string[] = ['project.credential.read', 'project.credential.create']): Promise<Mounted> {
  const app = mountSfc(cardFile, { props: { slug: 'web' }, components: uiStubs, alias: { '~/composables/useApi': apiModule }, globals: { useApi: () => ({ $api: { get, post, patch, delete: remove } }), useI18n: () => i18nStub(), useAppToast: () => toast, useProjectPermissions: () => projectPermissionsStub(keys) } })
  await flush(); return app
}
const node = (app: Mounted, id: string) => app.find(`[data-testid="${id}"]`)[0]
afterEach(() => { get.mockReset().mockImplementation(async (path: string): Promise<unknown> => path.endsWith('/fleet/repos') ? { records: [{ id: 'r1', owner: 'acme', name: 'app' }] } : { records: [row(), row({ id: 'c2', scope: 'REPO', repoId: 'r1', name: 'Repo key' })] }); post.mockReset().mockImplementation(async (_path: string, _body?: unknown): Promise<unknown> => row()); patch.mockReset().mockImplementation(async (_path: string, _body?: unknown): Promise<unknown> => row()); remove.mockReset().mockImplementation(async (_path: string): Promise<unknown> => ({})); toast.errors.length = 0 })

describe('US-013 SettingsProviderKeysCard', () => {
  test('AC-1: displays project and repo credentials using their scope/repository grouping', async () => {
    const app = await mountCard()
    expect(app.text()).toContain('openrouter · Main')
    expect(app.text()).toContain('acme/app')
    expect(app.text()).toContain('openrouter · Repo key')
    expect(get).toHaveBeenCalledWith('/projects/web/provider-credentials', expect.anything())
    app.unmount()
  })
  test('loads after asynchronously arriving read permission', async () => {
    const permissions = projectPermissionsStub(['project.credential.read'], { pending: true })
    const app = mountSfc(cardFile, { props: { slug: 'web' }, components: uiStubs, alias: { '~/composables/useApi': apiModule }, globals: { useApi: () => ({ $api: { get, post, patch, delete: remove } }), useI18n: () => i18nStub(), useAppToast: () => toast, useProjectPermissions: () => permissions } })
    await flush()
    expect(get).not.toHaveBeenCalled()
    permissions.pending.value = false
    await flush()
    expect(get).toHaveBeenCalledWith('/projects/web/provider-credentials', expect.anything())
    app.unmount()
  })
  test('AC-2: project add sends the expected payload without repoId', async () => {
    const app = await mountCard()
    for (const [id, value] of [['provider-key-provider', 'openrouter'], ['provider-key-name', 'New key'], ['provider-key-secret', 'sk-live-0123456789abcdef']]) {
      const field = node(app, id)
      ;(field?.props['onUpdate:modelValue'] as (value: string) => void)(value)
    }
    await (node(app, 'provider-key-add')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(post).toHaveBeenCalledWith('/projects/web/provider-credentials', { providerId: 'openrouter', name: 'New key', key: 'sk-live-0123456789abcdef' })
    app.unmount()
  })
  test('AC-3: repo add includes the selected repo id', async () => {
    const app = await mountCard()
    await (node(app, 'provider-key-scope-repo')?.props.onClick as () => void)()
    await flush()
    const select = app.find('Select')[0]
    ;(select?.props['onUpdate:modelValue'] as (value: string) => void)('r1')
    for (const [id, value] of [['provider-key-provider', 'openrouter'], ['provider-key-name', 'Repo key'], ['provider-key-secret', 'sk-live-0123456789abcdef']]) {
      const field = node(app, id)
      ;(field?.props['onUpdate:modelValue'] as (value: string) => void)(value)
    }
    await (node(app, 'provider-key-add')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(post).toHaveBeenCalledWith('/projects/web/provider-credentials', { providerId: 'openrouter', name: 'Repo key', key: 'sk-live-0123456789abcdef', repoId: 'r1' })
    app.unmount()
  })
  test('AC-4/5: rotates key-only and disables with only disabled', async () => {
    const app = await mountCard(['project.credential.read', 'project.credential.update'])
    const rotateInput = node(app, 'provider-key-rotate-input-c1')
    ;(rotateInput?.props.onInput as (event: Event) => void)({ target: { value: 'sk-live-0123456789abcdef' } } as unknown as Event)
    await (node(app, 'provider-key-rotate-c1')?.props.onClick as () => void)()
    await flush()
    expect(patch).toHaveBeenCalledWith('/projects/web/provider-credentials/c1', { key: 'sk-live-0123456789abcdef' })
    await (node(app, 'provider-key-disable-c1')?.props.onClick as () => void)()
    await flush()
    expect(patch).toHaveBeenCalledWith('/projects/web/provider-credentials/c1', { disabled: true })
    app.unmount()
  })
  test('AC-1: loads credential and repo entries after page one', async () => {
    get.mockImplementation(async (path: string, options?: { query?: Record<string, string> }): Promise<unknown> => {
      const page = options?.query?.current
      if (path.endsWith('/fleet/repos')) return page === '2' ? { records: [{ id: 'r2', owner: 'acme', name: 'later-repo' }], hasNext: false } : { records: [{ id: 'r1', owner: 'acme', name: 'app' }], hasNext: true }
      return page === '2' ? { records: [row({ id: 'c2', scope: 'REPO', repoId: 'r2', name: 'later-key' })], current: 2, total: 2, hasNext: false, hasPrev: true } : { records: [row()], current: 1, total: 2, hasNext: true, hasPrev: false }
    })
    const app = await mountCard(['project.credential.read', 'project.credential.update'])
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/repos', { query: { size: '100', current: '2' } })
    await (node(app, 'provider-keys-next')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(get).toHaveBeenCalledWith('/projects/web/provider-credentials', { query: { size: '100', current: '2' } })
    expect(app.text()).toContain('later-key')
    expect(app.text()).toContain('acme/later-repo')
    app.unmount()
  })
  test('AC-7: preserves controlled key drafts for another row after a rotation reload', async () => {
    const app = await mountCard(['project.credential.read', 'project.credential.update'])
    const first = node(app, 'provider-key-rotate-input-c1')
    const second = node(app, 'provider-key-rotate-input-c2')
    ;(first?.props.onInput as (event: Event) => void)({ target: { value: 'sk-first-123456789abcdef' } } as unknown as Event)
    ;(second?.props.onInput as (event: Event) => void)({ target: { value: 'sk-second-123456789abcdef' } } as unknown as Event)
    await (node(app, 'provider-key-rotate-c1')?.props.onClick as () => void)()
    await flush()
    expect(node(app, 'provider-key-rotate-input-c2')?.props.value).toBe('sk-second-123456789abcdef')
    await (node(app, 'provider-key-rotate-c2')?.props.onClick as () => void)()
    await flush()
    expect(patch).toHaveBeenLastCalledWith('/projects/web/provider-credentials/c2', { key: 'sk-second-123456789abcdef' })
    app.unmount()
  })
  test('AC-6: confirms before delete and leaves data when confirmation is declined', async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: jest.fn(() => false) } })
    const app = await mountCard(['project.credential.read', 'project.credential.delete'])
    await (node(app, 'provider-key-delete-c1')?.props.onClick as () => void)()
    expect(remove).not.toHaveBeenCalled()
    ;(globalThis.window.confirm as jest.Mock).mockReturnValue(true)
    await (node(app, 'provider-key-delete-c1')?.props.onClick as () => void)()
    await flush()
    expect(remove).toHaveBeenCalledWith('/projects/web/provider-credentials/c1')
    app.unmount()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  })
  test('M2: the delete confirmation interpolates {provider}, the name both locales word', async () => {
    const originalWindow = globalThis.window
    const confirm = jest.fn(() => false)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm } })
    // The real `t` fills `{provider}` from the params; the stub echoes them, so the key the card passes is observable.
    const t = (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}`
    const app = mountSfc(cardFile, { props: { slug: 'web' }, components: uiStubs, alias: { '~/composables/useApi': apiModule }, globals: { useApi: () => ({ $api: { get, post, patch, delete: remove } }), useI18n: () => ({ t, te: () => true }), useAppToast: () => toast, useProjectPermissions: () => projectPermissionsStub(['project.credential.read', 'project.credential.delete']) } })
    await flush()
    await (node(app, 'provider-key-delete-c1')?.props.onClick as () => void)()
    const text = String(confirm.mock.calls[0]?.[0] ?? '')
    expect(text).toContain('fleet.providerKeys.deleteConfirm')
    expect(text).toContain('"provider":"openrouter"')
    expect(text).not.toContain('"name"')
    app.unmount()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  })
  /**
   * B2 (branch review): a rotation in flight must not be able to erase a draft. The row's field and actions are closed
   * until its own response lands, a second click never starts a second write, and a key typed meanwhile — which the
   * input's disabled state already prevents in the browser, so this drives the handler directly — is not cleared by
   * the answer to the earlier request.
   */
  test('B2: a key typed while the rotation is in flight survives, and the row is closed until it lands', async () => {
    let release: (value: unknown) => void = () => undefined
    patch.mockImplementationOnce(async () => new Promise((resolve) => { release = resolve }))
    const app = await mountCard(['project.credential.read', 'project.credential.update'])
    ;(node(app, 'provider-key-rotate-input-c1')?.props.onInput as (event: Event) => void)({ target: { value: 'sk-first-123456789abcdef' } } as unknown as Event)
    const inFlight = (node(app, 'provider-key-rotate-c1')?.props.onClick as () => Promise<void>)()
    await flush()

    expect(node(app, 'provider-key-rotate-input-c1')?.props.disabled).toBe(true)
    expect(node(app, 'provider-key-rotate-c1')?.props.disabled).toBe(true)
    expect(node(app, 'provider-key-disable-c1')?.props.disabled).toBe(true)
    expect(node(app, 'provider-key-rotate-input-c2')?.props.disabled).toBe(false)   // only that row is closed
    await (node(app, 'provider-key-rotate-c1')?.props.onClick as () => Promise<void>)()
    expect(patch).toHaveBeenCalledTimes(1)                                          // a repeated click starts no second write

    ;(node(app, 'provider-key-rotate-input-c1')?.props.onInput as (event: Event) => void)({ target: { value: 'sk-second-123456789abcdef' } } as unknown as Event)
    release(row())
    await inFlight
    await flush()

    expect(patch).toHaveBeenCalledWith('/projects/web/provider-credentials/c1', { key: 'sk-first-123456789abcdef' })
    expect(node(app, 'provider-key-rotate-input-c1')?.props.value).toBe('sk-second-123456789abcdef')
    expect(node(app, 'provider-key-rotate-input-c1')?.props.disabled).toBe(false)
    app.unmount()
  })
  test('B2: a completed rotation still clears the key it submitted', async () => {
    const app = await mountCard(['project.credential.read', 'project.credential.update'])
    ;(node(app, 'provider-key-rotate-input-c1')?.props.onInput as (event: Event) => void)({ target: { value: 'sk-first-123456789abcdef' } } as unknown as Event)
    await (node(app, 'provider-key-rotate-c1')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(node(app, 'provider-key-rotate-input-c1')?.props.value).toBe('')
    app.unmount()
  })
  test('B2: the add form is closed while its write is in flight and keeps a newer draft', async () => {
    let release: (value: unknown) => void = () => undefined
    post.mockImplementationOnce(async () => new Promise((resolve) => { release = resolve }))
    const app = await mountCard()
    for (const [id, value] of [['provider-key-provider', 'openrouter'], ['provider-key-name', 'New key'], ['provider-key-secret', 'sk-live-0123456789abcdef']]) {
      const field = node(app, id)
      const setValue = field?.props['onUpdate:modelValue'] as (value: string) => void
      setValue(value)
    }
    const inFlight = (node(app, 'provider-key-add')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(node(app, 'provider-key-add')?.props.disabled).toBe(true)
    const secret = node(app, 'provider-key-secret')?.props['onUpdate:modelValue'] as (value: string) => void
    secret('sk-next-0123456789abcdef')
    release(row())
    await inFlight
    await flush()
    expect(post).toHaveBeenCalledTimes(1)
    expect(node(app, 'provider-key-secret')?.props.modelValue).toBe('sk-next-0123456789abcdef')
    expect(node(app, 'provider-key-add')?.props.disabled).toBe(false)
    app.unmount()
  })
  test('AC-7: approval response shows pending without adding a credential row', async () => {
    post.mockResolvedValueOnce({ permissionKey: 'project.credential.create', id: 'approval' })
    const app = await mountCard()
    for (const [id, value] of [['provider-key-provider', 'openrouter'], ['provider-key-name', 'New key'], ['provider-key-secret', 'sk-live-0123456789abcdef']]) {
      const field = node(app, id)
      ;(field?.props['onUpdate:modelValue'] as (value: string) => void)(value)
    }
    await (node(app, 'provider-key-add')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(app.text()).toContain('fleet.providerKeys.pending')
    expect(app.text()).not.toContain('openrouter · New key')
    app.unmount()
  })
  test('AC-9: structured write refusal is sent to the app toast', async () => {
    post.mockRejectedValueOnce(new apiModule.ApiError(403, 'Credential write refused'))
    const app = await mountCard()
    for (const [id, value] of [['provider-key-provider', 'openrouter'], ['provider-key-name', 'New key'], ['provider-key-secret', 'sk-live-0123456789abcdef']]) {
      const field = node(app, id)
      ;(field?.props['onUpdate:modelValue'] as (value: string) => void)(value)
    }
    await (node(app, 'provider-key-add')?.props.onClick as () => Promise<void>)()
    await flush()
    expect(toast.errors).toContain('Credential write refused')
    app.unmount()
  })
  test('AC-8: hides add without create permission', async () => {
    const app = await mountCard(['project.credential.read'])
    expect(node(app, 'provider-key-add')).toBeUndefined()
    app.unmount()
  })
  test('project card copy exists in both locales', () => {
    for (const locale of ['en', 'zh']) {
      const messages = JSON.parse(readFileSync(join(__dirname, '../../i18n/locales', `${locale}.json`), 'utf8'))
      expect(messages.fleet.providerKeys.projectTitle).toBeDefined()
      expect(messages.fleet.providerKeys.projectDescription).toBeDefined()
      expect(messages.fleet.providerKeys.noReadPermission).toBeDefined()
      expect(messages.fleet.providerKeys.validation.repoRequired).toBeDefined()
    }
  })
})
