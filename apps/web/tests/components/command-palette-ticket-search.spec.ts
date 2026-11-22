import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'

const realInput = globalThis.HTMLInputElement
beforeAll(() => { globalThis.HTMLInputElement = class HTMLInputElement {} as typeof HTMLInputElement })
afterAll(() => {
  if (realInput === undefined) delete (globalThis as { HTMLInputElement?: typeof HTMLInputElement }).HTMLInputElement
  else globalThis.HTMLInputElement = realInput
})

const dialogStub = {
  name: 'StubDialog',
  props: ['open'],
  setup(props: { open?: boolean }, { slots }: { slots: Record<string, (() => unknown) | undefined> }) {
    return () => props.open ? Vue.h('x-stub-stub', {}, slots.default?.() as never) : Vue.h('x-stub-stub', {})
  },
}
const slotStub = (tag: string) => ({
  name: `Slot${tag}`,
  setup(_props: unknown, { slots }: { slots: Record<string, (() => unknown) | undefined> }) {
    return () => Vue.h('x-stub-stub', { 'data-stub': tag }, slots.default?.() as never)
  },
})
const hiddenStub = (tag: string) => ({ name: `Hidden${tag}`, setup: () => () => Vue.h('x-stub-stub', { 'data-stub': tag }) })
const ticketResponse = { records: [{ id: 't1', ref: 'WEB-3', title: 'Fix login' }] }
type Get = (path: string, options?: unknown) => Promise<unknown>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mountPalette(projectSlug: string | undefined, ticketGet?: Get): Mounted & { get: jest.Mock<Get>; navigated: string[]; toastError: jest.Mock<(message: string) => void> } {
  const navigated: string[] = []
  const toastError = jest.fn<(message: string) => void>()
  const get = jest.fn<Get>(async (path: string, options?: unknown) => {
    if (path === '/projects') return [{ id: 'p2', name: 'Web', slug: 'web', key: 'WEB' }]
    if (path === '/projects/web/tickets') return ticketGet ? ticketGet(path, options) : ticketResponse
    return []
  })
  const app = mountSfc(webFile('components', 'CommandPalette.vue'), {
    props: { open: false, projectSlug },
    components: {
      ...uiStubs,
      Dialog: dialogStub,
      DialogContent: slotStub('dialog-content'),
      DialogTitle: hiddenStub('dialog-title'),
      DialogDescription: hiddenStub('dialog-description'),
    },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      useI18n: () => enI18n(),
      useAppToast: () => ({ error: toastError }),
      useApi: () => ({ $api: { get } }),
      useColorMode: () => ({ value: 'light', preference: 'light' }),
      navigateTo: (to: string) => { navigated.push(to) },
      useAuth: () => ({ user: ref({ email: 'a@k.t', role: 'MEMBER' }) }),
      useGlobalPermissions: () => globalPermissionsStub(),
    },
  })
  return { ...app, get, navigated, toastError }
}

async function flush(_app: Mounted) {
  await Promise.resolve()
  await nextTick()
}
async function openPalette(app: Mounted) {
  app.setProps({ open: true })
  await flush(app)
}
async function type(app: Mounted, value: string) {
  const input = app.one('[role="combobox"]')
  if (!input) throw new Error('palette search input was not rendered')
  ;(input.props.onInput as (event: unknown) => void)({ target: { value } })
  await flush(app)
}
function ticketCalls(get: jest.Mock<Get>) { return get.mock.calls.filter(([path]) => path.endsWith('/tickets')) }
function expectSearchRequest(app: { get: jest.Mock<Get> }, search: string) {
  expect(ticketCalls(app.get)).toEqual([['/projects/web/tickets', { query: { search, size: 8 } }]])
}
function option(app: Mounted, id: string): FakeNode | undefined {
  return app.find('[role="option"]').find((node) => node.props.id === `palette-${id}`)
}
async function advance(ms: number) {
  jest.advanceTimersByTime(ms)
  await Promise.resolve()
  await nextTick()
}

