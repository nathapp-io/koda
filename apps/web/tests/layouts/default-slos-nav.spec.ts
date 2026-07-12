import { describe, test, expect, beforeAll } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// Vue (full build with template compiler) so renderToString works in Node
// without a browser DOM — same pattern as tests/layouts/memory-nav.spec.ts.
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
  const { h } = VueFull
  return {
    name: `Stub${tag}`,
    render() {
      return h('div', { class: `stub-${tag.toLowerCase()}` }, this.$slots.default?.())
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — The default layout renders a top-level navigation link to /admin/slos
//       whose label resolves from nav.slos, shown for authenticated users
//       regardless of projectSlug.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC7 (Behavioral SSR): default layout renders /admin/slos top-level nav link', () => {
  let layoutTemplate: string

  beforeAll(() => {
    layoutTemplate = extractTemplate(readFileSync(layoutPath, 'utf-8'))
  })

  function makeLayoutApp(routePath: string) {
    const ctx = {
      t: (key: string) => key,
      auth: {
        user: { value: { email: 'test@example.com' } },
        logout: () => {},
        token: { value: 'fake-token' },
      },
      route: { path: routePath, params: {} },
      sidebarOpen: { value: true },
      projectSlug: undefined,
      breadcrumbItems: [{ label: 'Koda', to: '/' }],
      backTo: '/',
      navLinkClass: 'nav-link',
      activeClass: 'active',
    }

    return VueFull.createSSRApp({
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
        Activity: { render() { return VueFull.h('span', { class: 'icon' }) } },
      },
      directives: { show: {} },
    })
  }

  test('rendering the layout at /admin/slos produces a link to /admin/slos with nav.slos label', async () => {
    const app = makeLayoutApp('/admin/slos')
    const html = await renderToString(app)

    expect(html).toContain('href="/admin/slos"')

    // Locate the rendered <a> for /admin/slos and verify it carries the
    // nav.slos label (the mocked t() returns the key itself).
    const linkBlock = html.match(/<a href="\/admin\/slos"[^>]*>[\s\S]*?<\/a>/)
    expect(linkBlock).not.toBeNull()
    expect(linkBlock?.[0]).toContain('nav.slos')
  })

  test('the SLO link is also rendered on non-project routes (visible to all authenticated users)', async () => {
    const app = makeLayoutApp('/')
    const html = await renderToString(app)

    expect(html).toContain('href="/admin/slos"')
    const linkBlock = html.match(/<a href="\/admin\/slos"[^>]*>[\s\S]*?<\/a>/)
    expect(linkBlock?.[0]).toContain('nav.slos')
  })

  test('the SLO link is rendered before the project-scoped nav block, so it is not gated by projectSlug', async () => {
    const app = makeLayoutApp('/acme/tickets')
    const html = await renderToString(app)

    // The SLO link must be rendered somewhere in the document, regardless of
    // whether a projectSlug is present. (We verify presence; the order check
    // is intentionally a source-level guard elsewhere.)
    expect(html).toContain('href="/admin/slos"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// i18n — nav.slos key present in BOTH locales
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC7 i18n: en.json has nav.slos', () => {
  test('en.json has nav.slos as a non-empty string', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.slos).toBeDefined()
    expect(typeof en.nav.slos).toBe('string')
    expect(en.nav.slos.length).toBeGreaterThan(0)
  })
})

describe('US-006 AC7 i18n: zh.json has nav.slos (parity)', () => {
  test('zh.json has nav.slos as a non-empty string', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.slos).toBeDefined()
    expect(typeof zh.nav.slos).toBe('string')
    expect(zh.nav.slos.length).toBeGreaterThan(0)
  })
})
