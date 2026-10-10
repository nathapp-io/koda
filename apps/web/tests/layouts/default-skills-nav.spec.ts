import { describe, test, expect, beforeAll } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const layoutPath = join(__dirname, '../..', 'layouts', 'default.vue')

// Same SSR pattern as tests/layouts/default-fleet-nav.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const VueFull = require('vue/dist/vue.cjs.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderToString } = require('vue/server-renderer')

function extractTemplate(sfcSource: string): string {
  const m = sfcSource.match(/<template>([\s\S]*)<\/template>/)
  if (!m) throw new Error('No template found')
  return m[1]
}

const icon = { render() { return VueFull.h('span', { class: 'icon' }) } }
const stub = (tag: string) => ({ name: `Stub${tag}`, render(this: { $slots: { default?: () => unknown } }) { return VueFull.h('div', {}, this.$slots.default?.()) } })

function layoutIconNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/)
  if (!m) throw new Error('no lucide-vue-next import in the layout')
  return (m[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
}

describe('US-007 admin Skills nav link', () => {
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

  test('US-007 AC9: a global admin sees a link to /admin/skills labelled with the nav.skills key', async () => {
    const html = await render(true)
    const link = html.match(/<a href="\/admin\/skills"[^>]*>[\s\S]*?<\/a>/)?.[0]
    expect(link).toBeDefined()
    expect(link).toContain('nav.skills')
  })

  test('US-007 AC10: a user who is not a global admin sees no link to /admin/skills', async () => {
    const html = await render(false)
    expect(html).not.toContain('href="/admin/skills"')
  })

  test('US-007 AC9 (placement): the Skills link follows the fleet admin links', async () => {
    const html = await render(true)
    expect(html.indexOf('href="/admin/skills"')).toBeGreaterThan(html.indexOf('href="/admin/fleet/analytics"'))
  })
})