describe('CommandPalette ticket title search', () => {
  beforeAll(() => jest.useFakeTimers())
  afterAll(() => jest.useRealTimers())

  test('AC-1: sends the bounded title-search query after 250 ms', async () => {
    const app = mountPalette('web')
    await openPalette(app)
    await type(app, 'login')
    await advance(250)
    expect(ticketCalls(app.get)).toHaveLength(1)
    expect(ticketCalls(app.get)[0]).toEqual(['/projects/web/tickets', { query: { search: 'login', size: 8 } }])
    app.unmount()
  })

  test('AC-2: renders a ticket option after the search resolves', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'login'); await advance(250); await flush(app)
    expect(option(app, 'ticket-t1')).toBeDefined()
    app.unmount()
  })

  test('AC-3: renders the ticket ref and title as the option label', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'login'); await advance(250); await flush(app)
    const ticketOption = option(app, 'ticket-t1')
    expect(ticketOption).toBeDefined()
    expect(app.textOf(ticketOption ?? app.root)).toContain('WEB-3 Fix login')
    app.unmount()
  })

  test('AC-4: activating a ticket option navigates to its project ticket route', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'login'); await advance(250); await flush(app)
    const ticketOption = option(app, 'ticket-t1')
    expect(ticketOption).toBeDefined()
    ;(ticketOption?.props.onClick as () => void)()
    expect(app.navigated).toEqual(['/web/tickets/WEB-3'])
    app.unmount()
  })

  test('AC-5: a one-character query does not request tickets', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'l'); await advance(250)
    expect(ticketCalls(app.get)).toHaveLength(0)
    app.unmount()
  })

  test('AC-6: title search is disabled without a project slug', async () => {
    const app = mountPalette(undefined)
    await openPalette(app); await type(app, 'login'); await advance(250)
    expect(ticketCalls(app.get)).toHaveLength(0)
    app.unmount()
  })

  test('AC-7: changing the query inside the debounce window makes one request', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'lo'); await advance(90); await type(app, 'login'); await advance(250)
    expect(ticketCalls(app.get)).toHaveLength(1)
    app.unmount()
  })

  test('AC-8: the debounced request searches for the latest query', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'lo'); await advance(90); await type(app, 'login'); await advance(250)
    expect((ticketCalls(app.get)[0][1] as { query: { search: string } }).query.search).toBe('login')
    app.unmount()
  })

  test('AC-9: a response for an old long query is ignored after changing to another long query', async () => {
    const pending = deferred<unknown>()
    const app = mountPalette('web', () => pending.promise)
    await openPalette(app); await type(app, 'logi'); await advance(250)
    expectSearchRequest(app, 'logi')
    await type(app, 'xyz')
    pending.resolve(ticketResponse); await flush(app)
    expect(option(app, 'ticket-t1')).toBeUndefined()
    app.unmount()
  })

  test('AC-10: a response is ignored after changing to a query below the minimum', async () => {
    const pending = deferred<unknown>()
    const app = mountPalette('web', () => pending.promise)
    await openPalette(app); await type(app, 'logi'); await advance(250)
    expectSearchRequest(app, 'logi')
    await type(app, 'l')
    pending.resolve(ticketResponse); await flush(app)
    expect(option(app, 'ticket-t1')).toBeUndefined()
    app.unmount()
  })

  test('AC-11: a failed search leaves the translated empty state', async () => {
    const app = mountPalette('web', async () => { throw new Error('offline') })
    await openPalette(app); await type(app, 'login'); await advance(250)
    expectSearchRequest(app, 'login')
    await flush(app)
    expect(app.text()).toContain('No matches')
    expect(app.toastError).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-12: a failed search renders no ticket options', async () => {
    const app = mountPalette('web', async () => { throw new Error('offline') })
    await openPalette(app); await type(app, 'login'); await advance(250)
    expectSearchRequest(app, 'login')
    await flush(app)
    expect(app.find('[role="option"]').some((node) => String(node.props.id).startsWith('palette-ticket-'))).toBe(false)
    app.unmount()
  })

  test('AC-13: displays loading feedback while a title-search request is pending', async () => {
    const pending = deferred<unknown>()
    const app = mountPalette('web', () => pending.promise)
    await openPalette(app); await type(app, 'zzz-q'); await advance(250)
    expect(app.one('[data-testid="palette-searching"]')).toBeDefined()
    pending.resolve(ticketResponse); await flush(app); app.unmount()
  })

  test('AC-14: a typed ticket reference does not start a title search', async () => {
    const app = mountPalette('web')
    await openPalette(app); await type(app, 'WEB-3'); await advance(250)
    expect(ticketCalls(app.get)).toHaveLength(0)
    app.unmount()
  })

  test('AC-15: a response arriving after close is ignored', async () => {
    const pending = deferred<unknown>()
    const app = mountPalette('web', () => pending.promise)
    await openPalette(app); await type(app, 'logi'); await advance(250)
    expectSearchRequest(app, 'logi')
    app.setProps({ open: false }); await flush(app)
    pending.resolve(ticketResponse); await flush(app)
    expect(option(app, 'ticket-t1')).toBeUndefined()
    app.unmount()
  })
})
