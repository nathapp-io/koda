import { describe, expect, test } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const page = webFile('pages', '[project]', 'memory.vue')
const t = (key: string) => ({
  'memory.subject.ticket': 'Ticket', 'memory.subject.agent': 'Agent',
  'memory.kinds.FACT': 'Fact', 'memory.kinds.INCIDENT_PATTERN': 'Incident pattern',
  'tickets.status.IN_PROGRESS': 'In progress', 'memory.filter.kind': 'Kind', 'memory.filter.status': 'Status',
}[key] ?? key)
const items = [
  { id: 'ticket', subject: 'ticket:t1', predicate: 'related', object: '', kind: 'FACT', confidence: 1, status: 'active' },
  { id: 'agent', subject: 'agent:a1', predicate: 'related', object: '', kind: 'INCIDENT_PATTERN', confidence: 1, status: 'active' },
  { id: 'known-status', subject: 'deploy', predicate: 'status', object: 'IN_PROGRESS', kind: 'FACT', confidence: 1, status: 'active' },
  { id: 'unknown-status', subject: 'deploy', predicate: 'status', object: 'open', kind: 'FACT', confidence: 1, status: 'active' },
]

function mountMemory(applyFilters = async () => undefined) {
  const memory = {
    items: ref(items), isLoading: ref(false), error: ref(null), hasMore: ref(false),
    kindFilter: ref(''), statusFilter: ref(''), textFilter: ref(''),
    loadMemory: async () => undefined, applyFilters, loadMore: async () => undefined,
  }
  return mountSfc(page, {
    globals: {
      useRoute: () => ({ params: { project: 'acme' } }),
      useI18n: () => ({ t, te: (key: string) => key === 'tickets.status.IN_PROGRESS' }),
      useAppToast: () => ({ error: () => undefined, success: () => undefined }),
      useProjectPermissions: () => ({ permissions: ref({ has: () => false, hasOwn: () => false }) }),
    },
    alias: {
      '~/composables/useMemory': { useMemory: () => memory, watchDebouncedMemorySearch: () => undefined },
      '~/composables/useProjectRef': { useProjectRef: () => ({ load: async () => null }) },
      '~/composables/useApi': { extractApiError: (error: unknown) => String(error) },
    },
    components: {
      PageHeader: { template: '<div><slot name="icon"/><slot/></div>' },
      FilterBar: { template: '<div><slot/></div>' }, LoadingState: { template: '<div/>' },
      Button: { template: '<button><slot/></button>' }, MemoryRetireDialog: { template: '<div/>' },
      NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
    },
  })
}

describe('Memory readable labels', () => {
  test('ticket subjects link to the project ticket route and retain the raw subject as title', () => {
    const mounted = mountMemory()
    const link = mounted.find('a').find((node) => node.props.href === '/acme/tickets/t1')
    expect(link).toBeDefined()
    if (!link) return
    expect(mounted.textOf(link)).toContain('Ticket')
    expect(mounted.textOf(link)).toContain('t1')
    expect(link.parent?.props.title).toBe('ticket:t1')
  })
  test('agent subjects show their readable label and short id as plain text', () => {
    const mounted = mountMemory()
    expect(mounted.text()).toContain('Agent')
    expect(mounted.text()).toContain('a1')
    expect(mounted.find('a').some((node) => mounted.textOf(node).includes('a1'))).toBe(false)
  })
  test('translates known ticket statuses and preserves unknown status values', () => {
    const mounted = mountMemory()
    expect(mounted.text()).toContain('In progress')
    expect(mounted.text()).toContain('open')
  })
  test('translates kind labels in rows and filter choices while retaining values', () => {
    const mounted = mountMemory()
    expect(mounted.text()).toContain('Incident pattern')
    const option = mounted.find('option').find((node) => node.props.value === 'FACT')
    expect(option).toBeDefined()
    if (!option) return
    expect(mounted.textOf(option)).toBe('Fact')
  })
  test.each(['Kind', 'Status'])('%s filter label is associated with its select', (labelText) => {
    const mounted = mountMemory()
    const label = mounted.find('label').find((node) => mounted.textOf(node) === labelText)
    const select = mounted.find('select').find((node) => node.props.id === label?.props.for)
    expect(label?.props.for).toBeTruthy()
    expect(select?.props.id).toBeTruthy()
  })
  test('memory filters and search use the shared 40px control classes', () => {
    const mounted = mountMemory()
    for (const id of ['memory-kind-filter', 'memory-status-filter']) {
      expect(String(mounted.find('select').find((node) => node.props.id === id)?.props.class)).toContain('h-10')
    }
    const search = mounted.find('input').find((node) => node.props.type === 'search')
    expect(String(search?.props.class)).toContain('h-10')
    expect(String(search?.props.class)).toContain('border-input')
    mounted.unmount()
  })

  test('kind-filter change invokes applyFilters once', () => {
    const applyFilters = jest.fn(async () => undefined)
    const mounted = mountMemory(applyFilters)
    const select = mounted.find('select').find((node) => node.props.id === 'memory-kind-filter')
    ;(select?.props.onChange as () => void)()
    expect(applyFilters).toHaveBeenCalledTimes(1)
    mounted.unmount()
  })

  test('kind and subject translations exist in both locales', () => {
    const en = require('../../i18n/locales/en.json') as { memory: { kinds: Record<string, string>; subject: Record<string, string> } }
    const zh = require('../../i18n/locales/zh.json') as { memory: { kinds: Record<string, string>; subject: Record<string, string> } }
    for (const key of ['FACT', 'DECISION', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN', 'NOTE']) {
      expect(en.memory.kinds[key]).toEqual(expect.any(String))
      expect(zh.memory.kinds[key]?.trim()).toBeTruthy()
    }
    for (const key of ['ticket', 'agent']) {
      expect(en.memory.subject[key]).toEqual(expect.any(String))
      expect(zh.memory.subject[key]?.trim()).toBeTruthy()
    }
  })
})
