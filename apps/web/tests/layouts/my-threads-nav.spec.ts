import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import * as Vue from 'vue'
import * as ts from 'typescript'
import { compileScript, parse } from 'vue/compiler-sfc'
import { webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'

/**
 * US-005 AC-12/AC-13 (fleet S5b 1d): the `My threads` sidebar link.
 *
 * The layout is rendered for real: its own `<script setup>` is compiled and executed (with the Nuxt
 * globals stubbed to the same shape `tests/layouts/threads-nav.spec.ts` uses), and the real template
 * is server-rendered with those bindings. So the assertions are on the markup the layout produces,
 * not on a hand-written template copy.
 */
const layoutPath = webFile('layouts', 'default.vue')
const layoutSource = readFileSync(layoutPath, 'utf-8')
const layoutTemplate = layoutSource.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''

/** Runs layouts/default.vue's real setup for one route and returns its template bindings. */
function layoutBindings(path: string, params: Record<string, string>): Record<string, unknown> {
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
  return Component.setup.call(null, {}, { expose: () => undefined, attrs: {}, slots: {}, emit: () => undefined })
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VueFull = require('vue/dist/vue.cjs.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderToString } = require('vue/server-renderer')

const icon = { render() { return VueFull.h('span', { class: 'icon' }) } }
const stub = (tag: string) => ({ name: `Stub${tag}`, render() { return VueFull.h('div', { 'data-stub': tag }, this.$slots.default?.()) } })

/** Every icon the layout imports from lucide-vue-next, taken from the layout source itself. */
function layoutIconNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!m) throw new Error('no lucide-vue-next import in the layout')
  return (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
}

/** SSR-renders the real layout template with the real script bindings for one route. */
function renderLayout(path: string, params: Record<string, string>): Promise<string> {
  const app = VueFull.createSSRApp({
    template: layoutTemplate,
    // The bindings are spread into a fresh object on purpose: `<script setup>`'s return value is
    // marked `__isScriptSetup`, which tells the render proxy to skip setup lookups (the compiled
    // SFC template reads the bindings directly). A runtime-compiled template reads `_ctx.t`, so the
    // marker must not survive.
    setup: () => ({ ...layoutBindings(path, params) }),
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

/** The primary nav markup (the sidebar's own `<nav>`), where the link must live. */
function primaryNav(html: string): string {
  const nav = /<nav[^>]*id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)
  if (!nav) throw new Error(`no primary nav in the rendered layout: ${html.slice(0, 400)}`)
  return nav[0]
}

/** The visible text of the first anchor pointing at `href` (tags stripped). */
function anchorText(html: string, href: string): string | undefined {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<a[^>]*href="${escaped}"[^>]*>([\\s\\S]*?)</a>`).exec(html)
  return match ? match[1].replace(/<[^>]*>/g, '').trim() : undefined
}

describe('US-005 AC-12/AC-13: the My threads sidebar link', () => {
  test('AC-12: with no project in the route /threads is labelled nav.myThreads and follows /agents', async () => {
    const html = await renderLayout('/threads', {})
    const nav = primaryNav(html)

    expect(anchorText(nav, '/threads')).toBe('nav.myThreads')
    const agentsAt = nav.indexOf('href="/agents"')
    const myThreadsAt = nav.indexOf('href="/threads"')
    expect(agentsAt).toBeGreaterThan(-1)
    expect(myThreadsAt).toBeGreaterThan(agentsAt)
  })

  test('AC-12 (edge): with no project in the route the standard destinations are untouched', async () => {
    const nav = primaryNav(await renderLayout('/threads', {}))

    for (const href of ['/', '/agents', '/admin/slos']) {
      expect(nav).toContain(`href="${href}"`)
    }
    expect(nav).not.toContain('href="/web/threads"')
    expect(nav).not.toContain('Koda')
  })

  test('AC-13: with project web in the route the /threads link is still rendered', async () => {
    const nav = primaryNav(await renderLayout('/web', { project: 'web' }))

    expect(anchorText(nav, '/threads')).toBe('nav.myThreads')
    expect(nav).toContain('href="/web/threads"')
  })

  test('AC-12 (control): the AC-12 route renders no project block', async () => {
    const nav = primaryNav(await renderLayout('/threads', {}))

    expect(nav).toContain('nav.sectionWorkspace')
    expect(nav).not.toContain('>nav.sectionWork<')
  })
})
