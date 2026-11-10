import { beforeAll, describe, expect, test, jest } from '@jest/globals'
import { dirname } from 'node:path'
import enLocale from '../../i18n/locales/en.json'
import zhLocale from '../../i18n/locales/zh.json'

const jsdomEntry = require.resolve('jsdom', { paths: [dirname(require.resolve('isomorphic-dompurify'))] })
const nodeLoader = require('module').Module as unknown as { _load: (id: string, parent: unknown, isMain: boolean) => unknown }
const { JSDOM } = nodeLoader._load(jsdomEntry, null, false) as { JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis } }
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'navigator']) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
type Helpers = typeof import('../helpers/mount-sfc')
let helpers: Helpers
let Vue: typeof import('vue')
beforeAll(async () => { helpers = await import('../helpers/mount-sfc'); Vue = await import('vue') })
const repo = { id: 'r1', projectId: 'p', provider: 'gitlab' as const, owner: 'org', name: 'repo', defaultBranch: 'main', githubInstallationId: null, autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null, fixTrustDetectedChecks: false, fixAllowUnprotected: false, ruleOverride: { sha256: 'a'.repeat(64), ruleFiles: 2, rulesMode: 'merge' as const, contextMode: null, updatedAt: '' }, createdAt: '' }
const override = { rules: [{ path: 'api.md', content: 'body' }], rulesMode: 'merge' as const, context: null, sha256: 'a'.repeat(64), updatedAt: '' }
function mount(options: { allowed?: boolean; result?: unknown; reject?: Error } = {}) {
  const getRuleOverride = jest.fn(async () => override)
  const setRuleOverride = jest.fn(async () => { if (options.reject) throw options.reject; return options.result ?? { kind: 'saved', repo } })
  const clearRuleOverride = jest.fn()
  const component = helpers.loadSfc(helpers.webFile('components', 'fleet', 'RepoRuleOverrideDialog.vue'), { useI18n: () => ({ t: (key: string, values?: { files?: number }) => values?.files !== undefined ? `${key} ${values.files}` : key }), useGlobalPermissions: () => ({ permissions: Vue.computed(() => ({ has: () => options.allowed ?? true })) }) }, { '~/composables/useApi': { extractApiError: (err: unknown) => err instanceof Error ? err.message : 'error' }, '~/composables/useFleetRepos': { useFleetRepos: () => ({ getRuleOverride, setRuleOverride, clearRuleOverride }) } })
  const h = Vue.h
  const app = Vue.createApp(component, { repo })
  app.component('Button', { inheritAttrs: false, props: ['disabled'], setup(props, { attrs, slots }) { return () => h('button', { ...attrs, disabled: props.disabled }, slots.default?.()) } })
  const model = (tag: string) => ({ props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup(props: { modelValue: string; disabled: boolean }, { emit, attrs }: { emit: (event: string, value: string) => void; attrs: Record<string, unknown> }) { return () => h(tag, { ...attrs, disabled: props.disabled, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }) } })
  app.component('Input', model('input')); app.component('Textarea', model('textarea'))
  const container = dom.window.document.createElement('div'); dom.window.document.body.appendChild(container); app.mount(container)
  return { app, container, getRuleOverride, setRuleOverride, clearRuleOverride }
}
async function settle(): Promise<void> { await Vue.nextTick(); await new Promise((resolve) => setTimeout(resolve, 0)); await Vue.nextTick() }
function click(container: HTMLElement, text: string): void { const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text)); if (!button) throw new Error(`button not found: ${text}`); button.click() }
function input(container: HTMLElement, label: string, value: string, index = 0): void { const controls = container.querySelectorAll(`[aria-label="${label}"]`); const control = controls[index] as HTMLInputElement | HTMLTextAreaElement | undefined; if (!control) throw new Error(`control not found: ${label} at ${index}`); control.value = value; control.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }

