import { expect, test, jest } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs } from '../helpers/fleet-harness'

const inertComponent = { render: () => null }

test('mounting the ticket detail page with a loaded ticket renders the two-row desktop grid', () => {
  const oldWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: jest.fn(), removeEventListener: jest.fn() } })
  const ticket = { id: 't1', ref: 'WEB-1', title: 'Ticket', type: 'BUG', priority: 'HIGH', status: 'CREATED', createdAt: '2026-01-01T00:00:00Z', labels: [], links: [] }
  const app = mountSfc(webFile('pages', '[project]', 'tickets', '[ref].vue'), {
    components: uiStubs,
    globals: {
      useRoute: () => ({ params: { project: 'web', ref: 'WEB-1' } }),
      useI18n: () => ({ t: (key: string) => key }),
      useApi: () => ({ $api: { get: async () => [] } }),
      useAppToast: () => ({ success: () => undefined, error: () => undefined }),
      useAsyncData: (key: string) => ({ data: ref(key.startsWith('ticket-web-') ? ticket : []), pending: ref(false), error: ref(null), refresh: async () => undefined }),
      useNuxtData: () => ({ data: ref(null) }),
      useProjectEvents: () => undefined,
      useProjectPermissions: () => ({ permissions: ref({ has: () => false }) }),
    },
    alias: {
      '~/components/TicketHeader.vue': inertComponent,
      '~/components/TicketActivity.vue': inertComponent,
      '~/components/TicketProperties.vue': inertComponent,
      '~/components/TicketFleetRuns.vue': inertComponent,
      '~/components/TicketWatchButton.vue': inertComponent,
    },
  })
  const grid = app.find('div').find((element) => String(element.props.class ?? '').includes('grid-cols-1'))
  expect(String(grid?.props.class ?? '').split(/\s+/)).toContain('lg:grid-rows-[auto_1fr]')
  app.unmount()
  if (oldWindow === undefined) delete (globalThis as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow })
})
