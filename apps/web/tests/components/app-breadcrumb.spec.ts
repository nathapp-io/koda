import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const breadcrumbFile = webFile('components', 'AppBreadcrumb.vue')
const nuxtLinkStub = {
  props: ['to'],
  template: '<a v-bind="$attrs" :href="to"><slot /></a>',
}

describe('AppBreadcrumb', () => {
  test('uses a mobile touch target for links and renders destination-less items as spans', () => {
    const app = mountSfc(breadcrumbFile, {
      props: { items: [{ label: 'Koda', to: '/' }, { label: 'web' }] },
      components: { NuxtLink: nuxtLinkStub },
    })
    const kodaLink = app.one('a')
    expect(kodaLink && app.textOf(kodaLink)).toBe('Koda')
    expect(app.find('a')).toHaveLength(1)
    expect(kodaLink?.props.class).toContain('inline-flex')
    expect(kodaLink?.props.class).toContain('min-h-11')
    expect(kodaLink?.props.class).toContain('items-center')
    expect(kodaLink?.props.class).toContain('sm:min-h-0')
    const webSpan = app.find('span').find((span) => app.textOf(span) === 'web')
    expect(webSpan).toBeDefined()
    expect(webSpan?.tag).toBe('span')
    app.unmount()
  })
})
