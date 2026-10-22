import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import * as Vue from 'vue'
import * as ts from 'typescript'
import { compileScript, parse } from 'vue/compiler-sfc'
import { webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'
import { permissionSet } from '~/lib/permissions'

/**
 * US-006 AC-7/AC-8/AC-9/AC-12: the admin navigation is gated on permission keys, not on the role
 * name.
 *
 * The layout is rendered for real: its own `<script setup>` is compiled and executed (with the Nuxt
 * globals stubbed, including `useGlobalPermissions`), and the real template is server-rendered with
 * those bindings. So these assertions are on the markup the layout produces for a given global
 * permission set — a layout that still read `auth.user.role` would fail them.
 */
const layoutPath = webFile('layouts', 'default.vue')
const layoutSource = readFileSync(layoutPath, 'utf-8')
const layoutTemplate = layoutSource.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''

/** Every admin link the gate table lists, with the global key it needs. */
const ADMIN_LINKS: ReadonlyArray<readonly [href: string, key: string]> = [
  ['/admin/users', 'user.read'],
  ['/admin/roles', 'role.read'],
  ['/admin/fleet', 'fleet.dashboard.read'],
  ['/admin/fleet/runners', 'fleet.runner.read'],
  ['/admin/fleet/repos', 'fleet.repo.read'],
  ['/admin/fleet/budgets', 'fleet.budget.read'],
  ['/admin/fleet/approvals', 'fleet.approval.read'],
  ['/admin/fleet/analytics', 'fleet.analytics.read'],
  ['/admin/skills', 'skill.source.read'],
]

const ALL_ADMIN_KEYS = ADMIN_LINKS.map(([, key]) => key)

interface SetupOptions {
  keys?: readonly string[]
  role?: string
  /** True while the /me/permissions fetch is outstanding (the set is then the empty one). */
  pending?: boolean
}

/** Runs layouts/default.vue's real setup for one route and returns its template bindings. */
function layoutBindings(options: SetupOptions = {}): Record<string, unknown> {
  const descriptor = parse(layoutSource, { filename: layoutPath }).descriptor
  const script = compileScript(descriptor, { id: 'test' }).content
  const js = ts.transpileModule(
    script.replace(/\bimport\.meta\.server\b/g, 'false').replace(/\bimport\.meta\.client\b/g, 'true'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } },
  ).outputText

  const held = permissionSet(options.keys ?? [])
  const auto = {
    ref: Vue.ref,
    computed: Vue.computed,
    watch: (): undefined => undefined,
    onMounted: (): undefined => undefined,
    onBeforeUnmount: (): undefined => undefined,
    nextTick: (fn?: () => unknown): void => { if (fn) fn() },
    useI18n: () => i18nStub(),
    useAuth: () => ({
      user: { value: { email: 'a@k.t', role: options.role ?? 'MEMBER' } },
      logout: (): undefined => undefined,
    }),
    useRoute: () => ({ path: '/', params: {} }),
    // The real composable reads /me/permissions through useAsyncData; the layout only consumes its
    // `permissions` ref, so a stub whose set is fixed at mount is the honest double here.
    useGlobalPermissions: () => ({
      permissions: Vue.computed(() => (options.pending === true ? permissionSet([]) : held)),
      pending: Vue.ref(options.pending === true),
      error: Vue.ref(null),
      refresh: async (): Promise<void> => undefined,
    }),
  }
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  new Function(
    'require', 'module', 'exports', '__auto',
    'const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useI18n, useAuth, useRoute, useGlobalPermissions } = __auto;\n' + js,
  )(
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
const stub = (tag: string) => ({ name: `Stub${tag}`, render(this: { $slots: { default?: () => unknown } }) { return VueFull.h('div', { 'data-stub': tag }, this.$slots.default?.()) } })

/** Every icon the layout imports from lucide-vue-next, taken from the layout source itself. */
function layoutIconNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!m) throw new Error('no lucide-vue-next import in the layout')
  return (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
}

/** SSR-renders the real layout template with the real script bindings for one global key set. */
function renderLayout(options: SetupOptions = {}): Promise<string> {
  const app = VueFull.createSSRApp({
    template: layoutTemplate,
    // Spread into a fresh object: `<script setup>`'s return value is marked `__isScriptSetup`, which
    // tells the render proxy to skip setup lookups, and a runtime-compiled template needs them.
    setup: () => ({ ...layoutBindings(options) }),
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
  })
  return renderToString(app)
}

/** The primary nav markup (the sidebar's own `<nav>`), where every link must live. */
function primaryNav(html: string): string {
  const nav = /<nav[^>]*id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)
  if (!nav) throw new Error(`no primary nav in the rendered layout: ${html.slice(0, 400)}`)
  return nav[0]
}

