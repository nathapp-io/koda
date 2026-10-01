import { describe, test, expect, beforeAll } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const layoutPath = join(__dirname, '../..', 'layouts', 'default.vue')

// Same SSR pattern as tests/layouts/default-slos-nav.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VueFull = require('vue/dist/vue.cjs.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToString } = require('vue/server-renderer')

function extractTemplate(sfcSource: string): string {
  const m = sfcSource.match(/<template>([\s\S]*)<\/template>/)
  if (!m) throw new Error('No template found')
  return m[1]
}

const icon = { render() { return VueFull.h('span', { class: 'icon' }) } }
const stub = (tag: string) => ({ name: `Stub${tag}`, render(this: { $slots: { default?: () => unknown } }) { return VueFull.h('div', {}, this.$slots.default?.()) } })

describe('Fleet admin nav links', () => {
  let layoutTemplate: string

  beforeAll(() => {
    layoutTemplate = extractTemplate(readFileSync(layoutPath, 'utf-8'))
  })

  function render(isGlobalAdmin: boolean): Promise<string> {
    const app = VueFull.createSSRApp({
      template: layoutTemplate,
      setup: () => ({
        t: (key: string) => key,
        auth: { user: { value: { email: 'a@k.t', role: isGlobalAdmin ? 'ADMIN' : 'MEMBER' } }, logout: () => {}, token: { value: 't' } },
        route: { path: '/', params: {} },
        sidebarOpen: { value: true },
        projectSlug: undefined,
        breadcrumbItems: [],
        backTo: '/',
        navLinkClass: 'nav-link',
        activeClass: 'active',
        isGlobalAdmin,
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
        LayoutDashboard: icon, Kanban: icon, Bot: icon, Tag: icon, BookOpen: icon, Clock: icon, Brain: icon,
        Code2: icon, Activity: icon, Users: icon, Server: icon, FolderGit2: icon,
      },
      directives: { show: {} },
    })
    return renderToString(app)
  }

  test('a global admin sees Runners and Repos links with their nav labels', async () => {
    const html = await render(true)
    expect(html.match(/<a href="\/admin\/fleet\/runners"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetRunners')
    expect(html.match(/<a href="\/admin\/fleet\/repos"[^>]*>[\s\S]*?<\/a>/)?.[0]).toContain('nav.fleetRepos')
  })

  test('a non-admin does not see them', async () => {
    const html = await render(false)
    expect(html).not.toContain('/admin/fleet/')
  })
})
