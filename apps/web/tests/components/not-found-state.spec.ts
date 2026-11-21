import { expect, test } from '@jest/globals'
import { h } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const nuxtLinkStub = {
  props: ['to'],
  setup(props: Record<string, unknown>, { slots }: { slots: { default?: () => unknown[] } }) {
    return () => h('a', { to: props.to }, slots.default?.())
  },
}

function mountNotFound(props: Record<string, unknown>) {
  return mountSfc(webFile('components', 'NotFoundState.vue'), {
    props,
    components: { NuxtLink: nuxtLinkStub },
  })
}

test('AC-8: not-found state renders its title', () => {
  const mounted = mountNotFound({ title: 'Gone', backTo: '/web', backLabel: 'Back' })
  const title = mounted.one('[data-testid="not-found-title"]')
  expect(title).toBeDefined()
  if (title) expect(mounted.textOf(title)).toBe('Gone')
  mounted.unmount()
})

test('AC-9: not-found back link points to the supplied destination', () => {
  const mounted = mountNotFound({ title: 'Gone', backTo: '/web', backLabel: 'Back' })
  expect(mounted.one('[data-testid="not-found-back"]')?.props.to).toBe('/web')
  mounted.unmount()
})

test('AC-10: not-found back link reads its supplied label', () => {
  const mounted = mountNotFound({ title: 'Gone', backTo: '/web', backLabel: 'Back' })
  const back = mounted.one('[data-testid="not-found-back"]')
  expect(back).toBeDefined()
  if (back) expect(mounted.textOf(back)).toBe('Back')
  mounted.unmount()
})

test('AC-11: not-found state omits an unset body', () => {
  const mounted = mountNotFound({ title: 'Gone', backTo: '/web', backLabel: 'Back' })
  expect(mounted.one('[data-testid="not-found-body"]')).toBeUndefined()
  mounted.unmount()
})
