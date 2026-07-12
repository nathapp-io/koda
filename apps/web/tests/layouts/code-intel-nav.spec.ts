import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')

const VueFull = require('vue/dist/vue.cjs.js')
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
// Behavioral SSR test — render the default layout with a project slug and
// verify the rendered HTML contains the code-intel navigation link
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC7 (Behavioral SSR): default layout rendered with project slug contains code-intel nav link', () => {
  let layoutTemplate: string

  beforeAll(() => {
    layoutTemplate = extractTemplate(readFileSync(layoutPath, 'utf-8'))
  })

  test('when rendered with projectSlug=acme, the template produces a link targeting /acme/code-intel with label nav.codeIntel', async () => {
    const ctx = {
      // i18n
      t: (key: string) => key,
      // Auth
      auth: {
        user: VueFull.ref({ email: 'test@example.com' }),
        logout: () => {},
        token: VueFull.ref('fake-token'),
      },
      // Route
      route: { path: '/acme/code-intel', params: { project: 'acme' } },
      // Sidebar
      sidebarOpen: VueFull.ref(true),
      // projectSlug computed from route.params.project
      projectSlug: 'acme',
      breadcrumbItems: [
        { label: 'Koda', to: '/' },
        { label: 'acme', to: '/acme' },
        { label: 'nav.codeIntel' },
      ],
      backTo: '/acme',
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
        // Icon stubs (match the lucide-vue-next imports in default.vue)
        LayoutDashboard: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Kanban: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Bot: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Tag: { render() { return VueFull.h('span', { class: 'icon' }) } },
        BookOpen: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Clock: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Brain: { render() { return VueFull.h('span', { class: 'icon' }) } },
        Code2: { render() { return VueFull.h('span', { class: 'icon' }) } },
      },
      directives: { show: {} },
    })

    const html = await renderToString(app)

    // Verify a link to /acme/code-intel exists
    expect(html).toContain('href="/acme/code-intel"')

    // Verify the code-intel link label resolves from nav.codeIntel
    // (the mock t() returns the key itself; the rendered text appears after the icon span)
    expect(html).toMatch(/nav\.codeIntel\s*<\/a>/)

    // Verify the Code2 icon is inside the code-intel link
    const linkBlock = html.match(/<a href="\/acme\/code-intel"[^>]*>[\s\S]*?<\/a>/)
    expect(linkBlock).not.toBeNull()
    const blockText = linkBlock?.[0] ?? ''
    expect(blockText).toContain('<span')
  })

  test('different project slug (other-project) produces a link to /other-project/code-intel', async () => {
    const ctx = {
      t: (key: string) => key,
      auth: {
        user: VueFull.ref({ email: 'test@example.com' }),
        logout: () => {},
        token: VueFull.ref('fake-token'),
      },
      route: { path: '/other-project/code-intel', params: { project: 'other-project' } },
      sidebarOpen: VueFull.ref(true),
      projectSlug: 'other-project',
      breadcrumbItems: [],
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
        Code2: { render() { return VueFull.h('span', { class: 'icon' }) } },
      },
      directives: { show: {} },
    })

    const html = await renderToString(app)

    expect(html).toContain('href="/other-project/code-intel"')
    expect(html).not.toContain('href="/acme/code-intel"')
  })
})
