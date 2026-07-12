import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

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
// Timeline AC9 — default layout exposes a /<slug>/timeline link in the
//                  project nav whose label resolves from `nav.timeline`
// ─────────────────────────────────────────────────────────────────────────────

describe('Timeline AC9: default layout has a /<slug>/timeline project nav link', () => {
  test('source contains a NuxtLink targeting /<slug>/timeline', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The link must be rendered by NuxtLink (not just an anchor or text)
    // and must include the project-scoped path.
    const linkMatch = source.match(/<NuxtLink[\s\S]*?\/?\{`\/\$\{projectSlug\}\/timeline`\}[\s\S]*?<\/NuxtLink>/)
      ?? source.match(/<NuxtLink[\s\S]*?\$\{projectSlug\}\/timeline[\s\S]*?<\/NuxtLink>/)
    expect(linkMatch).not.toBeNull()
  })


  test('source uses nav.timeline i18n key for the link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/t\(['"]nav\.timeline['"]\)/)
  })

  test('source places the timeline link inside the project-scoped nav block', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const scopedStart = source.indexOf('projectSlug')
    const scopedEnd = source.indexOf('</template>', scopedStart)
    expect(scopedStart).toBeGreaterThan(-1)
    expect(scopedEnd).toBeGreaterThan(scopedStart)
    const scopedSection = source.slice(scopedStart, scopedEnd)
    expect(scopedSection).toMatch(/\/timeline/)
    expect(scopedSection).toMatch(/nav\.timeline/)
  })

  test('Timeline NuxtLink appears after the KB NuxtLink in the project nav', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const kbIdx = source.indexOf('/kb')
    const timelineIdx = source.indexOf('/timeline')
    // Timeline link must come after KB link in the sidebar order
    expect(kbIdx).toBeGreaterThan(-1)
    expect(timelineIdx).toBeGreaterThan(kbIdx)
  })

  test('Clock icon is imported from lucide-vue-next and rendered inside the timeline NuxtLink', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Clock must be imported from lucide-vue-next in the script
    expect(source).toMatch(/import\s*\{[^}]*\bClock\b[^}]*\}\s*from\s*['"]lucide-vue-next['"]/)

    // Extract the timeline NuxtLink block to verify Clock is used there
    const timelineLink = source.match(/<NuxtLink[\s\S]*?\/timeline[\s\S]*?<\/NuxtLink>/)
    expect(timelineLink).not.toBeNull()
    const linkText = timelineLink?.[0] ?? ''
    expect(linkText).toContain('<Clock')
  })
})

describe('Timeline AC9: nav.timeline present in both en.json and zh.json', () => {
  test('en.json has nav.timeline as a non-empty string', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.timeline).toBeDefined()
    expect(typeof en.nav.timeline).toBe('string')
    expect(en.nav.timeline.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.timeline as a non-empty string', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.timeline).toBeDefined()
    expect(typeof zh.nav.timeline).toBe('string')
    expect(zh.nav.timeline.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral SSR test — render the default layout with a project slug and
// verify the rendered HTML contains the timeline navigation link
// ─────────────────────────────────────────────────────────────────────────────

describe('Timeline AC9 (Behavioral SSR): default layout rendered with project slug contains timeline nav link', () => {
  let layoutTemplate: string

  beforeAll(() => {
    layoutTemplate = extractTemplate(readFileSync(layoutPath, 'utf-8'))
  })

  test('when rendered with projectSlug=acme, the template produces a link targeting /acme/timeline with label nav.timeline', async () => {
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
      route: { path: '/acme/timeline', params: { project: 'acme' } },
      // Sidebar
      sidebarOpen: VueFull.ref(true),
      // projectSlug computed from route.params.project
      projectSlug: 'acme',
      breadcrumbItems: [
        { label: 'Koda', to: '/' },
        { label: 'acme', to: '/acme' },
        { label: 'nav.timeline' },
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
      },
      directives: { show: {} },
    })

    const html = await renderToString(app)

    // Verify a link to /acme/timeline exists
    expect(html).toContain('href="/acme/timeline"')

    // Verify the timeline link label resolves from nav.timeline
    // (the mock t() returns the key itself; the rendered text appears after the icon span)
    expect(html).toMatch(/nav\.timeline\s*<\/a>/)

    // Verify the Clock icon is inside the timeline link
    // Extract just the <a> block for /acme/timeline
    const linkBlock = html.match(/<a href="\/acme\/timeline"[^>]*>[\s\S]*?<\/a>/)
    expect(linkBlock).not.toBeNull()
    // The link must contain the Clock icon stub (rendered as a span)
    const blockText = linkBlock?.[0] ?? ''
    expect(blockText).toContain('<span')
  })
})
