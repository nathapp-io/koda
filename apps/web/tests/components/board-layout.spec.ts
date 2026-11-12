import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { computed, reactive, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { HomeNeedsYou } from '../../lib/home-types'

const projectPage = webFile('pages', '[project]', 'index.vue')
const fleetPage = webFile('pages', '[project]', 'fleet', 'index.vue')
const board = webFile('components', 'TicketBoard.vue')
const homeNeedsYou = webFile('components', 'home', 'HomeNeedsYou.vue')
const statuses = ['CREATED', 'VERIFIED', 'IN_PROGRESS', 'VERIFY_FIX', 'CLOSED', 'REJECTED'] as const

const ticket = (status: typeof statuses[number]) => ({
  id: status, ref: `${status}-1`, title: status, type: 'BUG' as const,
  priority: 'HIGH' as const, status,
})

const emptyNeedsYou: HomeNeedsYou = {
  tickets: [], ticketsTotal: 0, approvals: [], approvalsTotal: 0, jobs: [], jobsTotal: 0,
}

function mountProjectPage() {
  return mountSfc(projectPage, {
    globals: {
      useRoute: () => ({ params: { project: 'acme' } }), useRouter: () => ({ push: () => undefined }),
      useI18n: () => enI18n(), useApi: () => ({ $api: { get: async () => ({ records: [], page: { hasNext: false } }) } }),
      useAppToast: () => ({ error: () => undefined }), useAsyncData: (_key: string, load: () => Promise<unknown>) => ({ data: ref({ records: [], page: { hasNext: false } }), pending: ref(false), error: ref(null), refresh: load }),
      useTicketBoardPages: () => ({ tickets: ref([]), hasNext: ref(false), loadingMore: ref(false), loadMoreTickets: () => undefined, reloadLoaded: async () => undefined }),
      useProjectEvents: () => undefined, createDebouncer: () => ({ trigger: () => undefined, cancel: () => undefined }),
      definePageMeta: () => undefined,
    },
    components: {
      ...uiStubs,
      PageHeader: { props: ['title'], template: '<div><slot name="actions" /></div>' },
      LoadingState: { template: '<div />' }, ErrorState: { template: '<div />' },
      TicketBoard: { template: '<div />' }, CreateTicketDialog: { template: '<div />' }, ImportIssueDialog: { template: '<div />' },
      Button: { inheritAttrs: false, props: ['variant'], template: '<button :data-variant="variant"><slot /></button>' },
    },
    alias: {
      '~/composables/useApi': { extractApiError: (error: unknown) => String(error), apiPath: (x: TemplateStringsArray) => x[0] },
      '~/composables/useTicketBoardPages': { useTicketBoardPages: () => ({ tickets: ref([]), hasNext: ref(false), loadingMore: ref(false), loadMoreTickets: () => undefined, reloadLoaded: async () => undefined }) },
      '~/lib/api-path': { apiPath: (x: TemplateStringsArray) => x[0] },
      '~/lib/debounce': { createDebouncer: () => ({ trigger: () => undefined, cancel: () => undefined }) },
    },
  })
}

function mountFleetPage() {
  const jobsApi = { jobs: ref([]), total: ref(0), hasNext: ref(false), load: async () => true }
  return mountSfc(fleetPage, {
    globals: {
      useRoute: () => ({ params: { project: 'acme' } }), useI18n: () => enI18n(), useAppToast: () => ({ error: () => undefined }),
      useFleetJobs: () => jobsApi,
      useFleetDispatchOptions: () => ({ repos: ref([]), runners: ref([]), load: async () => undefined, repoName: (id: string) => id, runnerName: (id: string) => id }),
      useProjectMemberNames: () => ({ members: ref([]), load: async () => undefined, nameOf: () => null }),
      useProjectPermissions: () => ({ permissions: computed(() => ({ has: () => false })) }),
      useProjectEvents: () => undefined,
      ref, reactive, computed, watch: Vue.watch, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      navigateTo: () => undefined, definePageMeta: () => undefined, createDebouncer: () => ({ trigger: () => undefined, cancel: () => undefined }),
    },
    components: { ...uiStubs, PageHeader: { template: '<div><slot name="actions" /></div>' }, Button: uiStubs.Button, FleetBudgetBanner: { template: '<div />' }, RepoConfigList: { template: '<div />' }, FilterBar: { template: '<div><slot /></div>' }, Select: { template: '<div><slot /></div>' }, SelectTrigger: { template: '<div><slot /></div>' }, SelectValue: { template: '<div />' }, SelectContent: { template: '<div><slot /></div>' }, SelectItem: { template: '<div><slot /></div>' }, LoadingState: { template: '<div />' }, EmptyState: { template: '<div />' }, ErrorState: { template: '<div />' }, FleetJobStateBadge: { template: '<div />' }, RepoConfigList: { template: '<div />' } },
    alias: {
      '~/composables/useApi': { extractApiError: (error: unknown) => String(error) },
      '~/lib/debounce': { createDebouncer: () => ({ trigger: () => undefined, cancel: () => undefined }) },
      '~/lib/fleet-i18n': { codeLabel: (_t: unknown, _te: unknown, _prefix: string, code: string) => code },
      '~/lib/fleet-jobs': { formatUsd: () => '$0', isConfigJob: () => false, reviewPrNumber: () => null, runningFirstJobs: (jobs: unknown[]) => jobs },
      '~/lib/project-event-stream': { FLEET_JOB_STATES: ['QUEUED', 'RUNNING', 'COMPLETED'] },
    },
  })
}

function mountBoard() {
  return mountSfc(board, {
    props: { tickets: statuses.map(ticket) },
    globals: { useI18n: () => enI18n() },
    components: {
      ...uiStubs,
      Button: { inheritAttrs: false, props: ['variant'], template: '<button :data-variant="variant" v-bind="$attrs"><slot /></button>' },
      TicketCard: { template: '<div />' },
    },
  })
}

function mountNeedsYou(needsYou: HomeNeedsYou) {
  return mountSfc(homeNeedsYou, {
    props: { needsYou, now: new Date('2026-10-06T12:00:00Z') },
    globals: { useI18n: () => enI18n(), computed },
    components: { ...uiStubs, FleetJobStateBadge: { template: '<div />' }, FleetAge: { template: '<div />' } },
  })
}

describe('US-007 board and dashboard layout', () => {
  test('AC-1 Import Issue is outline', () => {
    const app = mountProjectPage()
    const importButton = app.find('button').find(button => app.textOf(button) === 'Import Issue')
    expect(importButton?.props['data-variant']).toBe('outline')
    app.unmount()
  })

  test('AC-2 New Ticket keeps the default variant', () => {
    const app = mountProjectPage()
    const newTicketButton = app.find('button').find(button => app.textOf(button) === 'New Ticket')
    expect(newTicketButton).toBeDefined()
    expect(newTicketButton?.props['data-variant']).toBeUndefined()
    app.unmount()
  })

  test('AC-3 every board priority chip has h-11 and sm:h-9', () => {
    const app = mountProjectPage()
    const chips = app.find('button').filter(button => String(button.props.class).includes('cursor-pointer'))
    expect(chips).toHaveLength(4)
    for (const chip of chips) {
      expect(String(chip.props.class)).toContain('h-11')
      expect(String(chip.props.class)).toContain('sm:h-9')
    }
    app.unmount()
  })

  test('AC-4 all six board headers have their marker and h-8', () => {
    const app = mountBoard()
    // Every header, not just the expected ones: an extra column header must fail this test.
    const headers = app.find('div').filter(node => String(node.props['data-testid'] ?? '').startsWith('board-column-header-'))
    expect(headers.map(header => header.props['data-testid']))
      .toEqual(statuses.map(status => `board-column-header-${status}`))
    for (const status of statuses) {
      const header = app.one(`[data-testid="board-column-header-${status}"]`)
      expect(header).toBeDefined()
      expect(String(header?.props.class)).toContain('h-8')
    }
    app.unmount()
  })

  test('AC-5 Created column New Ticket carries h-7', () => {
    const app = mountBoard()
    const button = app.find('button').find(candidate => app.textOf(candidate) === 'New Ticket')
    expect(button).toBeDefined()
    expect(String(button?.props.class)).toContain('h-7')
    app.unmount()
  })

  test('AC-6 nonempty HomeNeedsYou grid aligns cards to the start', () => {
    const app = mountNeedsYou({ ...emptyNeedsYou, ticketsTotal: 1, tickets: [{ id: 't1', projectId: 'p', projectSlug: 'acme', ref: 'A-1', title: 'Ticket', type: 'BUG', status: 'CREATED', priority: 'HIGH', updatedAt: '2026-10-06' }] })
    expect(String(app.one('div')?.props.class)).toContain('items-start')
    app.unmount()
  })

  test('AC-7 every fleet state chip has h-11 and sm:h-8', () => {
    const app = mountFleetPage()
    const chips = app.find('button').filter(button => String(button.props['data-testid'] ?? '').startsWith('fleet-filter-chip-'))
    expect(chips.length).toBeGreaterThan(1)
    for (const chip of chips) {
      expect(String(chip.props.class)).toContain('h-11')
      expect(String(chip.props.class)).toContain('sm:h-8')
    }
    app.unmount()
  })

  test('AC-8 empty HomeNeedsYou keeps the existing empty text and no card grid', () => {
    const app = mountNeedsYou(emptyNeedsYou)
    expect(app.text()).toContain('Nothing needs you right now')
    expect(app.find('nuxt-link')).toEqual([])
    expect(String(app.one('div')?.props.class ?? '')).not.toContain('grid')
    app.unmount()
  })
})
