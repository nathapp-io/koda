import { beforeAll, describe, expect, test, jest } from '@jest/globals'
import { dirname } from 'node:path'
import enLocale from '../../i18n/locales/en.json'
import zhLocale from '../../i18n/locales/zh.json'
import type { FleetRepo } from '../../lib/fleet-types'

/**
 * The rotation dialog is a user-submission path, so it is exercised in a real DOM (see
 * flow-answer-form.spec.ts for the recipe): jsdom globals go in before Vue loads, and the form is
 * submitted through `requestSubmit()`. The tokens are typed into real inputs, so the body sent to
 * the PATCH route is exactly what the admin filled in.
 */
const idpEntry = require.resolve('isomorphic-dompurify')
const jsdomEntry = require.resolve('jsdom', { paths: [dirname(idpEntry)] })
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

const tokensRequired = (locale: Record<string, unknown>): string =>
  ((locale as { fleet: { repos: { gitlab: { tokensRequired: string } } } }).fleet.repos.gitlab.tokensRequired)

const repo = (over: Partial<FleetRepo> = {}): FleetRepo => ({
  id: 'r1', projectId: 'p', provider: 'gitlab', owner: 'org', name: 'repo', host: 'https://gitlab.example.com',
  defaultBranch: 'main', githubInstallationId: null, autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null,
  fixTrustDetectedChecks: false, fixAllowUnprotected: false, ruleOverride: null, gitlab: null, createdAt: '', ...over,
})

const savedRepo = (over: Partial<FleetRepo> = {}): FleetRepo => repo({
  gitlab: {
    projectId: 42,
    readToken: { username: 'koda-bot', expiresAt: null, status: 'ok' },
    writeToken: { username: 'koda-bot', expiresAt: null, status: 'ok', isBot: true },
    warnings: [],
  },
  ...over,
})

