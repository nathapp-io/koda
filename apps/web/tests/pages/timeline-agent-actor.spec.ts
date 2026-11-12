import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { useProjectAgentNames } from '../../composables/useProjectAgentNames'
import { useProjectMemberNames } from '../../composables/useProjectMemberNames'

const page = webFile('pages', '[project]', 'timeline.vue')
const rows = [{ id: 'e-agent', eventType: 'ticket_event', actorId: 'agent-1', action: 'TICKET_CREATED', createdAt: '2026-01-01T00:00:00Z' }, { id: 'e-user', eventType: 'ticket_event', actorId: 'user-1', action: 'TICKET_CREATED', createdAt: '2026-01-01T00:00:00Z' }]
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

type Api = { get: (path: string, options?: unknown) => Promise<unknown> }
function setup(agentFailure = false) {
  const errors = jest.fn()
  const calls: string[] = []
  const api: Api = { get: async (path) => {
    calls.push(path)
    if (path === '/projects/web/agents') {
      if (agentFailure) throw new Error('forbidden')
      return { items: [{ id: 'agent-1', name: 'Probe Bot', slug: 'probe' }] }
    }
    if (path === '/projects/web/members') return { records: [{ userId: 'user-1', name: 'Ada', email: 'ada@example.test' }] }
    return { records: [] }
  } }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const mounted = mountSfc(page, {
    globals: {
      useRoute: () => ({ params: { project: 'web' } }),
      useI18n: () => ({ t: (key: string) => key, te: () => false, locale: { value: 'en' } }),
      useAppToast: () => ({ error: errors }),
      useTimelineEvents: () => ({ events: rows, isLoading: false, error: null, hasMore: false, eventTypeFilter: '', fromFilter: '', toFilter: '', loadEvents: async () => undefined, applyFilters: async () => undefined, loadMore: async () => undefined }),
      useProjectAgentNames,
      useProjectMemberNames,
      extractApiError: (error: Error) => error.message,
      humanizeCode: (code: string) => code,
    },
    components: { PageHeader: { template: '<div />' }, FilterBar: { template: '<div><slot /></div>' }, LoadingState: { template: '<div />' }, Input: { template: '<input />' }, Button: { template: '<button><slot /></button>' } },
  })
  return { mounted, errors, calls }
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('timeline agent actor names', () => {
  test('resolves agents while retaining member-name precedence', async () => {
    const { mounted, calls } = setup()
    await flush()
    const cells = mounted.find('tr').filter(row => mounted.find('td', row).length > 0).map(row => mounted.find('td', row)[1])
    expect(cells).toHaveLength(2)
    if (cells.length !== 2 || !cells[0] || !cells[1]) return
    expect(mounted.textOf(cells[0])).toBe('Probe Bot')
    expect(mounted.textOf(cells[1])).toBe('Ada')
    expect(calls).toContain('/projects/web/agents')
    expect(calls).toContain('/projects/web/members')
    mounted.unmount()
  })

  test('falls back to raw actor id and does not toast when the roster request rejects', async () => {
    const { mounted, errors } = setup(true)
    await flush()
    const agentRow = mounted.find('tr').find(row => mounted.textOf(row).includes('agent-1'))
    expect(agentRow).toBeDefined()
    if (!agentRow) return
    const actorCell = mounted.find('td', agentRow)[1]
    expect(actorCell).toBeDefined()
    if (!actorCell) return
    expect(mounted.textOf(actorCell)).toBe('agent-1')
    expect(errors).not.toHaveBeenCalled()
    mounted.unmount()
  })
})
