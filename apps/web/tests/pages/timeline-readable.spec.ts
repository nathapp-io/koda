import { describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { useProjectMemberNames } from '../../composables/useProjectMemberNames'
import { uiStubs } from '../helpers/fleet-harness'

const page = webFile('pages', '[project]', 'timeline.vue')
type Row = { id: string; eventType: string; actorId: string; action: string; createdAt: string; actorName: string | null; ticketRef: string | null; ticketTitle: string | null }
const event: Row = { id: 'e1', eventType: 'ticket_event', actorId: 'u1', action: 'TICKET_CREATED', createdAt: '2026-01-01T00:00:00Z', actorName: null, ticketRef: null, ticketTitle: null }
const t = (key: string) => ({
  'timeline.filter.eventType': 'Event Type', 'timeline.filter.from': 'From', 'timeline.filter.to': 'To',
  'timeline.filter.all': 'All', 'home.activity.eventType.ticket_event': 'Ticket',
  'common.formerMember': 'Former member', 'timeline.columns.ticket': 'Ticket',
}[key] ?? key)
const setupPage = (opts: { memberName?: string | null; rejectMembers?: boolean; row?: typeof event } = {}) => {
  const load = jest.fn(async () => { if (opts.rejectMembers) throw new Error('offline') })
  const nameOf = jest.fn((id: string) => id === 'u1' ? opts.memberName ?? null : null)
  const events = [opts.row ?? event]
  const toast = { error: jest.fn() }
  const mounted = mountSfc(page, {
    globals: {
      useRoute: () => ({ params: { project: 'acme' } }),
      useI18n: () => ({ t, te: (key: string) => key === 'home.activity.eventType.ticket_event', locale: { value: 'en' } }),
      useAppToast: () => toast,
      useTimelineEvents: () => ({ events, isLoading: false, error: null, hasMore: false, eventTypeFilter: '', fromFilter: '', toFilter: '', loadEvents: jest.fn(), applyFilters: jest.fn(), loadMore: jest.fn() }),
      useProjectMemberNames: jest.fn(() => ({ load, nameOf })),
      useProjectAgentNames: jest.fn(() => ({ load: jest.fn(async () => undefined), nameOf: jest.fn(() => null) })),
      humanizeCode: (code: string) => code.toLowerCase().replace(/(^|[_\s.-])([a-z])/g, (_, sep, c) => `${sep ? ' ' : ''}${c.toUpperCase()}`),
      extractApiError: (err: Error) => err.message,
    },
    components: { ...uiStubs, PageHeader: { template: '<div />' }, FilterBar: { template: '<div><slot /></div>' }, LoadingState: { template: '<div />' }, Input: { template: '<input v-bind="$attrs" />', inheritAttrs: true }, Button: { template: '<button><slot /></button>' } },
  })
  return { mounted, load, nameOf, toast }
}

describe('Timeline readable labels', () => {
  test('renders member actor, localized event type, humanized action and event filter', () => {
    const { mounted } = setupPage({ memberName: 'Ann' })
    const cells = mounted.find('td')
    expect(mounted.textOf(cells[0])).toBe('Ticket')
    expect(mounted.textOf(cells[1])).toBe('Ann')
    expect(mounted.textOf(cells[2])).toBe('Ticket created')
    expect(cells[2].props.title).toBe('TICKET_CREATED')
    const option = mounted.find('option').find(node => node.props.value === 'ticket_event')
    expect(option && mounted.textOf(option)).toBe('Ticket')
    const all = mounted.find('option').find(node => node.props.value === '')
    expect(all && mounted.textOf(all)).toBe('All')
    const selectId = mounted.one('select')?.props.id
    expect(typeof selectId).toBe('string')
    expect(selectId).not.toBe('')
    const eventTypeLabel = mounted.find('label').find(label => mounted.textOf(label) === 'Event Type')
    expect(eventTypeLabel?.props.for).toBe(selectId)

    const dateInputs = mounted.find('input').filter(input => input.props.type === 'date')
    const fromId = dateInputs[0]?.props.id
    expect(typeof fromId).toBe('string')
    expect(fromId).not.toBe('')
    const fromLabel = mounted.find('label').find(label => mounted.textOf(label) === 'From')
    expect(fromLabel?.props.for).toBe(fromId)

    const toId = dateInputs[1]?.props.id
    expect(typeof toId).toBe('string')
    expect(toId).not.toBe('')
    const toLabel = mounted.find('label').find(label => mounted.textOf(label) === 'To')
    expect(toLabel?.props.for).toBe(toId)
  })

  test('real member-name composable requests project members once with page size 100', () => {
    const calls: Array<{ method: string; path: string; options: { query: { size: string } } }> = []
    const global = globalThis as typeof globalThis & { useApi?: () => { $api: { get: (path: string, options: { query: { size: string } }) => Promise<{ records: [] }> } } }
    global.useApi = () => ({ $api: { get: async (path, options) => { calls.push({ method: 'GET', path, options }); return { records: [] } } } })
    try {
      mountSfc(page, {
        globals: {
          useRoute: () => ({ params: { project: 'acme' } }),
          useI18n: () => ({ t, te: () => false, locale: { value: 'en' } }),
          useAppToast: () => ({ error: jest.fn() }),
          useTimelineEvents: () => ({ events: [], isLoading: true, error: null, hasMore: false, eventTypeFilter: '', fromFilter: '', toFilter: '', loadEvents: jest.fn(), applyFilters: jest.fn(), loadMore: jest.fn() }),
          useProjectMemberNames: (slug: string) => useProjectMemberNames(slug),
        },
      })
    }
    finally {
      delete global.useApi
    }
    expect(calls).toEqual([{ method: 'GET', path: '/projects/acme/members', options: { query: { size: '100' } } }])
  })

  test('AC-6: API actor name takes precedence over a different member roster name', () => {
    const { mounted } = setupPage({ memberName: 'Someone Else', row: { ...event, actorName: 'Alice' } })
    expect(mounted.textOf(mounted.find('td')[1])).toBe('Alice')
    mounted.unmount()
  })

  test('AC-7: falls back to the member roster when the API actor name is null', () => {
    const { mounted } = setupPage({ memberName: 'Bob' })
    expect(mounted.textOf(mounted.find('td')[1])).toBe('Bob')
    mounted.unmount()
  })

  test('AC-8: uses Former member without exposing an unknown actor id', async () => {
    const { mounted, load, toast } = setupPage({ rejectMembers: true, row: { ...event, eventType: 'foo_event', actorId: 'former-user', action: 'status_changed' } })
    await Promise.resolve()
    const actor = mounted.find('td')[1]
    expect(mounted.textOf(actor)).toBe('Former member')
    expect(mounted.text()).not.toContain('former-user')
    expect(mounted.text()).toContain('Foo event')
    expect(mounted.text()).toContain('Status changed')
    expect(load).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
    mounted.unmount()
  })

  test('AC-9: has a Ticket column and links ticket references', () => {
    const { mounted } = setupPage({ row: { ...event, ticketRef: 'SB-3', ticketTitle: 'Fix login' } })
    expect(mounted.text()).toContain('Ticket')
    const link = mounted.one('[data-testid="timeline-ticket"]')
    expect(link?.props.to).toBe('/acme/tickets/SB-3')
    expect(mounted.textOf(link)).toBe('SB-3 Fix login')
    mounted.unmount()
  })

  test('AC-10: does not render a ticket link when ticketRef is null', () => {
    const { mounted } = setupPage()
    expect(mounted.find('[data-testid="timeline-ticket"]')).toHaveLength(0)
    mounted.unmount()
  })
})
