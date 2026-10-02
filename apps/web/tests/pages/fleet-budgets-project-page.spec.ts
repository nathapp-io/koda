import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const pageFile = webFile('pages', '[project]', 'fleet', 'budgets.vue')
const source = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'budgets.vue'), 'utf-8')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'project', scopeId: 'proj1', projectId: 'proj1', windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const ROWS = [
  policy('pp'),
  policy('rp', { scopeType: 'repo', scopeId: 'r1', paused: true, pausedAt: '2026-10-02T00:00:00.000Z' }),
  policy('rg', { scopeType: 'repo', scopeId: 'gone' }),
  policy('g', { scopeType: 'global', scopeId: null, projectId: null }),
]

function mountProject(rows: BudgetPolicyDto[], canManage: boolean, get?: jest.Mock) {
  const api = { get: get ?? jest.fn(async () => rows), delete: jest.fn(async () => undefined), post: jest.fn(), patch: jest.fn() }
  const toasts = toastRecorder()
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  globalThis.window = { confirm: () => true } as never
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(pageFile, {
    components: uiStubs,
    fleetComponents: ['FleetBudgetTable'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ params: { project: 'koda' } }),
      useProjectViewerRole: () => ({ data: ref({ canManage, viewerRole: canManage ? 'ADMIN' : 'VIEWER' }) }),
      useFleetDispatchOptions: () => ({
        repos: ref([{ id: 'r1', owner: 'acme', name: 'app' }]),
        repoName: (id: string) => (id === 'r1' ? 'acme/app' : id),
        load: async () => undefined,
      }),
      useProjectEvents: () => undefined,
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        task = pageTask
        return polling
      },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const rowIds = (): string[] =>
    app.find('[data-stub="tr"]')
      .map((r) => r.props['data-testid'])
      .filter((id): id is string => typeof id === 'string' && id.startsWith('fleet-budget-row-'))
      .map((id) => id.replace('fleet-budget-row-', ''))
  const buttonLabels = (): string[] => app.find('[data-stub="button"]').map((b) => app.textOf(b))
  return { app, api, settle, rowIds, buttonLabels, polling }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Project budgets page (behaviour)', () => {
  test('a member sees every policy but not one control (Review Focus 3)', async () => {
    const m = mountProject(ROWS, false)
    await m.settle()

    // The project's own table first (project, then repo policies by scope id), then the fleet-wide table.
    expect(m.rowIds()).toEqual(['pp', 'rg', 'rp', 'g'])
    expect(m.buttonLabels()).toEqual([])
    expect(m.app.find('[data-stub="fleet-budget-edit-dialog"]')).toHaveLength(0)
    expect(m.app.find('[data-stub="fleet-budget-resume-dialog"]')).toHaveLength(0)
    expect(m.app.text()).toContain('Only project administrators can change budget policies.')
    m.app.unmount()
  })

  test('a project admin gets controls on the project and repo policies, none on the fleet-wide one', async () => {
    const m = mountProject(ROWS, true)
    await m.settle()

    const own = m.app.find('[data-stub="tr"]').filter((r) => String(r.props['data-testid']).startsWith('fleet-budget-row-'))
    const labelsOf = (id: string): string[] => {
      const row = own.find((r) => r.props['data-testid'] === `fleet-budget-row-${id}`)
      return row ? m.app.find('[data-stub="button"]', row).map((b) => m.app.textOf(b)) : ['<missing>']
    }
    expect(labelsOf('pp')).toEqual(['Edit', 'Delete'])
    expect(labelsOf('rp')).toEqual(['Resume', 'Edit', 'Delete'])
    expect(labelsOf('g')).toEqual([])
    expect(m.app.text()).not.toContain('Only project administrators can change budget policies.')
    m.app.unmount()
  })

  test('repo policies show the repo name; a repo that no longer exists shows its raw id', async () => {
    const m = mountProject(ROWS, false)
    await m.settle()

    const text = m.app.text()
    expect(text).toContain('acme/app')
    expect(text).toContain('gone')
    m.app.unmount()
  })

  test('the fleet-wide section carries the hint and disappears when there are no global policies', async () => {
    const withGlobal = mountProject(ROWS, false)
    await withGlobal.settle()
    expect(withGlobal.app.text()).toContain('Set by a global administrator. They apply to every project.')
    withGlobal.app.unmount()

    const without = mountProject(ROWS.filter((p) => p.scopeType !== 'global'), false)
    await without.settle()
    expect(without.app.text()).not.toContain('Fleet-wide policies')
    without.app.unmount()
  })

  test('no own policies shows the empty state, not a table', async () => {
    const m = mountProject([policy('g', { scopeType: 'global', scopeId: null })], true)
    await m.settle()
    // The EmptyState stub keeps `message` as a prop, so the copy is asserted there (as on the admin page).
    expect(m.app.one('[data-stub="empty-state"]')?.props.message).toBe('No budget policies yet.')
    expect(m.app.find('[data-stub="fleet-budgets-own"]')).toHaveLength(0)
    m.app.unmount()
  })

  test('a 403 from the list shows the forbidden line, no rows or tables, and stops polling', async () => {
    const get = jest.fn(async () => { throw new ApiError(40003, 'forbidden') })
    const m = mountProject(ROWS, false, get)
    await m.settle()

    expect(m.app.text()).toContain('You do not have access to this project.')
    expect(m.app.text()).not.toContain('Only project administrators can change budget policies.')
    expect(m.rowIds()).toEqual([])
    expect(m.app.find('[data-stub="fleet-budgets-own"]')).toHaveLength(0)
    expect(m.polling.stop).toHaveBeenCalled()
    m.app.unmount()
  })

  test('a failed first load shows the retry state and a retry loads again', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => { throw new Error('down') })
      .mockImplementationOnce(async () => ROWS)
    const m = mountProject(ROWS, false, get)
    await m.settle()
    const error = m.app.find('[data-stub="error-state"]')
    expect(error).toHaveLength(1)

    await (error[0].props.onRetry as () => Promise<void>)()
    await m.settle()

    expect(m.rowIds()).toContain('pp')
    m.app.unmount()
  })
})

describe('Project budgets page (wiring)', () => {
  test('talks to the project route through the shared page composable', () => {
    expect(source).toContain("const base: BudgetBase = { kind: 'project', slug }")
    expect(source).toContain('useFleetBudgetPage(base)')
  })

  test('creating and the two dialogs exist only for a manager', () => {
    expect(source).toMatch(/<Button v-if="canManage"[^>]*data-testid="fleet-budget-create"/)
    expect(source).toContain('<FleetBudgetEditDialog\n      v-if="canManage"')
    expect(source).toContain('v-if="canManage && resuming"')
  })

  test('own policies are editable by a manager; the fleet-wide table never is', () => {
    expect(source).toContain(':editable="canManage"')
    expect(source).toContain(':editable="false"')
  })

  test('refreshes on fleet_job notices, debounced, plus a 30 s poll (D178)', () => {
    expect(source).toContain('const POLL_MS = 30_000')
    expect(source).toContain('onFleetJob: () => liveReload.trigger()')
    expect(source).toContain('onResync: () => liveReload.trigger()')
    expect(source).toContain('liveReload.cancel()')
  })
})
