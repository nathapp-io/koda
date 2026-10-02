import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import { useFleetRunners } from '../../composables/useFleetRunners'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const page = webFile('pages', 'admin', 'fleet', 'budgets.vue')

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

const runnerPage = {
  records: [{ id: 'r1', name: 'box-1' }], total: 1, current: 1, size: 100, hasNext: false, hasPrev: false,
}

interface Api { get: jest.Mock; delete: jest.Mock; post: jest.Mock; patch: jest.Mock }

function makeApi(rows: BudgetPolicyDto[], over: Partial<Api> = {}): Api {
  return {
    get: jest.fn(async (path: string) => (path === '/fleet/runners' ? runnerPage : rows)),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
    ...over,
  }
}

/** Mounts the page with a fake `$api`; `useVisiblePolling` is stubbed so the test drives refreshes. */
function mountBudgets(api: Api, confirmResult = true) {
  const toasts = toastRecorder()
  const stop = jest.fn()
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop, runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  globalThis.window = { confirm: () => confirmResult } as never
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(page, {
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
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        task = pageTask
        return polling
      },
      useFleetRunners: () => useFleetRunners(),
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
  const rowButton = (id: string, label: string) => {
    const row = app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-budget-row-${id}`)
    if (!row) throw new Error(`no row ${id} in: ${rowIds().join(',')}`)
    const button = app.find('[data-stub="button"]', row).find((b) => app.textOf(b) === label)
    if (!button) throw new Error(`no button "${label}" on row ${id}`)
    return { onClick: () => (button.props.onClick as () => void | Promise<void>)() }
  }
  return { app, api, toasts, stop, settle, rowIds, rowButton }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Fleet admin Budgets page', () => {
  test('lists global and runner policies only (D174), with the runner name', async () => {
    const m = mountBudgets(makeApi([
      policy('g'),
      policy('rn', { scopeType: 'runner', scopeId: 'r1' }),
      policy('pr', { scopeType: 'project', scopeId: 'x', projectId: 'x' }),
      policy('rp', { scopeType: 'repo', scopeId: 'y', projectId: 'x' }),
    ]))
    await m.settle()

    expect(m.rowIds()).toEqual(['fleet-budget-row-g', 'fleet-budget-row-rn'])
    expect(m.app.text()).toContain('box-1')
    m.app.unmount()
  })

  test('an empty list says so', async () => {
    const m = mountBudgets(makeApi([]))
    await m.settle()
    // The EmptyState stub keeps `message` as a prop, so the copy is asserted there.
    expect(m.app.one('[data-stub="empty-state"]')?.props.message).toBe('No budget policies yet.')
    m.app.unmount()
  })

  test('a 403 shows the admin-only line, hides the table and stops polling', async () => {
    const m = mountBudgets(makeApi([], { get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) }))
    await m.settle()

    expect(m.app.text()).toContain('Only global administrators can manage the fleet.')
    expect(m.rowIds()).toEqual([])
    expect(m.stop).toHaveBeenCalled()
    m.app.unmount()
  })

  test('Resume on a row opens the resume dialog for that policy', async () => {
    const m = mountBudgets(makeApi([policy('g', { paused: true, pausedAt: '2026-10-02T00:00:00.000Z' })]))
    await m.settle()
    expect(m.app.find('[data-stub="fleet-budget-resume-dialog"]')).toHaveLength(0)

    await m.rowButton('g', 'Resume').onClick()
    await m.settle()

    const dialog = m.app.find('[data-stub="fleet-budget-resume-dialog"]')
    expect(dialog).toHaveLength(1)
    expect(dialog[0].props.open).toBe(true)
    expect(dialog[0].props['data-policy']).toBe('g')
    m.app.unmount()
  })

  test('Edit opens the edit dialog for that policy; Add policy opens it empty', async () => {
    const m = mountBudgets(makeApi([policy('g')]))
    await m.settle()

    await m.rowButton('g', 'Edit').onClick()
    await m.settle()
    let dialog = m.app.find('[data-stub="fleet-budget-edit-dialog"]')[0]
    expect([dialog.props.open, dialog.props['data-policy']]).toEqual([true, 'g'])

    const create = m.app.find('[data-stub="button"]').find((b) => b.props['data-testid'] === 'fleet-budget-create')
    await (create?.props.onClick as () => void)()
    await m.settle()
    dialog = m.app.find('[data-stub="fleet-budget-edit-dialog"]')[0]
    expect([dialog.props.open, dialog.props['data-policy']]).toEqual([true, ''])
    m.app.unmount()
  })

  test('Delete asks first, then deletes on the admin route and drops the row', async () => {
    const m = mountBudgets(makeApi([policy('g')]))
    await m.settle()

    await m.rowButton('g', 'Delete').onClick()
    await m.settle()

    expect(m.api.delete).toHaveBeenCalledWith('/fleet/budgets/g')
    expect(m.rowIds()).toEqual([])
    expect(m.toasts.successes).toEqual(['Budget policy deleted'])
    m.app.unmount()
  })

  test('a declined confirm deletes nothing', async () => {
    const m = mountBudgets(makeApi([policy('g')]), false)
    await m.settle()

    await m.rowButton('g', 'Delete').onClick()
    await m.settle()

    expect(m.api.delete).not.toHaveBeenCalled()
    expect(m.rowIds()).toEqual(['fleet-budget-row-g'])
    m.app.unmount()
  })

  test('deleting a policy that is already gone shows the server message and reloads (Review Focus 4)', async () => {
    const m = mountBudgets(makeApi([policy('g')], { delete: jest.fn(async () => { throw new ApiError(404, 'Budget policy not found') }) }))
    await m.settle()

    await m.rowButton('g', 'Delete').onClick()
    await m.settle()

    expect(m.toasts.errors).toEqual(['Budget policy not found'])
    const listCalls = m.api.get.mock.calls.filter(([path]) => path === '/fleet/budgets')
    expect(listCalls).toHaveLength(2)
    m.app.unmount()
  })
})
