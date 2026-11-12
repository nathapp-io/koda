import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { useProjectAgentNames } from '../../composables/useProjectAgentNames'
import * as memoryModule from '../../composables/useMemory'
import { i18nStub } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'

const page = webFile('pages', '[project]', 'memory.vue')
const item = (subject: string) => ({ id: 'm1', subject, predicate: 'relates', object: 'value', kind: 'DECISION', confidence: 1, status: 'active', scope: 'project' })
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick() } }
type Api = { get: (path: string, options?: { query?: Record<string, string> }) => Promise<unknown> }

function setup(subject: string, agentFailure = false) {
  const errors = jest.fn()
  const apiCalls: string[] = []
  const api: Api = { get: async (path) => {
    apiCalls.push(path)
    if (path === '/projects/web/agents') {
      if (agentFailure) throw new Error('forbidden')
      return { items: [{ id: 'agent-1', name: 'Probe Bot', slug: 'probe' }] }
    }
    if (path === '/projects/web/members') return { records: [] }
    if (path === '/projects/web/memory') return { records: [item(subject)], total: 1, current: 1, size: 20, hasNext: false, hasPrev: false }
    return { records: [] }
  } }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const captured: { items?: ReturnType<typeof memoryModule.useMemory>['items'] } = {}
  const realMemory = {
    useMemory: (slug: string) => {
      const state = memoryModule.useMemory(slug)
      captured.items = state.items
      return state
    },
    watchDebouncedMemorySearch: memoryModule.watchDebouncedMemorySearch,
  }
  const mounted = mountSfc(page, {
    alias: { '~/composables/useMemory': realMemory, '~/composables/useApi': apiModule },
    globals: {
      useRoute: () => ({ params: { project: 'web' } }),
      useI18n: () => ({ ...i18nStub(), t: (key: string) => ({ 'memory.subject.agent': 'Agent', 'memory.subject.ticket': 'Ticket' }[key] ?? key) }),
      useAppToast: () => ({ error: errors, success: jest.fn() }),
      useProjectPermissions: () => projectPermissionsStub(['memory.decision.retire']),
      useApi: () => ({ $api: api }),
      useProjectAgentNames,
      watchDebouncedMemorySearch: memoryModule.watchDebouncedMemorySearch,
      useMemory: (slug: string) => realMemory.useMemory(slug),
    },
    components: {
      PageHeader: { template: '<div><slot name="icon"/><slot/></div>' },
      FilterBar: { template: '<div><slot/></div>' }, LoadingState: { template: '<div/>' },
      Button: { template: '<button><slot/></button>' },
      NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
      MemoryRetireDialog: { props: ['open', 'itemLabel', 'busy'], template: '<div data-testid="retire" :data-item-label="itemLabel" :data-open="open" />' },
    },
  })
  return { mounted, errors, apiCalls }
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

function rowSubject(mounted: ReturnType<typeof mountSfc>) {
  const row = mounted.find('tr').find(node => mounted.find('td', node).length > 0)
  return row ? mounted.find('td', row)[0] : undefined
}
function retire(mounted: ReturnType<typeof mountSfc>) {
  const button = mounted.find('button').find(node => mounted.textOf(node) === 'memory.retire.action')
  ;(button?.props.onClick as (() => void) | undefined)?.()
}

describe('memory agent subject labels', () => {
  test('uses a roster agent name in the row and retire dialog; ticket dialog labels use the short ref', async () => {
    const agent = setup('agent:agent-1')
    await flush()
    const agentSubject = rowSubject(agent.mounted)
    expect(agentSubject).toBeDefined()
    if (!agentSubject) return
    expect(agent.mounted.textOf(agentSubject)).toContain('Agent Probe Bot')
    retire(agent.mounted)
    await nextTick()
    expect(agent.mounted.one('[data-testid="retire"]')?.props['data-item-label']).toBe('Agent Probe Bot')
    agent.mounted.unmount()

    const ticket = setup('ticket:ticket-123456789')
    await flush()
    retire(ticket.mounted)
    await nextTick()
    expect(ticket.mounted.one('[data-testid="retire"]')?.props['data-item-label']).toBe('Ticket ticket-1')
    ticket.mounted.unmount()
  })

  test('uses the short agent id in the row and dialog after a failed roster read without toasting', async () => {
    const { mounted, errors, apiCalls } = setup('agent:agent-1', true)
    await flush()
    const subject = rowSubject(mounted)
    expect(subject).toBeDefined()
    if (!subject) return
    expect(mounted.textOf(subject)).toContain('Agent agent-1')
    retire(mounted)
    await nextTick()
    expect(mounted.one('[data-testid="retire"]')?.props['data-item-label']).toBe('Agent agent-1')
    expect(errors).not.toHaveBeenCalled()
    expect(apiCalls).toContain('/projects/web/agents')
    mounted.unmount()
  })
})
