import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import * as Vue from 'vue'
import * as ts from 'typescript'
import { compileScript, parse } from 'vue/compiler-sfc'
import { webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'
import { adminNavFlags, globalPermissionsStub } from '../helpers/permission-nav'

const layoutPath = webFile('layouts', 'default.vue')
const layoutSource = readFileSync(layoutPath, 'utf-8')
const layoutTemplate = layoutSource.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
interface Crumb { label: string; to?: string }

function breadcrumbItemsFor(path: string, params: Record<string, string>): Crumb[] {
  const script = compileScript(parse(layoutSource, { filename: layoutPath }).descriptor, { id: 'flows-test' }).content
  const js = ts.transpileModule(script.replace(/\bimport\.meta\.server\b/g, 'false').replace(/\bimport\.meta\.client\b/g, 'true'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const auto = {
    ref: Vue.ref, computed: Vue.computed, watch: () => undefined, onMounted: () => undefined, onBeforeUnmount: () => undefined,
    nextTick: (fn?: () => unknown) => { if (fn) fn() }, useI18n: () => i18nStub(),
    useAuth: () => ({ user: { value: { email: 'a@k.t', role: 'MEMBER' } }, logout: () => undefined }),
    useRoute: () => ({ path, params }), useGlobalPermissions: () => globalPermissionsStub(),
  }
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  new Function('require', 'module', 'exports', '__auto', 'const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useI18n, useAuth, useRoute, useGlobalPermissions } = __auto;\n' + js)(
    (id: string) => id === 'lucide-vue-next' ? {} : require(id), mod, mod.exports, auto,
  )
  const component = mod.exports.default as { setup: (props: unknown, ctx: unknown) => Record<string, unknown> }
  const bindings = component.setup({}, { expose: () => undefined, attrs: {}, slots: {}, emit: () => undefined })
  return (bindings.breadcrumbItems as { value: Crumb[] }).value
}

const VueFull = require('vue/dist/vue.cjs.js')
const { renderToString } = require('vue/server-renderer')
const icon = { render() { return VueFull.h('span', { class: 'icon' }) } }
const stub = (tag: string) => ({ name: `Stub${tag}`, render() { return VueFull.h('div', {}, this.$slots.default?.()) } })
function iconNames(): string[] {
  const match = layoutSource.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!match) throw new Error('no lucide-vue-next import in the layout')
  return (match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean)
}
function renderProjectLayout(projectSlug: string | undefined): Promise<string> {
  const app = VueFull.createSSRApp({
    template: layoutTemplate,
    setup: () => ({ t: (key: string) => key, auth: { user: { value: { email: 'a@k.t' } }, logout: () => undefined, token: { value: 't' } },
      route: { path: projectSlug ? `/${projectSlug}/flows` : '/', params: projectSlug ? { project: projectSlug } : {} }, sidebarOpen: { value: true },
      projectSlug, breadcrumbItems: [], backTo: projectSlug ? `/${projectSlug}` : '/', navLinkClass: 'nav-link', activeClass: 'active', ...adminNavFlags([]) }),
    components: { NuxtLink: { name: 'NuxtLink', props: { to: [String, Object] }, render(this: { $props: { to: string }; $slots: { default?: () => unknown } }) { return VueFull.h('a', { href: String(this.$props.to) }, this.$slots.default?.()) } },
      Button: stub('Button'), BackButton: stub('BackButton'), AppBreadcrumb: stub('AppBreadcrumb'), LanguageSwitcher: stub('LanguageSwitcher'), ThemeSwitcher: stub('ThemeSwitcher'),
      NotificationBell: stub('NotificationBell'), FleetApprovalBadge: stub('FleetApprovalBadge'), CommandPalette: stub('CommandPalette'),
      ...Object.fromEntries(iconNames().map((name) => [name, icon])) }, directives: { show: {} },
  })
  return renderToString(app)
}

describe('US-012 flows navigation and breadcrumbs', () => {
  test('AC-1: flows list breadcrumbs are Koda, project, and nav.flows', () => {
    expect(breadcrumbItemsFor('/web/flows', { project: 'web' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.flows' },
    ])
  })
  test('AC-2: flow detail breadcrumbs link the flows list then show the detail title', () => {
    expect(breadcrumbItemsFor('/web/flows/f1', { project: 'web', id: 'f1' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.flows', to: '/web/flows' },
      { label: 'fleet.flows.detail.title' },
    ])
  })
  test('AC-3: project flows link renders after Threads', async () => {
    const html = await renderProjectLayout('web')
    const threads = html.indexOf('href="/web/threads"')
    const flows = html.indexOf('href="/web/flows"')
    expect(threads).toBeGreaterThan(-1)
    expect(flows).toBeGreaterThan(threads)
    expect(html).toContain('nav.flows')
  })
  test('AC-4: no project flow link renders without project context', async () => {
    expect(await renderProjectLayout(undefined)).not.toContain('href="/web/flows"')
  })
  test('AC-5: labels breadcrumbs remain unchanged', () => {
    expect(breadcrumbItemsFor('/web/labels', { project: 'web' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.labels' },
    ])
  })
  test('AC-6: thread detail breadcrumbs remain unchanged', () => {
    expect(breadcrumbItemsFor('/web/threads/th1', { project: 'web', id: 'th1' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.threads', to: '/web/threads' },
      { label: 'fleet.threads.detail.title' },
    ])
  })
})
