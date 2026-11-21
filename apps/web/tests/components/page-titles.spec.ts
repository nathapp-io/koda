import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { ref } from 'vue'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'

const inert = { render: () => null }
const recorded: Array<unknown> = []
const useHead = (input: unknown) => { recorded.push(input) }
const t = (key: string, params?: Record<string, unknown>) => key === 'errorPage.generic.title'
  ? `Something went wrong (${String(params?.statusCode)})`
  : key === 'errorPage.notFound.title' ? 'Page not found'
    : key === 'errorPage.unavailable.title' ? 'Service unavailable'
      : key === 'tickets.notFound.title' ? 'Ticket not found' : key
const globals = { useHead, useI18n: () => ({ t }) }
const title = () => {
  const last = recorded.at(-1)
  const input = typeof last === 'function' ? (last as () => { title: string | (() => string) })() : last as { title: string | (() => string) }
  return typeof input.title === 'function' ? input.title() : input.title
}

let previousWindow: unknown
beforeAll(() => {
  previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: jest.fn(), removeEventListener: jest.fn() } })
})
afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
})

function mountTicket(data: unknown, pending = false, error: unknown = null) {
  return mountSfc(webFile('pages', '[project]', 'tickets', '[ref].vue'), {
    components: { LoadingState: inert, ErrorState: inert, NotFoundState: inert },
    globals: {
      ...globals,
      useRoute: () => ({ params: { project: 'web', ref: 'WEB-7' } }),
      useApi: () => ({ $api: { get: async () => [] } }),
      useAppToast: () => ({ success: () => undefined, error: () => undefined }),
      useAsyncData: (key: string) => ({ data: ref(key === 'ticket-web-WEB-7' ? data : []), pending: ref(key === 'ticket-web-WEB-7' && pending), error: ref(key === 'ticket-web-WEB-7' ? error : null), refresh: async () => undefined }),
      useNuxtData: () => ({ data: ref(null) }),
      useProjectEvents: () => undefined,
      useProjectPermissions: () => ({ permissions: ref({ has: () => false }) }),
    },
    alias: {
      '~/components/TicketHeader.vue': inert,
      '~/components/TicketActivity.vue': inert,
      '~/components/TicketProperties.vue': inert,
      '~/components/TicketFleetRuns.vue': inert,
      '~/components/TicketWatchButton.vue': inert,
    },
  })
}

describe('reactive document titles', () => {
  it('AC-6 PageHeader sets its title from the heading', () => {
    recorded.length = 0
    const mounted = mountSfc(webFile('components', 'PageHeader.vue'), { props: { title: 'Labels' }, globals })
    expect(title()).toBe('Labels · Koda')
    mounted.unmount()
  })
  it('AC-7 loaded ticket title includes its reference and title', () => {
    recorded.length = 0
    const mounted = mountTicket({ ref: 'WEB-7', title: 'Fix login' })
    expect(title()).toBe('WEB-7 Fix login · Koda')
    mounted.unmount()
  })
  it('AC-8 missing ticket title is localized', () => {
    recorded.length = 0
    const mounted = mountTicket(null)
    expect(title()).toBe('Ticket not found · Koda')
    mounted.unmount()
  })
  it('AC-9 pending ticket title falls back to the route reference', () => {
    recorded.length = 0
    const mounted = mountTicket(undefined, true)
    expect(title()).toBe('WEB-7 · Koda')
    mounted.unmount()
  })
  it('AC-10 404 AppErrorPage title is localized', () => {
    recorded.length = 0
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    expect(title()).toBe('Page not found · Koda')
    mounted.unmount()
  })
  it('AC-11 503 AppErrorPage title is localized', () => {
    recorded.length = 0
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503 } }, globals })
    expect(title()).toBe('Service unavailable · Koda')
    mounted.unmount()
  })
  it('AC-12 generic AppErrorPage title includes the status code', () => {
    recorded.length = 0
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 500 } }, globals })
    expect(title()).toBe('Something went wrong (500) · Koda')
    mounted.unmount()
  })
  it('AC-13 board title comes from the real PageHeader', () => {
    recorded.length = 0
    const boardGlobals = {
      ...globals,
      useRoute: () => ({ params: { project: 'web' } }),
      useRouter: () => ({ push: jest.fn() }),
      useApi: () => ({ $api: { get: async () => ({ records: [], hasNext: false }) } }),
      useAppToast: () => ({ error: () => undefined }),
      useAsyncData: () => ({ data: ref({ records: [], current: 1, hasNext: false }), pending: ref(false), error: ref(null), refresh: async () => undefined }),
      useProjectEvents: () => undefined,
    }
    const PageHeader = loadSfc(webFile('components', 'PageHeader.vue'), boardGlobals)
    const mounted = mountSfc(webFile('pages', '[project]', 'index.vue'), {
      globals: boardGlobals,
      components: { PageHeader, LoadingState: inert, ErrorState: inert, Button: inert, TicketBoard: inert, CreateTicketDialog: inert, ImportIssueDialog: inert },
    })
    expect(title()).toBe('web · Koda')
    mounted.unmount()
  })
})
