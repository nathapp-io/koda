import { describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const page = webFile('pages', '[project]', 'timeline.vue')
const event = { id: 'e1', eventType: 'ticket_event', actorId: 'u1', action: 'TICKET_CREATED', createdAt: '2026-01-01T00:00:00Z' }
const t = (key: string) => ({
  'timeline.filter.eventType': 'Event Type', 'timeline.filter.from': 'From', 'timeline.filter.to': 'To',
  'timeline.filter.all': 'All', 'home.activity.eventType.ticket_event': 'Ticket',
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
      humanizeCode: (code: string) => code.toLowerCase().replace(/(^|[_\s.-])([a-z])/g, (_, sep, c) => `${sep ? ' ' : ''}${c.toUpperCase()}`),
      extractApiError: (err: Error) => err.message,
    },
    components: { PageHeader: { template: '<div />' }, FilterBar: { template: '<div><slot /></div>' }, LoadingState: { template: '<div />' }, Input: { template: '<input v-bind="$attrs" />', inheritAttrs: true }, Button: { template: '<button><slot /></button>' } },
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
    expect(mounted.find('label').some(label => label.props.for === mounted.one('select')?.props.id)).toBe(true)
    expect(mounted.find('label').some(label => label.props.for === mounted.find('input').find(input => input.props.type === 'date')?.props.id)).toBe(true)
    expect(mounted.find('label').some(label => label.props.for === mounted.find('input').filter(input => input.props.type === 'date')[1]?.props.id)).toBe(true)
  })

  test('falls back to raw actor and readable unknown event/action codes; member failure is silent', async () => {
    const { mounted, load, toast } = setupPage({ rejectMembers: true, row: { ...event, eventType: 'foo_event', actorId: 'former-user', action: 'status_changed' } })
    await Promise.resolve()
    expect(mounted.text()).toContain('former-user')
    expect(mounted.text()).toContain('Foo event')
    expect(mounted.text()).toContain('Status changed')
    expect(load).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