function mount(options: { permitted?: boolean; saved?: FleetRepo; pending?: boolean; reject?: unknown } = {}) {
  const rotate = jest.fn(async () => {
    if (options.reject) throw options.reject
    if (options.pending) return { id: 'ap1', permissionKey: 'fleet.repo.credentials.update' }
    return options.saved ?? savedRepo()
  })
  const emits: unknown[][] = []
  const component = helpers.loadSfc(helpers.webFile('components', 'fleet', 'RepoGitlabCredentialsDialog.vue'), {
    useI18n: () => {
      const lookup = (key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enLocale)
      const t = (key: string, named: Record<string, unknown> = {}): string => {
        const value = lookup(key)
        if (typeof value !== 'string') return key
        return value.replace(/\{(\w+)\}/g, (match, name: string) => (name in named ? String(named[name]) : match))
      }
      return { t, te: (key: string) => lookup(key) !== undefined }
    },
    useGlobalPermissions: () => ({ permissions: Vue.computed(() => ({ has: () => options.permitted ?? true })) }),
    useApi: () => ({}),
  }, { '~/composables/useFleetRepos': { useFleetRepos: () => ({ rotateGitlabCredentials: rotate }) } })
  const h = Vue.h
  // The dialog is self-triggering (like RepoRuleOverrideDialog): its Rotate tokens button opens it.
  const app = Vue.createApp(component, {
    repo: repo(),
    'onSaved': (updated: FleetRepo) => emits.push(['saved', updated]),
  })
  // The real form components; FormItem/FormControl/FormLabel are template-only, so inline stubs.
  app.component('FormField', helpers.loadSfc(helpers.webFile('components', 'ui', 'form', 'FormField.vue'), {}, {}) as never)
  app.component('FormMessage', helpers.loadSfc(helpers.webFile('components', 'ui', 'form', 'FormMessage.vue'), {}, {}) as never)
  app.component('FormItem', { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', attrs, slots.default?.()) } })
  app.component('FormControl', { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', attrs, slots.default?.()) } })
  app.component('FormLabel', { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('label', attrs, slots.default?.()) } })
  app.component('Input', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: { modelValue: string }, { attrs, emit }) { return () => h('input', { ...attrs, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }) } })
  app.component('Button', { inheritAttrs: false, props: ['disabled'], setup(props: { disabled?: boolean }, { attrs, slots }) { return () => h('button', { disabled: props.disabled, type: 'button', ...attrs }, slots.default?.()) } })
  app.component('Dialog', { inheritAttrs: false, props: ['open'], setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', { ...attrs, 'data-stub': 'dialog' }, slots.default?.()) } })
  for (const name of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) app.component(name, { inheritAttrs: false, setup(_p: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) { return () => h('div', attrs, slots.default?.()) } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  app.mount(container)
  return { app, container, rotate, emits }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    await Vue.nextTick()
  }
}

function formEl(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form')
  if (!form) throw new Error('no form rendered')
  return form
}

function openDialog(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Rotate tokens')
  if (!trigger) throw new Error('no Rotate tokens trigger')
  trigger.click()
}

function typeToken(container: HTMLElement, index: number, value: string): void {
  const input = container.querySelectorAll('input[type="password"]')[index] as HTMLInputElement | undefined
  if (!input) throw new Error(`no password input at ${index}`)
  input.value = value
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function checkBot(container: HTMLElement): void {
  const input = container.querySelector('input[data-testid="fleet-repo-rotate-bot"]') as HTMLInputElement | null
  if (!input) throw new Error('no bot checkbox')
  input.checked = true
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

describe('RepoGitlabCredentialsDialog', () => {
  test('AC-7: submitting only a new write token patches the rotation route with only writeToken', async () => {
    const { container, rotate, emits } = mount()
    await settle()
    openDialog(container)
    await settle()

    typeToken(container, 1, 'glpat-new-write')
    await settle()
    formEl(container).requestSubmit()
    await settle()

    expect(rotate).toHaveBeenCalledTimes(1)
    expect(rotate.mock.calls[0]?.[0]).toBe('r1')
    expect(rotate.mock.calls[0]?.[1]).toEqual({ writeToken: 'glpat-new-write' })
    // A successful save emits the updated repo; the dialog closes itself.
    expect(emits).toEqual([['saved', savedRepo()]])
  })

  test('AC-7: a read token and the bot confirmation are sent only when supplied', async () => {
    const { container, rotate } = mount()
    await settle()
    openDialog(container)
    await settle()

    typeToken(container, 0, 'glpat-new-read')
    checkBot(container)
    await settle()
    formEl(container).requestSubmit()
    await settle()

    expect(rotate.mock.calls[0]?.[1]).toEqual({ readToken: 'glpat-new-read', confirmBotAccount: true })
  })

  test('an empty body is refused client-side with tokensRequired, without a request', async () => {
    const { container, rotate } = mount()
    await settle()
    openDialog(container)
    await settle()

    formEl(container).requestSubmit()
    await settle()

    expect(rotate).not.toHaveBeenCalled()
    expect(container.textContent ?? '').toContain(tokensRequired(enLocale))
  })

  test('AC-9: a refused rotation shows the extracted API error and keeps the dialog open', async () => {
    const { container, rotate, emits } = mount({ reject: new Error('denied by policy') })
    await settle()
    openDialog(container)
    await settle()

    typeToken(container, 1, 'glpat-new-write')
    await settle()
    formEl(container).requestSubmit()
    await settle()

    expect(rotate).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('denied by policy')
    // No saved, no close: the admin keeps their input.
    expect(emits).toEqual([])
    expect(container.querySelector('form')).not.toBeNull()
  })

  test('a pending approval shows the pending notice without emitting saved', async () => {
    const { container, emits } = mount({ pending: true })
    await settle()
    openDialog(container)
    await settle()

    typeToken(container, 1, 'glpat-new-write')
    await settle()
    formEl(container).requestSubmit()
    await settle()

    expect(container.textContent ?? '').toContain('Approval is pending')
    expect(emits).toEqual([])
  })

  test('without the permission the save is disabled', async () => {
    const { container } = mount({ permitted: false })
    await settle()
    openDialog(container)
    await settle()

    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement | undefined
    expect(save?.disabled).toBe(true)
  })

  test('AC-10: the rotation keys are non-empty in en and zh', () => {
    for (const locale of [enLocale, zhLocale]) {
      const dialog = (locale as { fleet: { repos: { gitlab: { dialog: Record<string, string> } } } }).fleet.repos.gitlab.dialog
      for (const key of ['title', 'hint', 'readToken', 'writeToken', 'confirmBot', 'save', 'saving', 'pending']) {
        expect(String(dialog[key] ?? '').trim()).not.toBe('')
      }
      expect(String((locale as { fleet: { repos: { gitlab: { rotate: string } } } }).fleet.repos.gitlab.rotate).trim()).not.toBe('')
    }
  })
})
