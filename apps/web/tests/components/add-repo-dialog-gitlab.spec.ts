import { beforeAll, describe, expect, test, jest } from '@jest/globals'
import { dirname } from 'node:path'
import enLocale from '../../i18n/locales/en.json'
import zhLocale from '../../i18n/locales/zh.json'
import type { FleetRepo } from '../../lib/fleet-types'

/**
 * The GitLab form fields are a user-submission path, so they are exercised in a real DOM: the
 * dialog is mounted with Vue's runtime renderer inside jsdom, fields are typed into and the form
 * is submitted through `requestSubmit()` — the browser's own submit entry point. The fake-renderer
 * harness cannot do this: its FormField stub hands every slot an inert `componentField`.
 *
 * Vue's runtime-dom captures `document` when it is first imported, so the jsdom globals below have
 * to exist before Vue (and with it the mount helper) is loaded — the helper is imported lazily in
 * `beforeAll` instead of at the top of the file.
 */
const idpEntry = require.resolve('isomorphic-dompurify')
const jsdomEntry = require.resolve('jsdom', { paths: [dirname(idpEntry)] })
// Jest replaces `Module.createRequire`, so a require built that way loads jsdom through Jest's own
// module registry — which cannot parse jsdom's ESM-only dependencies. Node's real loader is used
// instead, so jsdom and its dependencies stay outside the registry.
const nodeLoader = require('module').Module as unknown as { _load: (id: string, parent: unknown, isMain: boolean) => unknown }
const { JSDOM } = nodeLoader._load(jsdomEntry, null, false) as {
  JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis }
}
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'navigator']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}

type MountHelpers = typeof import('../helpers/mount-sfc')
let helpers!: MountHelpers
let Vue!: typeof import('vue')

beforeAll(async () => {
  helpers = await import('../helpers/mount-sfc')
  Vue = await import('vue')
})

const humanWarning = (locale: Record<string, unknown>): string =>
  ((locale as { fleet: { repos: { gitlab: { humanWarning: string } } } }).fleet.repos.gitlab.humanWarning)
const tokensRequired = (locale: Record<string, unknown>): string =>
  ((locale as { fleet: { repos: { gitlab: { tokensRequired: string } } } }).fleet.repos.gitlab.tokensRequired)

interface Api {
  get: jest.Mock
  post: jest.Mock
  delete: jest.Mock
}

const createdRepo = (over: Partial<FleetRepo> = {}): FleetRepo => ({
  id: 'r9', projectId: 'p1', provider: 'gitlab', owner: 'acme', name: 'app', host: 'https://gitlab.example.com',
  defaultBranch: 'main', githubInstallationId: null, autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '0.0000',
  autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null,
  fixTrustDetectedChecks: false, fixAllowUnprotected: false, ruleOverride: null, gitlab: null, createdAt: '', ...over,
})

