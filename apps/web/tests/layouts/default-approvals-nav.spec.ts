import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import * as Vue from 'vue'
import * as ts from 'typescript'
import { compileScript, parse } from 'vue/compiler-sfc'
import { loadSfc, webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'
import { globalPermissionsStub, projectPermissionsStub } from '../helpers/permission-nav'

/**
 * P3b US-006 AC-7/AC-10/AC-15: the sidebar's engine destinations.
 *
 * The layout is rendered for real: its own `<script setup>` is compiled and executed (with the Nuxt
 * globals stubbed, including `useGlobalPermissions`), and the real template is server-rendered with
 * those bindings. So the assertions are on the markup the layout produces for a given global key set,
 * not on a hand-written template copy.
 *
 * `ProjectApprovalNavLinks` lives in a child because `useProjectPermissions(slug)` takes a fixed slug;
 * AC-15 is the seam: the layout hands the route's slug to that child, and the child's links follow it.
 */
const layoutPath = webFile('layouts', 'default.vue')
const layoutSource = readFileSync(layoutPath, 'utf-8')
const layoutTemplate = layoutSource.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
const childPath = webFile('components', 'approvals', 'ProjectApprovalNavLinks.vue')

interface SetupOptions {
  keys?: readonly string[]
  path?: string
  params?: Record<string, string>
  /** True while the /me/permissions fetch is outstanding: every gate must fail closed. */
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

  const auto = {
    ref: Vue.ref,
    computed: Vue.computed,
    watch: (): undefined => undefined,
    onMounted: (): undefined => undefined,
    onBeforeUnmount: (): undefined => undefined,
    nextTick: (fn?: () => unknown): void => { if (fn) fn() },
    useI18n: () => i18nStub(),
    useAuth: () => ({
      user: { value: { email: 'a@k.t', role: 'MEMBER' } },
      logout: (): undefined => undefined,
    }),
    useRoute: () => ({ path: options.path ?? '/', params: options.params ?? {} }),
    useGlobalPermissions: () => globalPermissionsStub(options.keys ?? [], options.pending === true),
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
const stub = (tag: string) => ({
  name: `Stub${tag}`,
  render(this: { $slots: { default?: () => unknown } }) { return VueFull.h('div', { 'data-stub': tag }, this.$slots.default?.()) },
})

/** Every icon the layout imports from lucide-vue-next, taken from the layout source itself. */
function layoutIconNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!m) throw new Error('no lucide-vue-next import in the layout')
  return (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
}

/** Renders the layout's two real project links; lucide is ESM-only, so the icons are inert spans. */
const childIcons = new Proxy({}, { get: () => ({ name: 'ChildIcon', render: () => VueFull.h('span', { class: 'icon' }) }) })

/** The real `components/approvals/ProjectApprovalNavLinks.vue`, given the keys its project answers. */
function realNavLinks(projectKeys: readonly string[]): unknown {
  return loadSfc(childPath, {
    useI18n: () => i18nStub(),
    useProjectPermissions: () => projectPermissionsStub(projectKeys),
  }, { 'lucide-vue-next': childIcons })
}

/**
 * A stub that records the props the layout handed it, so the seam is asserted on the prop itself
 * rather than on whatever the child renders from it.
 */
const recordingNavLinks = {
  name: 'RecordingApprovalsProjectApprovalNavLinks',
  props: { slug: { type: String, required: true } },
  setup(props: { slug: string }) {
    return () => VueFull.h('div', { 'data-stub': 'project-approval-nav-links', 'data-slug': props.slug })
  },
}

/** SSR-renders the real layout template with the real script bindings for one global key set. */
function renderLayout(options: SetupOptions & { navLinks?: unknown } = {}): Promise<string> {
  const app = VueFull.createSSRApp({
    template: layoutTemplate,
    // Spread into a fresh object: `<script setup>`'s return value is marked `__isScriptSetup`, which
    // tells the render proxy to skip setup lookups, and a runtime-compiled template needs them.
    setup: () => ({ ...layoutBindings(options) }),
    components: {
      Button: stub('Button'), BackButton: stub('BackButton'), AppBreadcrumb: stub('AppBreadcrumb'),
      LanguageSwitcher: stub('LanguageSwitcher'), ThemeSwitcher: stub('ThemeSwitcher'),
      NotificationBell: stub('NotificationBell'), FleetApprovalBadge: stub('FleetApprovalBadge'),
      CommandPalette: stub('CommandPalette'),
      ...Object.fromEntries(layoutIconNames(layoutSource).map((name) => [name, icon])),
    },
  })
  // Globally registered on purpose: a child component resolves names against the app's registry, not
  // against the layout's own `components` option — which is exactly the seam AC-15 renders through.
  app.component('NuxtLink', {
    name: 'NuxtLink',
    props: { to: [String, Object] },
    render(this: { $props: { to: string }; $slots: { default?: () => unknown } }) {
      return VueFull.h('a', { href: String(this.$props.to) }, this.$slots.default?.())
    },
  })
  app.component('ApprovalsProjectApprovalNavLinks', options.navLinks ?? recordingNavLinks)
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
// AC-7 — the global inbox link follows the global decide keys
// ─────────────────────────────────────────────────────────────────────────────

describe('us-006 AC-7: /approvals follows the global mayDecide()', () => {
  test('AC-7: approval.decide renders the global inbox link, labelled nav.approvals', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['approval.decide'] }))

    expect(hasLink(nav, '/approvals')).toBe(true)
    const link = /<a href="\/approvals"[^>]*>([\s\S]*?)<\/a>/.exec(nav)?.[0]
    expect(link).toContain('nav.approvals')
  })

  test('AC-7: a narrowed decide key is a decide key', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['approval.decide@label.create'] }))

    expect(hasLink(nav, '/approvals')).toBe(true)
  })

  test('AC-7 (control): no decide key renders no /approvals link', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['user.read', 'approval.policy.manage'] }))

    expect(hasLink(nav, '/approvals')).toBe(false)
  })

  test('AC-7 (edge): a pending key read keeps the link hidden (fail closed)', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['approval.decide'], pending: true }))

    expect(hasLink(nav, '/approvals')).toBe(false)
  })

  test('AC-7: the link sits right after My threads', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['approval.decide'] }))

    expect(nav.indexOf('href="/threads"')).toBeGreaterThan(-1)
    expect(nav.indexOf('href="/approvals"')).toBeGreaterThan(nav.indexOf('href="/threads"'))
    expect(nav.indexOf('href="/approvals"')).toBeLessThan(nav.indexOf('href="/admin/slos"'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 — the admin policy link follows approval.policy.manage
// ─────────────────────────────────────────────────────────────────────────────

describe('us-006 AC-10: /admin/approval-policies follows the global approval.policy.manage', () => {
  test('AC-10: that key alone renders the link, its label and the Admin section', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['approval.policy.manage'] }))

    expect(hasLink(nav, '/admin/approval-policies')).toBe(true)
    const link = /<a href="\/admin\/approval-policies"[^>]*>([\s\S]*?)<\/a>/.exec(nav)?.[0]
    expect(link).toContain('nav.approvalPolicies')
    expect(nav).toContain('nav.sectionAdmin')
  })

  test('AC-10 (control): without the key there is no link, whatever else is held', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['user.read', 'role.read', 'approval.decide'] }))

    expect(hasLink(nav, '/admin/approval-policies')).toBe(false)
  })

  test('AC-10 (edge): a pending key read hides the link and the section label', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['approval.policy.manage'], pending: true }))

    expect(hasLink(nav, '/admin/approval-policies')).toBe(false)
    expect(nav).not.toContain('nav.sectionAdmin')
  })

  test('AC-10: the link sits after Roles and before the fleet links', async () => {
    const nav = primaryNav(await renderLayout({ keys: ['user.read', 'role.read', 'approval.policy.manage', 'fleet.dashboard.read'] }))

    expect(nav.indexOf('href="/admin/roles"')).toBeLessThan(nav.indexOf('href="/admin/approval-policies"'))
    expect(nav.indexOf('href="/admin/approval-policies"')).toBeLessThan(nav.indexOf('href="/admin/fleet"'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-15 — the layout hands the route's slug to ProjectApprovalNavLinks
// ─────────────────────────────────────────────────────────────────────────────

describe('us-006 AC-15: the project block mounts ApprovalsProjectApprovalNavLinks with the route slug', () => {
  test('AC-15: on /sandbox the child receives slug: sandbox', async () => {
    const html = await renderLayout({ path: '/sandbox', params: { project: 'sandbox' } })

    const mounted = /data-stub="project-approval-nav-links" data-slug="([^"]*)"/.exec(html)
    expect(mounted?.[1]).toBe('sandbox')
  })

  test('AC-15 (seam): the real child renders its two links for that project', async () => {
    const nav = primaryNav(await renderLayout({
      path: '/sandbox',
      params: { project: 'sandbox' },
      navLinks: realNavLinks(['approval.decide', 'approval.policy.read']),
    }))

    expect(hasLink(nav, '/sandbox/approvals')).toBe(true)
    expect(hasLink(nav, '/sandbox/approval-policies')).toBe(true)
  })

  test('AC-15 (seam, control): without a project route the child is not mounted at all', async () => {
    const html = await renderLayout({ path: '/agents', navLinks: realNavLinks(['approval.decide']) })

    expect(html).not.toContain('data-stub="project-approval-nav-links"')
    expect(html).not.toContain('href="/sandbox/approvals"')
  })
})
