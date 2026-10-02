import { describe, test, expect, afterEach, jest } from '@jest/globals'
import { join } from 'path'
import { ApiError } from '../../composables/useApi'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const pagePath = join(__dirname, '../..', 'composables', 'useFleetBudgetPage.ts')

const row = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

interface Setup {
  toasts: ReturnType<typeof toastRecorder>
  api: Record<string, jest.Mock>
}

function setup(api: Record<string, jest.Mock>, confirmResult = true): Setup {
  const toasts = toastRecorder()
  const g = globalThis as Record<string, unknown>
  g.useApi = () => ({ $api: api })
  g.useI18n = () => enI18n()
  g.useAppToast = () => toasts
  g.window = { confirm: () => confirmResult }
  return { toasts, api }
}

describe('useFleetBudgetPage', () => {
  // No jest.resetModules(): a reset would hand the composable a second copy of ApiError and break `instanceof`.
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    for (const key of ['useApi', 'useI18n', 'useAppToast', 'window']) delete g[key]
  })

  test('isForbidden recognises the envelope 40003 and a plain 403', async () => {
    const { isForbidden } = await import(pagePath)
    expect(isForbidden(new ApiError(40003, 'no'))).toBe(true)
    expect(isForbidden(new ApiError(403, 'no'))).toBe(true)
    expect(isForbidden(new ApiError(500, 'no'))).toBe(false)
    expect(isForbidden(new Error('x'))).toBe(false)
  })

  test('refresh loads the list and ends pending', async () => {
    setup({ get: jest.fn(async () => [row('a')]) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    expect(page.pending.value).toBe(true)

    await page.refresh()

    expect(page.policies.value.map((p) => p.id)).toEqual(['a'])
    expect(page.pending.value).toBe(false)
    expect(page.loadFailed.value).toBe(false)
  })

  test('a failed first load reports once; a later failure only marks the data stale', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => { throw new Error('boom') })
      .mockImplementationOnce(async () => [row('a')])
      .mockImplementationOnce(async () => { throw new Error('boom again') })
    const { toasts } = setup({ get })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })

    await page.refresh()
    expect(page.loadFailed.value).toBe(true)
    expect(toasts.errors).toEqual(['boom'])

    await page.refresh()
    expect(page.loadFailed.value).toBe(false)

    await page.refresh()
    expect(page.stale.value).toBe(true)
    expect(page.policies.value).toHaveLength(1)
    expect(toasts.errors).toEqual(['boom'])
  })

  test('a 403 sets forbidden without a toast', async () => {
    const { toasts } = setup({ get: jest.fn(async () => { throw new ApiError(40003, 'forbidden') }) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })

    await page.refresh()

    expect(page.forbidden.value).toBe(true)
    expect(toasts.errors).toEqual([])
  })

  test('dialog state: create clears the policy, edit and resume carry it', async () => {
    setup({ get: jest.fn(async () => []) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    const p = row('a')

    page.openEdit(p)
    expect([page.editOpen.value, page.editing.value?.id]).toEqual([true, 'a'])
    page.openCreate()
    expect([page.editOpen.value, page.editing.value]).toEqual([true, null])
    page.openResume(p)
    expect([page.resumeOpen.value, page.resuming.value?.id]).toEqual([true, 'a'])
  })

  test('onApplied puts a saved row in the list', async () => {
    setup({ get: jest.fn(async () => [row('a')]) })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    page.onApplied(row('a', { amountUsd: '9.0000' }))

    expect(page.policies.value[0].amountUsd).toBe('9.0000')
  })

  test('remove asks first; declined sends nothing', async () => {
    const del = jest.fn(async () => undefined)
    setup({ get: jest.fn(async () => [row('a')]), delete: del }, false)
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    await page.remove(row('a'), 'sure?')

    expect(del).not.toHaveBeenCalled()
    expect(page.policies.value).toHaveLength(1)
  })

  test('remove deletes, toasts and drops the row', async () => {
    const del = jest.fn(async () => undefined)
    const { toasts } = setup({ get: jest.fn(async () => [row('a')]), delete: del })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    await page.remove(row('a'), 'sure?')

    expect(del).toHaveBeenCalledWith('/fleet/budgets/a')
    expect(page.policies.value).toEqual([])
    expect(toasts.successes).toEqual(['Budget policy deleted'])
  })

  test('a delete the server refuses (already gone) toasts its message and reloads (D185)', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => [row('a')])
      .mockImplementationOnce(async () => [])
    const del = jest.fn(async () => { throw new ApiError(404, 'Budget policy not found') })
    const { toasts } = setup({ get, delete: del })
    const { useFleetBudgetPage } = await import(pagePath)
    const page = useFleetBudgetPage({ kind: 'admin' })
    await page.refresh()

    await page.remove(row('a'), 'sure?')
    await Promise.resolve() // remove() already started the reload (void refresh()); let it settle

    expect(toasts.errors).toEqual(['Budget policy not found'])
    expect(get).toHaveBeenCalledTimes(2)
    expect(page.policies.value).toEqual([])
  })
})
