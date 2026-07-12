import { describe, test, expect, beforeAll } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// Vue (full build with template compiler) so renderToString works in Node
// without a browser DOM — same pattern as tests/layouts/timeline-nav.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VueFull = require('vue/dist/vue.cjs.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToString } = require('vue/server-renderer')

function extractTemplate(sfcSource: string): string {
  const m = sfcSource.match(/<template>([\s\S]*)<\/template>/)
  if (!m) throw new Error('No template found')
  return m[1]
}

function stubDiv(tag: string): VueFull.Component {
  return {
    name: `Stub${tag}`,
    render() { return VueFull.h('div', { class: `stub-${tag.toLowerCase()}` }, this.$slots.default?.()) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — Default layout renders a project-nav link to /<slug>/memory with the
//        `nav.memory` label when the route carries a project slug.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC9 (Behavioral SSR): default layout renders /<slug>/memory project nav link', () => {
  let layoutTemplate: string

  beforeAll(() => {
    layoutTemplate = extractTemplate(readFileSync(layoutPath, 'utf-8'))
  })

  test('rendering with projectSlug=acme produces a link targeting /acme/memory with label nav.memory', async () => {
    const ctx = {
      // i18n
      t: (key: string) => key,
      // Auth
      auth: {
        user: { value: { email: 'test@example.com' } },
        logout: () => {},
        token: { value: 'fake-token' },
      },
      // Route
      route: { path: '/acme/memory', params: { project: 'acme' } },
      // Sidebar
      sidebarOpen: { value: true },
      // projectSlug computed from route.params.project
      projectSlug: 'acme',
      // breadcrumbItems / backTo are computed; provide stub values matching
      // the structure the template expects so the v-if guards work.
      breadcrumbItems: [
        { label: 'Koda', to: '/' },
        { label: 'acme', to: '/acme' },
        { label: 'nav.memory' },
      ],
      backTo: '/acme',
      navLinkClass: 'nav-link',
      activeClass: 'active',
    }

    const app = VueFull.createSSRApp({
      template: layoutTemplate,
      setup: () => ctx,
      components: {
        // Stub NuxtLink as a plain <a> that renders the `to` prop as href
        NuxtLink: {
          name: 'NuxtLink',
          props: { to: [String, Object] },
          render(this: { $props: { to: string }; $slots: { default?: () => VueFull.VNode[] } }) {
            return VueFull.h('a', { href: String(this.$props.to) }, this.$slots.default?.())
          },
        },
        Button: stubDiv('Button'),
        BackButton: stubDiv('BackButton'),
        AppBreadcrumb: stubDiv('AppBreadcrumb'),
        LanguageSwitcher: stubDiv('LanguageSwitcher'),
        ThemeSwitcher: stubDiv('ThemeSwitcher'),
        // Icon stubs
        LayoutDashboard: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Kanban: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Bot: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Tag: { render() { return VueFull.h('span', { class: 'icon' }) } },
        BookOpen: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Clock: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Brain: { render() { return VueFull.h('span', { class: 'icon' }) } },
      },
      directives: { show: {} },
    })

    const html = await renderToString(app)

    // Verify a link to /acme/memory exists
    expect(html).toContain('href="/acme/memory"')

    // Verify the memory link label is the resolved nav.memory i18n key.
    // The mock t() returns the key itself.
    const linkBlock = html.match(/<a href="\/acme\/memory"[^>]*>[\s\S]*?<\/a>/)
    expect(linkBlock).not.toBeNull()
    expect(linkBlock?.[0]).toContain('nav.memory')

    // Verify the Brain icon is inside the memory link (the icon stub
    // renders as <span class="icon h-4 w-4 shrink-0">).
    expect(linkBlock?.[0]).toMatch(/class="icon/)
  })

  test('rendering with a different project slug produces a different memory href', async () => {
    const ctx = {
      t: (key: string) => key,
      auth: {
        user: { value: { email: 'test@example.com' } },
        logout: () => {},
        token: { value: 'fake-token' },
      },
      route: { path: '/other-project/memory', params: { project: 'other-project' } },
      sidebarOpen: { value: true },
      projectSlug: 'other-project',
      breadcrumbItems: [
        { label: 'Koda', to: '/' },
        { label: 'other-project', to: '/other-project' },
        { label: 'nav.memory' },
      ],
      backTo: '/other-project',
      navLinkClass: 'nav-link',
      activeClass: 'active',
    }

    const app = VueFull.createSSRApp({
      template: layoutTemplate,
      setup: () => ctx,
      components: {
        NuxtLink: {
          name: 'NuxtLink',
          props: { to: [String, Object] },
          render(this: { $props: { to: string }; $slots: { default?: () => VueFull.VNode[] } }) {
            return VueFull.h('a', { href: String(this.$props.to) }, this.$slots.default?.())
          },
        },
        Button: stubDiv('Button'),
        BackButton: stubDiv('BackButton'),
        AppBreadcrumb: stubDiv('AppBreadcrumb'),
        LanguageSwitcher: stubDiv('LanguageSwitcher'),
        ThemeSwitcher: stubDiv('ThemeSwitcher'),
        LayoutDashboard: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Kanban: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Bot: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Tag: { render() { return VueFull.h('span', { class: 'icon' }) } },
        BookOpen: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Clock: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Brain: { render() { return VueFull.h('span', { class: 'icon' }) } },
      },
      directives: { show: {} },
    })

    const html = await renderToString(app)

    expect(html).toContain('href="/other-project/memory"')
    expect(html).not.toContain('href="/acme/memory"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// i18n — nav.memory key present in BOTH locales
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC9 i18n: en.json has nav.memory', () => {
  test('en.json has nav.memory as a non-empty string', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.memory).toBeDefined()
    expect(typeof en.nav.memory).toBe('string')
    expect(en.nav.memory.length).toBeGreaterThan(0)
  })
})

describe('US-004 AC9 i18n: zh.json has nav.memory (parity)', () => {
  test('zh.json has nav.memory as a non-empty string', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.memory).toBeDefined()
    expect(typeof zh.nav.memory).toBe('string')
    expect(zh.nav.memory.length).toBeGreaterThan(0)
  })
})