function mount(api: Api) {
  const toasts = { successes: [] as string[], errors: [] as string[], success: (m: string) => toasts.successes.push(m), error: (m: string) => toasts.errors.push(m) }
  /** Every `update:open` emit the dialog fired, in order (a real app has no `emitted()`). */
  const closes: unknown[][] = []
  const component = helpers.loadSfc(helpers.webFile('components', 'fleet', 'AddRepoDialog.vue'), {
    useI18n: () => {
      const lookup = (key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enLocale)
      const t = (key: string, named: Record<string, unknown> = {}): string => {
        const value = lookup(key)
        if (typeof value !== 'string') return key
        return value.replace(/\{(\w+)\}/g, (match, name: string) => (name in named ? String(named[name]) : match))
      }
      return { t, te: (key: string) => lookup(key) !== undefined }
    },
    useAppToast: () => toasts,
    useApi: () => ({ $api: api }),
    useFleetRepos: () => ({ create: async (input: NewFleetRepoInput) => {
      const created = await api.post('/fleet/repos', input)
      return created as FleetRepo
    } }),
  }, { '~/composables/useFleetRepos': { useFleetRepos: () => ({}) } })
  const h = Vue.h
  const app = Vue.createApp(component, {
    open: true, projects: [{ id: 'p1', slug: 'koda', name: 'Koda' }],
    'onUpdate:open': (value: boolean) => closes.push([value]),
  })
  // The real form components, so vee-validate's FormField binds the inputs it wraps. FormItem,
  // FormControl and FormLabel are template-only SFCs the harness cannot compile; inline equivalents
  // render the same tree.
  app.component('FormField', helpers.loadSfc(helpers.webFile('components', 'ui', 'form', 'FormField.vue'), {}, {}) as never)
  app.component('FormMessage', helpers.loadSfc(helpers.webFile('components', 'ui', 'form', 'FormMessage.vue'), {}, {}) as never)
  app.component('FormItem', { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', attrs, slots.default?.()) } })
  app.component('FormControl', { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', attrs, slots.default?.()) } })
  app.component('FormLabel', { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('label', attrs, slots.default?.()) } })
  app.component('FleetNativeSelect', helpers.loadSfc(helpers.webFile('components', 'fleet', 'NativeSelect.vue'), {}, {}) as never)
  app.component('Input', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: { modelValue: string }, { attrs, emit }) { return () => h('input', { ...attrs, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }) } })
  app.component('Button', { inheritAttrs: false, props: ['disabled'], setup(props: { disabled?: boolean }, { attrs, slots }) { return () => h('button', { disabled: props.disabled, type: 'button', ...attrs }, slots.default?.()) } })
  app.component('Dialog', { inheritAttrs: false, props: ['open'], emits: ['update:open'], setup(_props: unknown, { slots, attrs }) { return () => h('div', { ...attrs, 'data-stub': 'dialog' }, slots.default?.()) } })
  for (const name of ['DialogContent', 'DialogHeader', 'DialogTitle']) app.component(name, { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', attrs, slots.default?.()) } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  app.mount(container)
  return { app, container, toasts, closes }
}
type NewFleetRepoInput = { projectSlug: string; provider: 'github' | 'gitlab'; owner: string; name: string; host?: string; readToken?: string; writeToken?: string; confirmBotAccount?: boolean }

/** Lets the schema validation and the re-render that follows it settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    await Vue.nextTick()
  }
}

function apiMock(): Api {
  return { get: jest.fn(), post: jest.fn(async () => createdRepo()), delete: jest.fn() }
}

function formEl(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form')
  if (!form) throw new Error('no form rendered')
  return form
}

/** Types into the nth text input; the order is owner, name, host (the token inputs are password fields). */
function typeText(container: HTMLElement, index: number, value: string): void {
  const inputs = [...container.querySelectorAll('input')].filter((el) => (el as HTMLInputElement).type !== 'password' && (el as HTMLInputElement).type !== 'checkbox')
  const input = inputs[index] as HTMLInputElement | undefined
  if (!input) throw new Error(`no text input at ${index}`)
  input.value = value
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function typeToken(container: HTMLElement, index: number, value: string): void {
  const input = container.querySelectorAll('input[type="password"]')[index] as HTMLInputElement | undefined
  if (!input) throw new Error(`no password input at ${index}`)
  input.value = value
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function chooseProvider(container: HTMLElement, value: 'github' | 'gitlab'): void {
  const select = container.querySelector('select[data-testid="fleet-repo-provider"]') as HTMLSelectElement | null
  if (!select) throw new Error('no provider select')
  select.value = value
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

function chooseProject(container: HTMLElement): void {
  const select = container.querySelector('select[data-testid="fleet-repo-project"]') as HTMLSelectElement | null
  if (!select) throw new Error('no project select')
  select.value = 'koda'
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

describe('AddRepoDialog GitLab registration', () => {
  test('AC-1: provider gitlab shows host, read token, write token and bot inputs; github hides them', async () => {
    const { container, app } = mount(apiMock())
    await settle()

    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(container.querySelector('input[data-testid="fleet-repo-host"]')).toBeNull()
    expect(container.querySelector('input[data-testid="fleet-repo-bot"]')).toBeNull()

    chooseProvider(container, 'gitlab')
    await settle()

    expect(container.querySelector('input[data-testid="fleet-repo-host"]')).not.toBeNull()
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(2)
    expect(container.querySelector('input[data-testid="fleet-repo-bot"]')).not.toBeNull()

    chooseProvider(container, 'github')
    await settle()

    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(container.querySelector('input[data-testid="fleet-repo-host"]')).toBeNull()
    app.unmount()
  })

  test('AC-2: a GitLab submit posts host, readToken, writeToken and confirmBotAccount', async () => {
    const api = apiMock()
    const { container, app } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeText(container, 2, 'https://gitlab.example.com')
    typeToken(container, 0, 'glpat-read')
    typeToken(container, 1, 'glpat-write')
    const checkbox = container.querySelector('input[data-testid="fleet-repo-bot"]') as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await settle()

    formEl(container).requestSubmit()
    await settle()

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post.mock.calls[0]?.[1]).toEqual({
      projectSlug: 'koda', provider: 'gitlab', owner: 'acme', name: 'app',
      host: 'https://gitlab.example.com', readToken: 'glpat-read', writeToken: 'glpat-write', confirmBotAccount: true,
    })
    app.unmount()
  })

  test('AC-2: an empty host is left out of the body', async () => {
    const api = apiMock()
    const { container, app } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeToken(container, 0, 'glpat-read')
    typeToken(container, 1, 'glpat-write')
    await settle()

    formEl(container).requestSubmit()
    await settle()

    const body = api.post.mock.calls[0]?.[1] as Record<string, unknown>
    expect('host' in body).toBe(false)
    expect(body).toEqual({ projectSlug: 'koda', provider: 'gitlab', owner: 'acme', name: 'app', readToken: 'glpat-read', writeToken: 'glpat-write', confirmBotAccount: false })
    app.unmount()
  })

  test('AC-3: an empty write token blocks the submit with tokensRequired', async () => {
    const api = apiMock()
    const { container, app } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeToken(container, 0, 'glpat-read')
    await settle()

    formEl(container).requestSubmit()
    await settle()

    expect(api.post).not.toHaveBeenCalled()
    expect(container.textContent ?? '').toContain(tokensRequired(enLocale))
    app.unmount()
  })

  test('AC-3: an empty read token blocks the submit with tokensRequired', async () => {
    const api = apiMock()
    const { container, app } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeToken(container, 1, 'glpat-write')
    await settle()

    formEl(container).requestSubmit()
    await settle()

    expect(api.post).not.toHaveBeenCalled()
    expect(container.textContent ?? '').toContain(tokensRequired(enLocale))
    app.unmount()
  })

  test('AC-4: a create whose write token is a human account keeps the dialog open with the warning', async () => {
    const api = apiMock()
    api.post = jest.fn(async () => createdRepo({
      gitlab: {
        projectId: 42,
        readToken: { username: 'jane', expiresAt: null, status: 'ok' },
        writeToken: { username: 'jane', expiresAt: null, status: 'ok', isBot: false },
        warnings: ['write_token_human'],
      },
    }))
    const { container, app } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeToken(container, 0, 'glpat-read')
    typeToken(container, 1, 'glpat-write')
    await settle()

    formEl(container).requestSubmit()
    await settle()

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(container.textContent ?? '').toContain(humanWarning(enLocale).replace('{username}', 'jane'))
    app.unmount()
  })

  test('AC-4: the warning survives only until the admin closes the dialog, which resets the draft', async () => {
    const api = apiMock()
    api.post = jest.fn(async () => createdRepo({
      gitlab: {
        projectId: 42,
        readToken: { username: 'jane', expiresAt: null, status: 'ok' },
        writeToken: { username: 'jane', expiresAt: null, status: 'ok', isBot: false },
        warnings: ['write_token_human'],
      },
    }))
    const { container, app, closes } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeToken(container, 0, 'glpat-read')
    typeToken(container, 1, 'glpat-write')
    await settle()

    formEl(container).requestSubmit()
    await settle()
    expect(closes).toEqual([])

    const done = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Done')
    expect(done).toBeDefined()
    done?.click()
    await settle()

    expect(closes).toEqual([[false]])
    app.unmount()
  })

  test('AC-4: a bot write token closes the dialog as before, without any warning', async () => {
    const api = apiMock()
    api.post = jest.fn(async () => createdRepo({
      gitlab: {
        projectId: 42,
        readToken: { username: 'koda-bot', expiresAt: null, status: 'ok' },
        writeToken: { username: 'koda-bot', expiresAt: null, status: 'ok', isBot: true },
        warnings: [],
      },
    }))
    const { container, app, closes } = mount(api)
    await settle()

    chooseProvider(container, 'gitlab')
    await settle()
    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    typeToken(container, 0, 'glpat-read')
    typeToken(container, 1, 'glpat-write')
    await settle()

    formEl(container).requestSubmit()
    await settle()

    // A bot account carries no warning, so the dialog closes exactly as it did before GitLab.
    expect(closes.at(-1)).toEqual([false])
    expect(container.textContent ?? '').not.toContain('Fleet jobs will act as this user')
    app.unmount()
  })

  test('AC-12: a GitHub submit sends exactly the four existing fields', async () => {
    const api = apiMock()
    const { container, app } = mount(api)
    await settle()

    chooseProject(container)
    typeText(container, 0, 'acme')
    typeText(container, 1, 'app')
    await settle()

    formEl(container).requestSubmit()
    await settle()

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post.mock.calls[0]?.[1]).toEqual({ projectSlug: 'koda', provider: 'github', owner: 'acme', name: 'app' })
    app.unmount()
  })

  test('AC-10: the gitlab form and warning keys are non-empty in en and zh', () => {
    for (const locale of [enLocale, zhLocale]) {
      const gitlab = (locale as { fleet: { repos: { gitlab: Record<string, unknown> } } }).fleet.repos.gitlab
      for (const key of ['host', 'hostPlaceholder', 'hostHint', 'readToken', 'writeToken', 'confirmBot', 'tokensRequired', 'humanWarning', 'humanBadge', 'none', 'done', 'rotate']) {
        expect(String(gitlab[key] ?? '').trim()).not.toBe('')
      }
      for (const key of ['ok', 'invalid', 'expiring']) expect(String((gitlab.status as Record<string, string>)[key] ?? '').trim()).not.toBe('')
      for (const key of ['title', 'hint', 'readToken', 'writeToken', 'confirmBot', 'save', 'saving', 'pending']) {
        expect(String((gitlab.dialog as Record<string, string>)[key] ?? '').trim()).not.toBe('')
      }
    }
  })
})
