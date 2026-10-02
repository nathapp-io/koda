import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const dialog = webFile('components', 'fleet', 'BudgetResumeDialog.vue')

const paused = (over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id: 'p1', scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '10.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: true, pausedAt: '2026-10-02T00:00:00.000Z',
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '9.0000', warnReached: true, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

function harness(over: { post?: jest.Mock } = {}) {
  const api = { post: jest.fn(async () => paused({ paused: false, pausedAt: null })), ...over }
  const toasts = toastRecorder()
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { api, toasts, flush }
}

function mountDialog(props: Record<string, unknown>, api: { post: jest.Mock }, toasts: ReturnType<typeof toastRecorder>) {
  return mountSfc(dialog, {
    components: uiStubs,
    props,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
    },
  })
}

const submit = async (app: ReturnType<typeof mountDialog>): Promise<void> => {
  await (app.one('form')?.props.onSubmit as () => Promise<void>)()
}

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetResumeDialog (behaviour)', () => {
  test('shows how much was spent against the limit', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    const summary = app.find('[data-testid="fleet-budget-resume-summary"]')
    expect(summary).toHaveLength(1)
    expect(app.textOf(summary[0])).toBe('Spent $9.00 of $10.00 in this window.')
    app.unmount()
  })

  test('a blank amount resumes with an empty body, then emits resumed and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).toHaveBeenCalledWith('/fleet/budgets/p1/resume', {})
    expect(app.emitted('resumed')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toEqual(['Budget resumed'])
    app.unmount()
  })

  test('the project route resumes under the project prefix', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(
      { open: true, base: { kind: 'project', slug: 'koda' }, policy: paused({ scopeType: 'project', scopeId: 'proj1', projectId: 'proj1' }) },
      api, toasts,
    )
    await flush()

    await submit(app)
    await flush()

    expect(api.post).toHaveBeenCalledWith('/projects/koda/fleet/budgets/p1/resume', {})
    app.unmount()
  })

  test('a lowered limit (not above the spend) cannot be resumed without a new limit (Review Focus 2)', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused({ amountUsd: '2.0000', spentUsd: '3.0000' }) }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).not.toHaveBeenCalled()
    expect(app.emitted('resumed')).toHaveLength(0)
    const hint = app.find('[data-testid="fleet-budget-resume-hint"]')
    expect(app.textOf(hint[0])).toBe('The current limit is not above the spend. Enter a higher limit.')
    app.unmount()
  })

  test('a limit exactly equal to the spend is also blocked, whatever the trailing zeros (Review Focus 1)', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused({ amountUsd: '3', spentUsd: '3.0000' }) }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('with room left the hint says a blank keeps the limit', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    const hint = app.find('[data-testid="fleet-budget-resume-hint"]')
    expect(app.textOf(hint[0])).toBe('Leave blank to keep the current limit.')
    app.unmount()
  })

  test('a refusal (already resumed elsewhere) shows the server message and asks the page to reload (D185)', async () => {
    const { api, toasts, flush } = harness({ post: jest.fn(async () => { throw new ApiError(409, 'This budget policy is not paused') }) })
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: paused() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(toasts.errors).toEqual(['This budget policy is not paused'])
    expect(app.emitted('resumed')).toHaveLength(0)
    expect(app.emitted('failed')).toHaveLength(1)
    expect(app.emitted('update:open')).toHaveLength(0)
    app.unmount()
  })
})
