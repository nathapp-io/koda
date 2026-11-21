import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'

const previousInputElement = globalThis.HTMLInputElement
beforeAll(() => {
  globalThis.HTMLInputElement = class HTMLInputElement {} as typeof HTMLInputElement
})
afterAll(() => {
  globalThis.HTMLInputElement = previousInputElement
})

const dialogStub = {
  name: 'StubDialog',
  props: ['open'],
  setup(props: { open?: boolean }, { slots }: { slots: Record<string, (() => unknown) | undefined> }) {
    return () => (props.open ? Vue.h('x-stub-stub', { 'data-stub': 'dialog' }, slots.default?.() as never) : Vue.h('x-stub-stub', {}))
  },
}
const slotStub = (tag: string) => ({
  name: `Slot${tag}`,
  setup(_props: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': tag }, slots.default?.() as never)
  },
})
const hiddenStub = (tag: string) => ({ name: `Hidden${tag}`, setup: () => () => Vue.h('x-stub-stub', { 'data-stub': tag }) })

interface Palette {
  app: ReturnType<typeof mountSfc>
  optionIds: () => string[]
  input: (query: string) => Promise<void>
  activate: (id: string) => void
  navigated: string[]
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Vue.nextTick()
}

function mountPalette(): Palette {
  const navigated: string[] = []
  const get = jest.fn(async () => [
    { id: 'p1', name: 'Sandbox', slug: 'sandbox', key: 'SB' },
    { id: 'p2', name: 'Web', slug: 'web', key: 'WEB' },
  ])
  const app = mountSfc(webFile('components', 'CommandPalette.vue'), {
    props: { open: false },
    components: {
      ...uiStubs,
      Dialog: dialogStub,
      DialogContent: slotStub('dialog-content'),
      DialogTitle: hiddenStub('dialog-title'),
      DialogDescription: hiddenStub('dialog-description'),
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, nextTick: Vue.nextTick,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useColorMode: () => ({ value: 'light', preference: 'light' }),
      navigateTo: (to: string) => { navigated.push(to) },
      useGlobalPermissions: () => globalPermissionsStub(),
    },
  })
  const options = (): FakeNode[] => app.find('[role="option"]')
  const optionIds = (): string[] => options().map((item) => String(item.props.id).replace(/^palette-/, ''))
  const input = async (query: string): Promise<void> => {
    const search = app.one('input')
    if (!search) throw new Error('palette search input not found')
    const onInput = search.props.onInput as ((event: Event) => void) | undefined
    if (!onInput) throw new Error('palette search input has no input handler')
    onInput({ target: { value: query } } as unknown as Event)
    await flush()
  }
  const activate = (id: string): void => {
    const item = options().find((option) => option.props.id === `palette-${id}`)
    if (!item) throw new Error(`no palette entry ${id} in: ${app.text()}`)
    ;(item.props.onClick as () => void)()
  }
  return { app, optionIds, input, activate, navigated }
}

async function openPalette(palette: Palette): Promise<void> {
  palette.app.setProps({ open: true })
  await flush()
}

describe('CommandPalette typed ticket refs', () => {
  test('AC-5: typed ref command is first for a loaded project without projectSlug', async () => {
    const palette = mountPalette()
    await openPalette(palette)
    await palette.input('sb-1')

    expect(palette.optionIds()[0]).toBe('ticket-ref')
    palette.app.unmount()
  })

  test('AC-6: activating ticket-ref navigates to its normalized project ticket route', async () => {
    const palette = mountPalette()
    await openPalette(palette)
    await palette.input('sb-1')
    palette.activate('ticket-ref')

    expect(palette.navigated).toEqual(['/sandbox/tickets/SB-1'])
    palette.app.unmount()
  })

  test('AC-7: no ticket-ref option appears when no loaded project has the parsed key', async () => {
    const palette = mountPalette()
    await openPalette(palette)
    await palette.input('ZZ-1')

    expect(palette.optionIds()).not.toContain('ticket-ref')
    palette.app.unmount()
  })

  test('AC-8: empty query preserves the static and loaded project command order', async () => {
    const palette = mountPalette()
    await openPalette(palette)

    expect(palette.optionIds()).toEqual(['dashboard', 'account', 'agents', 'my-threads', 'slos', 'project-p1', 'project-p2', 'theme'])
    palette.app.unmount()
  })
})
