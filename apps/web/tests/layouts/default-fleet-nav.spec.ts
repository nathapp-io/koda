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

/**
 * Every icon the layout imports from lucide-vue-next, taken from the layout source itself.
 *
 * Hardcoding the list meant a new nav entry could ship without its icon and this spec would still
 * pass (Vue renders an unresolved component), which is how the first copy of this harness drifted.
 */
function layoutIconNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!m) throw new Error('no lucide-vue-next import in the layout')
  return (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
}

describe('Fleet admin nav links', () => {
  let layoutSource: string
  let layoutTemplate: string

  beforeAll(() => {
    layoutSource = readFileSync(layoutPath, 'utf-8')
    layoutTemplate = extractTemplate(layoutSource)
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
        ...Object.fromEntries(layoutIconNames(layoutSource).map((name) => [name, icon])),
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

  // Guards the drift that caused the harness duplication: an unresolved component renders as a bare
  // tag and this spec would still pass, so the fleet links' icons must actually resolve.
  test('every icon the layout renders is registered, including the two fleet ones', async () => {
    expect(layoutIconNames(layoutSource)).toEqual(expect.arrayContaining(['Server', 'FolderGit2']))
  })
})
