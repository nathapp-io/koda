import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import * as Vue from 'vue'
import * as ts from 'typescript'
import { compileScript, parse } from 'vue/compiler-sfc'
import { webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'

const layoutPath = webFile('layouts', 'default.vue')
const layoutSource = readFileSync(layoutPath, 'utf-8')
const layoutTemplate = layoutSource.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''

// ─────────────────────────────────────────────────────────────────────────────
// AC3 / AC4 — breadcrumbItems resolves the thread paths. The computed lives in
// the layout's <script setup>, so the real SFC script is compiled and its setup
// run with stubbed Nuxt globals — the same "evaluate the real page code"
// approach as tests/pages/code-intel-mount.spec.ts. Without inlineTemplate the
// compiler emits `setup() { ...; return __returned__ }`, which hands back the
// template bindings (including the breadcrumbItems computed).
// ─────────────────────────────────────────────────────────────────────────────

interface Crumb {
  label: string
  to?: string
}

/** Runs layouts/default.vue's real setup for one route and returns breadcrumbItems.value. */
function breadcrumbItemsFor(path: string, params: Record<string, string>): Crumb[] {
  const descriptor = parse(layoutSource, { filename: layoutPath }).descriptor
  const script = compileScript(descriptor, { id: 'test' }).content
  const js = ts.transpileModule(
    script.replace(/\bimport\.meta\.server\b/g, 'false').replace(/\bimport\.meta\.client\b/g, 'true'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } },
  ).outputText

  const auto = {
    ref: Vue.ref,
    computed: Vue.computed,
    watch: () => undefined,
    onMounted: () => undefined,
    onBeforeUnmount: () => undefined,
    nextTick: (fn?: () => unknown) => { if (fn) fn() },
    useI18n: () => i18nStub(),
    useAuth: () => ({ user: { value: { email: 'a@k.t', role: 'MEMBER' } }, logout: () => undefined }),
    useRoute: () => ({ path, params }),
  }
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  new Function('require', 'module', 'exports', '__auto', 'const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useI18n, useAuth, useRoute } = __auto;\n' + js)(
    (id: string) => (id === 'lucide-vue-next' ? {} : require(id)),
    mod,
    mod.exports,
    auto,
  ) as unknown
  const Component = mod.exports.default as { setup: (props: unknown, ctx: unknown) => Record<string, unknown> }
  const bindings = Component.setup.call(null, {}, { expose: () => undefined, attrs: {}, slots: {}, emit: () => undefined })
  return (bindings.breadcrumbItems as { value: Crumb[] }).value
}

describe('US-004 AC3/AC4: breadcrumbItems for the thread routes', () => {
  test('AC3: /web/threads is Koda, web, then the nav.threads label without a link', () => {
    const crumbs = breadcrumbItemsFor('/web/threads', { project: 'web' })

    expect(crumbs).toEqual([
      { label: 'Koda', to: '/' },
      { label: 'web', to: '/web' },
      { label: 'nav.threads' },
    ])
  })

  test('AC4: /web/threads/th1 is Koda, web, nav.threads linked to /web/threads, then the detail title', () => {
    const crumbs = breadcrumbItemsFor('/web/threads/th1', { project: 'web', id: 'th1' })

    expect(crumbs).toEqual([
      { label: 'Koda', to: '/' },
      { label: 'web', to: '/web' },
      { label: 'nav.threads', to: '/web/threads' },
      { label: 'fleet.threads.detail.title' },
    ])
  })

  test('AC3/AC4 (control): a non-thread project path still resolves its own crumb, untouched', () => {
    const crumbs = breadcrumbItemsFor('/web/labels', { project: 'web' })

    expect(crumbs).toEqual([
      { label: 'Koda', to: '/' },
      { label: 'web', to: '/web' },
      { label: 'nav.labels' },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — the project WORK section sidebar link. Behavioral SSR of the layout
// template, the same pattern as tests/layouts/project-agents-nav.spec.ts:
// render the real template with a stubbed setup and assert on the rendered HTML.
// ─────────────────────────────────────────────────────────────────────────────

const VueFull = require('vue/dist/vue.cjs.js')
const { renderToString } = require('vue/server-renderer')

const icon = { render() { return VueFull.h('span', { class: 'icon' }) } }
const stub = (tag: string) => ({ name: `Stub${tag}`, render() { return VueFull.h('div', {}, this.$slots.default?.()) } })

/** Every icon the layout imports from lucide-vue-next, taken from the layout source itself. */
function layoutIconNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!m) throw new Error('no lucide-vue-next import in the layout')
  return (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
}

function renderProjectLayout(projectSlug: string | undefined): Promise<string> {
  const app = VueFull.createSSRApp({
    template: layoutTemplate,
    setup: () => ({
      t: (key: string) => key,
      auth: { user: { value: { email: 'a@k.t', role: 'MEMBER' } }, logout: () => undefined, token: { value: 't' } },
      route: { path: projectSlug ? `/${projectSlug}/threads` : '/', params: projectSlug ? { project: projectSlug } : {} },
      sidebarOpen: { value: true },
      projectSlug,
      breadcrumbItems: [],
      backTo: projectSlug ? `/${projectSlug}` : '/',
      navLinkClass: 'nav-link',
      activeClass: 'active',
      isGlobalAdmin: false,
    }),
    components: {
      NuxtLink: {
        name: 'NuxtLink',
        props: { to: [String, Object] },
        render(this: { $props: { to: string }; $slots: { default?: () => unknown } }) {
          return VueFull.h('a', { href: String(this.$props.to) }, this.$slots.default?.())
        },
      },
      Button: stub('Button'), BackButton: stub('BackButton'), AppBreadcrumb: stub('AppBreadcrumb'),
      LanguageSwitcher: stub('LanguageSwitcher'), ThemeSwitcher: stub('ThemeSwitcher'),
      NotificationBell: stub('NotificationBell'), FleetApprovalBadge: stub('FleetApprovalBadge'),
      CommandPalette: stub('CommandPalette'),
      ...Object.fromEntries(layoutIconNames(layoutSource).map((name) => [name, icon])),
    },
    directives: { show: {} },
  })
  return renderToString(app)
}

describe('US-004 AC1: the project WORK section sidebar link to the threads list', () => {
  test('AC1: rendering with project slug web produces a link to /web/threads', async () => {
    const html = await renderProjectLayout('web')

    expect(html).toContain('href="/web/threads"')
  })

  test('AC1: the /web/threads link sits after the /web/agents link and before the Knowledge section label', async () => {
    const html = await renderProjectLayout('web')

    const agents = html.indexOf('href="/web/agents"')
    const threads = html.indexOf('href="/web/threads"')
    const knowledge = html.indexOf('nav.sectionKnowledge')
    expect(agents).toBeGreaterThan(-1)
    expect(knowledge).toBeGreaterThan(-1)
    expect(threads).toBeGreaterThan(agents)
    expect(threads).toBeLessThan(knowledge)
  })

  test('AC1 (control): without a project context no project threads link renders', async () => {
    const html = await renderProjectLayout(undefined)

    expect(html).not.toContain('href="/web/threads"')
  })
})