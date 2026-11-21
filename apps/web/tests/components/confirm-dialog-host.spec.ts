import { afterEach, describe, expect, test } from '@jest/globals'
import { nextTick } from 'vue'
import { useConfirm } from '../../composables/useConfirm'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'

const hostFile = webFile('components', 'ConfirmDialogHost.vue')
const required = (node: FakeNode | undefined): FakeNode => {
  if (!node) throw new Error('expected dialog element to be rendered')
  return node
}
const mountHost = () => mountSfc(hostFile, {
  components: uiStubs,
  globals: { useConfirm, useI18n: () => enI18n() },
})

afterEach(() => {
  useConfirm().settle(false)
})

describe('ConfirmDialogHost', () => {
  test('AC-5: renders no dialog without a pending request', () => {
    const app = mountHost()
    expect(app.find('[data-testid="confirm-dialog"]')).toHaveLength(0)
    app.unmount()
  })

  test('AC-6 to AC-8: renders the requested title, body, destructive label and variant', async () => {
    const app = mountHost()
    const result = useConfirm().confirm({ title: 'Delete it?', body: 'Gone for good.', confirmLabel: 'Delete', destructive: true })
    await nextTick()
    expect(app.textOf(required(app.one('[data-stub="dialog-title"]')))).toBe('Delete it?')
    expect(app.textOf(required(app.one('[data-testid="confirm-dialog-body"]')))).toBe('Gone for good.')
    const confirm = required(app.one('[data-testid="confirm-dialog-confirm"]'))
    expect(app.textOf(confirm)).toBe('Delete')
    expect(confirm.props.variant).toBe('destructive')
    useConfirm().settle(false)
    await result
    app.unmount()
  })

  test('AC-9: uses the translated default confirm label', async () => {
    const app = mountHost()
    const result = useConfirm().confirm({ title: 'T' })
    await nextTick()
    expect(app.textOf(required(app.one('[data-testid="confirm-dialog-confirm"]')))).toBe('Confirm')
    useConfirm().settle(false)
    await result
    app.unmount()
  })

  test('AC-10: confirming resolves true', async () => {
    const app = mountHost()
    const result = useConfirm().confirm({ title: 'T' })
    await nextTick()
    ;(required(app.one('[data-testid="confirm-dialog-confirm"]')).props.onClick as () => void)()
    await expect(result).resolves.toBe(true)
    app.unmount()
  })

  test('AC-11: cancelling resolves false', async () => {
    const app = mountHost()
    const result = useConfirm().confirm({ title: 'T' })
    await nextTick()
    ;(required(app.one('[data-testid="confirm-dialog-cancel"]')).props.onClick as () => void)()
    await expect(result).resolves.toBe(false)
    app.unmount()
  })

  test('AC-12: closing the dialog resolves false', async () => {
    const app = mountHost()
    const result = useConfirm().confirm({ title: 'T' })
    await nextTick()
    const dialog = required(app.one('[data-stub="dialog"]'))
    ;(dialog.props['onUpdate:open'] as (open: boolean) => void)(false)
    await expect(result).resolves.toBe(false)
    app.unmount()
  })

  test('AC-13: app.vue mounts exactly one ConfirmDialogHost', () => {
    const app = mountSfc(webFile('app.vue'), {
      alias: { 'vue-sonner': { Toaster: { name: 'ToasterStub', setup: () => () => null } } },
      components: {
        NuxtLayout: { name: 'NuxtLayoutStub', setup: (_props: unknown, { slots }: { slots: { default?: () => unknown } }) => () => slots.default?.() },
        NuxtPage: { name: 'NuxtPageStub', setup: () => () => null },
        Toaster: { name: 'ToasterStub', setup: () => () => null },
        ConfirmDialogHost: { name: 'ConfirmDialogHostStub', template: '<span data-testid="confirm-host-stub" />' },
      },
    })
    expect(app.find('[data-testid="confirm-host-stub"]')).toHaveLength(1)
    app.unmount()
  })
})
