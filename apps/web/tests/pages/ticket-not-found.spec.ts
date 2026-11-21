import { expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import * as apiModule from '~/composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const inertComponent = { render: () => null }
const recorded: Array<{ name: string; props: Record<string, unknown> }> = []
const stateStub = (name: string) => ({
  props: ['title', 'body', 'backTo', 'backLabel'],
  setup(props: Record<string, unknown>) {
    recorded.push({ name, props })
    return () => null
  },
})

function mountTicket(options: { data?: unknown; pending?: boolean; error?: unknown; get?: () => Promise<unknown> } = {}) {
  recorded.length = 0
  const fetchers = new Map<string, () => Promise<unknown>>()
  const oldWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: jest.fn(), removeEventListener: jest.fn() } })
  const mounted = mountSfc(webFile('pages', '[project]', 'tickets', '[ref].vue'), {
    components: { NotFoundState: stateStub('NotFoundState'), ErrorState: stateStub('ErrorState'), LoadingState: stateStub('LoadingState') },
    globals: {
      useRoute: () => ({ params: { project: 'web', ref: 'WEB-404' } }),
      useI18n: () => ({ t: (key: string, params?: Record<string, string>) => params?.ref ? `${key} ${params.ref}` : key }),
      useApi: () => ({ $api: { get: options.get ?? (async () => []) } }),
      useAppToast: () => ({ success: () => undefined, error: () => undefined }),
      useAsyncData: (key: string, fetcher: () => Promise<unknown>) => {
        fetchers.set(key, fetcher)
        if (key === 'ticket-web-WEB-404') return { data: ref(options.data), pending: ref(options.pending ?? false), error: ref(options.error ?? null), refresh: async () => undefined }
        return { data: ref([]), pending: ref(false), error: ref(null), refresh: async () => undefined }
      },
      useNuxtData: () => ({ data: ref(null) }),
      useProjectEvents: () => undefined,
      useProjectPermissions: () => ({ permissions: ref({ has: () => false }) }),
    },
    alias: {
      '~/composables/useApi': apiModule,
      '~/components/TicketHeader.vue': inertComponent,
      '~/components/TicketActivity.vue': inertComponent,
      '~/components/TicketProperties.vue': inertComponent,
      '~/components/TicketFleetRuns.vue': inertComponent,
      '~/components/TicketWatchButton.vue': inertComponent,
    },
  })
  return { mounted, fetchers, restore: () => {
    mounted.unmount()
    if (oldWindow === undefined) delete (globalThis as { window?: Window }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow })
  } }
}

test('AC-1: ticket fetcher normalizes a not-found ApiError to null', async () => {
  const harness = mountTicket({ get: async () => { throw new apiModule.ApiError(40004, 'gone') } })
  await expect(harness.fetchers.get('ticket-web-WEB-404')?.()).resolves.toBeNull()
  harness.restore()
})

test('AC-2: ticket fetcher rethrows non-not-found errors unchanged', async () => {
  const err = new apiModule.ApiError(50000, 'down')
  const harness = mountTicket({ get: async () => { throw err } })
  await expect(harness.fetchers.get('ticket-web-WEB-404')?.()).rejects.toBe(err)
  harness.restore()
})

test('AC-3: null ticket data renders a translated NotFoundState title', () => {
  const harness = mountTicket({ data: null })
  expect(recorded.filter((item) => item.name === 'NotFoundState')).toHaveLength(1)
  expect(recorded.find((item) => item.name === 'NotFoundState')?.props.title).toBe('tickets.notFound.title')
  harness.restore()
})

test('AC-4: ticket not-found state links back to its project board', () => {
  const harness = mountTicket({ data: null })
  expect(recorded.find((item) => item.name === 'NotFoundState')?.props.backTo).toBe('/web')
  harness.restore()
})

test('AC-5: ticket not-found body interpolates the route ref', () => {
  const harness = mountTicket({ data: null })
  expect(recorded.find((item) => item.name === 'NotFoundState')?.props.body).toBe('tickets.notFound.body WEB-404')
  harness.restore()
})

test('AC-6: ticket page keeps ErrorState when ticket data has an error', () => {
  const harness = mountTicket({ data: null, error: new Error('down') })
  expect(recorded.some((item) => item.name === 'ErrorState')).toBe(true)
  harness.restore()
})

test('AC-7: ticket error state does not also render NotFoundState', () => {
  const harness = mountTicket({ data: null, error: new Error('down') })
  expect(recorded.some((item) => item.name === 'NotFoundState')).toBe(false)
  harness.restore()
})