const hasLink = (html: string, href: string): boolean => html.includes(`href="${href}"`)

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-7 — one key shows one link
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-7: only the link whose key is held renders', () => {
  test('AC-7: user.read renders /admin/users and no fleet or skills link', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['user.read'] }))

    expect(hasLink(nav, '/admin/users')).toBe(true)
    expect(hasLink(nav, '/admin/fleet')).toBe(false)
    expect(hasLink(nav, '/admin/fleet/runners')).toBe(false)
    expect(hasLink(nav, '/admin/fleet/repos')).toBe(false)
    expect(hasLink(nav, '/admin/fleet/budgets')).toBe(false)
    expect(hasLink(nav, '/admin/fleet/approvals')).toBe(false)
    expect(hasLink(nav, '/admin/fleet/analytics')).toBe(false)
    expect(hasLink(nav, '/admin/skills')).toBe(false)
  })

  test('AC-7 (control): the Admin section label still renders for that one link', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['user.read'] }))

    expect(nav).toContain('nav.sectionAdmin')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-8 — the role name no longer gates anything
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-8: an ADMIN role with no keys renders no admin navigation', () => {
  test('AC-8: none of the gate table links render', async () => {
    const nav = primaryNav(await renderLayout({ role: 'ADMIN', keys: [] }))

    for (const [href] of ADMIN_LINKS) expect(hasLink(nav, href)).toBe(false)
  })

  test('AC-8: the Admin section label does not render either', async () => {
    const nav = primaryNav(await renderLayout({ role: 'ADMIN', keys: [] }))

    expect(nav).not.toContain('nav.sectionAdmin')
  })

  test('AC-8 (control): the rest of the sidebar still renders for that user', async () => {
    const nav = primaryNav(await renderLayout({ role: 'ADMIN', keys: [] }))

    for (const href of ['/', '/agents', '/threads', '/admin/slos']) expect(hasLink(nav, href)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-9 — every fleet key brings back its own link
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-9: the fleet and skills keys each render their link', () => {
  const fleetKeys = ALL_ADMIN_KEYS.filter((key) => key !== 'user.read' && key !== 'role.read')

  test('AC-9: all seven fleet/skills links render without user.read', async () => {
    const nav = primaryNav(await renderLayout({ keys: fleetKeys }))

    expect(hasLink(nav, '/admin/fleet')).toBe(true)
    expect(hasLink(nav, '/admin/fleet/runners')).toBe(true)
    expect(hasLink(nav, '/admin/fleet/repos')).toBe(true)
    expect(hasLink(nav, '/admin/fleet/budgets')).toBe(true)
    expect(hasLink(nav, '/admin/fleet/approvals')).toBe(true)
    expect(hasLink(nav, '/admin/fleet/analytics')).toBe(true)
    expect(hasLink(nav, '/admin/skills')).toBe(true)
    expect(hasLink(nav, '/admin/users')).toBe(false)
    expect(hasLink(nav, '/admin/roles')).toBe(false)
  })

  test('AC-9 (edge): a single fleet key renders only its own link', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['fleet.repo.read'] }))

    expect(hasLink(nav, '/admin/fleet/repos')).toBe(true)
    expect(hasLink(nav, '/admin/fleet')).toBe(false)
    expect(hasLink(nav, '/admin/fleet/runners')).toBe(false)
    expect(hasLink(nav, '/admin/skills')).toBe(false)
  })

  test('AC-9: the redesign source order survives — overview before runners, skills last', async () => {
    const nav = primaryNav(await renderLayout({ keys: ALL_ADMIN_KEYS }))

    expect(nav.indexOf('href="/admin/users"')).toBeLessThan(nav.indexOf('href="/admin/fleet"'))
    expect(nav.indexOf('href="/admin/fleet"')).toBeLessThan(nav.indexOf('href="/admin/fleet/runners"'))
    expect(nav.indexOf('href="/admin/fleet/analytics"')).toBeLessThan(nav.indexOf('href="/admin/skills"'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-12 — a pending fetch leaves every control hidden
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-12: a pending global fetch renders no admin navigation', () => {
  test('AC-12: while the fetch is outstanding the links and the label stay hidden', async () => {
    const nav = primaryNav(await renderLayout({ keys: ALL_ADMIN_KEYS, pending: true }))

    for (const [href] of ADMIN_LINKS) expect(hasLink(nav, href)).toBe(false)
    expect(nav).not.toContain('nav.sectionAdmin')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-010 AC-12 — role.read alone shows the Roles link
// ─────────────────────────────────────────────────────────────────────────────

describe('US-010 AC-12: /admin/roles follows the global role.read key', () => {
  test('AC-12: role.read alone renders /admin/roles and the Admin section label, and no other admin link', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['role.read'] }))

    expect(hasLink(nav, '/admin/roles')).toBe(true)
    expect(nav).toContain('nav.sectionAdmin')
    for (const [href] of ADMIN_LINKS) if (href !== '/admin/roles') expect(hasLink(nav, href)).toBe(false)
  })

  test('AC-12: without role.read there is no /admin/roles link, whatever else is held', async () => {
    const nav = primaryNav(await renderLayout({ keys: ALL_ADMIN_KEYS.filter((key) => key !== 'role.read') }))

    expect(hasLink(nav, '/admin/roles')).toBe(false)
    expect(hasLink(nav, '/admin/users')).toBe(true)
  })

  test('AC-12: the Roles link sits after Users and before the fleet links', async () => {
    const nav = primaryNav(await renderLayout({ keys: ALL_ADMIN_KEYS }))

    expect(nav.indexOf('href="/admin/users"')).toBeLessThan(nav.indexOf('href="/admin/roles"'))
    expect(nav.indexOf('href="/admin/roles"')).toBeLessThan(nav.indexOf('href="/admin/fleet"'))
  })
})
