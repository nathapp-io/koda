import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const layout = readFileSync(join(__dirname, '../..', 'layouts', 'default.vue'), 'utf-8')
const template = layout.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
const projectBlockStart = template.indexOf('<template v-if="projectSlug">')
const projectLinks = template.slice(projectBlockStart, template.indexOf('</template>', projectBlockStart))

const VueFull = require('vue/dist/vue.cjs.js')
const { renderToString } = require('vue/server-renderer')

function stubDiv(tag: string): VueFull.Component {
  return {
    name: `Stub${tag}`,
    render() { return VueFull.h('div', { class: `stub-${tag.toLowerCase()}` }, this.$slots.default?.()) },
  }
}

function iconStub(): VueFull.Component {
  return { render() { return VueFull.h('span', { class: 'icon' }) } }
}

function render(ctx: Record<string, unknown>) {
  // Bindings the template reads but the tests do not vary.
  const bindings = { isGlobalAdmin: false, sectionLabelClass: 'section-label', paletteOpen: false, ...ctx }
  return VueFull.createSSRApp({
    template,
    setup: () => bindings,
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
      NotificationBell: stubDiv('NotificationBell'),
      FleetApprovalBadge: stubDiv('FleetApprovalBadge'),
      CommandPalette: stubDiv('CommandPalette'),
      LayoutDashboard: iconStub(),
      Kanban: iconStub(),
      Bot: iconStub(),
      Tag: iconStub(),
      BookOpen: iconStub(),
      Clock: iconStub(),
      Brain: iconStub(),
      Code2: iconStub(),
      Activity: iconStub(),
      Users: iconStub(),
      Server: iconStub(),
      FolderGit2: iconStub(),
      Rocket: iconStub(),
      Wallet: iconStub(),
      Inbox: iconStub(),
      BarChart3: iconStub(),
      Gauge: iconStub(),
      Settings: iconStub(),
      Search: iconStub(),
      Menu: iconStub(),
    },
    directives: { show: {} },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #252 — the project agents roster has no entry point in the UI
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #252: project agents nav link in the sidebar project block', () => {
  test('the project block links to /:project/agents with the Bot icon and nav.agents', () => {
    expect(projectLinks).toContain(':to="`/${projectSlug}/agents`"')
    expect(projectLinks).toMatch(/<Bot class="h-4 w-4 shrink-0" \/>\s*\{\{ t\('nav\.agents'\) \}\}/)
    expect(projectLinks).toContain(':active-class="activeClass"')
  })

  test('the link sits in the Work section, after Board and Labels, before Knowledge', () => {
    const work = projectLinks.slice(
      projectLinks.indexOf("t('nav.sectionWork')"),
      projectLinks.indexOf("t('nav.sectionKnowledge')"),
    )
    expect(work).toContain(':to="`/${projectSlug}`"')
    expect(work).toContain(':to="`/${projectSlug}/labels`"')
    expect(work).toContain(':to="`/${projectSlug}/agents`"')
    expect(work.indexOf(':to="`/${projectSlug}/agents`"')).toBeGreaterThan(work.indexOf(':to="`/${projectSlug}/labels`"'))
  })

  test('the global /agents link stays outside the project block, so both coexist', () => {
    const globalLink = template.indexOf('<NuxtLink to="/agents"')
    expect(globalLink).toBeGreaterThan(-1)
    expect(globalLink).toBeLessThan(projectBlockStart)
  })

  test('the breadcrumb has a project-scoped Agents leaf, like /labels', () => {
    const agentsBranch = layout.slice(layout.indexOf("if (path === `/${project}/agents`) {"))
    expect(agentsBranch.startsWith('if (path === `/${project}/agents`) {')).toBe(true)
    expect(agentsBranch.slice(0, 120)).toMatch(
      /return \[\{ label: 'Koda', to: '\/' \}, projectBase, \{ label: t\('nav\.agents'\) \}\]/,
    )
  })
})

describe('Issue #252 (Behavioral SSR): default layout rendered with a project slug', () => {
  test('renders a link to /acme/agents labelled nav.agents', async () => {
    const html = await renderToString(render({
      t: (key: string) => key,
      auth: { user: VueFull.ref({ email: 'test@example.com' }), logout: () => {} },
      route: { path: '/acme/agents', params: { project: 'acme' } },
      sidebarOpen: VueFull.ref(true),
      projectSlug: 'acme',
      breadcrumbItems: [
        { label: 'Koda', to: '/' },
        { label: 'acme', to: '/acme' },
        { label: 'nav.agents' },
      ],
      backTo: '/acme',
      navLinkClass: 'nav-link',
      activeClass: 'active',
    }))

    expect(html).toContain('href="/acme/agents"')
    expect(html).toMatch(/nav\.agents\s*<\/a>/)
    // The global registry link is still there and is a different target.
    expect(html).toContain('href="/agents"')
  })

  test('without a project context only the global /agents link renders', async () => {
    const html = await renderToString(render({
      t: (key: string) => key,
      auth: { user: VueFull.ref({ email: 'test@example.com' }), logout: () => {} },
      route: { path: '/agents', params: {} },
      sidebarOpen: VueFull.ref(true),
      projectSlug: undefined,
      breadcrumbItems: [{ label: 'Koda', to: '/' }, { label: 'nav.agents' }],
      backTo: '/',
      navLinkClass: 'nav-link',
      activeClass: 'active',
    }))

    expect(html).toContain('href="/agents"')
    expect(html).not.toContain('href="/acme/agents"')
    expect(html).not.toContain('order-first') // the project block did not render
  })
})