describe('FleetRepoRuleOverrideDialog', () => {
  test('dialog and job summary translations are non-empty in both locales', () => {
    for (const locale of [enLocale, zhLocale]) {
      const fleet = (locale as { fleet: { repos: { ruleOverride: Record<string, string> }; jobs: { ruleOverride: { summary: string } } } }).fleet
      for (const key of ['open', 'openEmpty', 'title', 'path', 'content', 'remove', 'addFile', 'rulesMode', 'context', 'contextMode', 'save', 'clear', 'close', 'pending']) expect(fleet.repos.ruleOverride[key]?.trim()).toBeTruthy()
      expect(fleet.jobs.ruleOverride.summary.trim()).toBeTruthy()
    }
  })
  test('shows count, loads override files, and gets the repo id', async () => { const x = mount(); expect(x.container.textContent).toContain('fleet.repos.ruleOverride.open 2'); click(x.container, 'fleet.repos.ruleOverride.open'); await settle(); expect(x.getRuleOverride).toHaveBeenCalledWith('r1'); expect((x.container.querySelector('input') as HTMLInputElement).value).toBe('api.md'); expect((x.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('body'); x.app.unmount() })
  test('disables all editable controls and Save/Clear without global configure permission', async () => { const x = mount({ allowed: false }); click(x.container, 'fleet.repos.ruleOverride.open'); await settle(); expect([...x.container.querySelectorAll('input,textarea,select')].every((el) => (el as HTMLInputElement).disabled)).toBe(true); for (const label of ['fleet.repos.ruleOverride.save', 'fleet.repos.ruleOverride.clear']) expect([...x.container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))?.disabled).toBe(true); x.app.unmount() })
  test('adds and saves a rule and serializes empty context as null', async () => { const x = mount(); click(x.container, 'fleet.repos.ruleOverride.open'); await settle(); click(x.container, 'fleet.repos.ruleOverride.addFile'); await settle(); input(x.container, 'fleet.repos.ruleOverride.path', 'web.md', 1); input(x.container, 'fleet.repos.ruleOverride.content', 'w', 1); await settle(); click(x.container, 'fleet.repos.ruleOverride.save'); await settle(); expect(x.setRuleOverride).toHaveBeenCalledWith('r1', expect.objectContaining({ rules: expect.arrayContaining([{ path: 'web.md', content: 'w' }]), context: null })); expect((x.setRuleOverride.mock.calls[0]?.[1] as { rules: Array<{ path: string; content: string }> }).rules.at(-1)).toEqual({ path: 'web.md', content: 'w' }); x.app.unmount() })
  test('saves context with replace mode', async () => { const x = mount(); click(x.container, 'fleet.repos.ruleOverride.open'); await settle(); const context = x.container.querySelectorAll('textarea')[1] as HTMLTextAreaElement; context.value = 'c'; context.dispatchEvent(new dom.window.Event('input', { bubbles: true })); const selects = x.container.querySelectorAll('select'); (selects[1] as HTMLSelectElement).value = 'replace'; selects[1]?.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle(); click(x.container, 'fleet.repos.ruleOverride.save'); await settle(); expect(x.setRuleOverride).toHaveBeenCalledWith('r1', expect.objectContaining({ context: { content: 'c', mode: 'replace' } })); x.app.unmount() })
  test('shows pending response and extracted save error', async () => { const pending = mount({ result: { kind: 'pending', request: { id: 'ap1' } } }); click(pending.container, 'fleet.repos.ruleOverride.open'); await settle(); click(pending.container, 'fleet.repos.ruleOverride.save'); await settle(); expect(pending.container.textContent).toContain('fleet.repos.ruleOverride.pending'); pending.app.unmount(); const failed = mount({ reject: new Error('save denied') }); click(failed.container, 'fleet.repos.ruleOverride.open'); await settle(); click(failed.container, 'fleet.repos.ruleOverride.save'); await settle(); expect(failed.container.querySelector('[role="alert"]')?.textContent).toBe('save denied'); failed.app.unmount() })
})
