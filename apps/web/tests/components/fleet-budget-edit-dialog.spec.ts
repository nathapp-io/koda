import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { BudgetPolicyDto } from '../../lib/fleet-types'
import type { FakeNode } from '../helpers/mount-sfc'

const dialog = webFile('components', 'fleet', 'BudgetEditDialog.vue')

const policy = (over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id: 'p1', scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

interface Api { post: jest.Mock; patch: jest.Mock }

function harness(over: Partial<Api> = {}) {
  const api: Api = {
    post: jest.fn(async () => policy({ id: 'new' })),
    patch: jest.fn(async (_path: string, body: unknown) => policy({ ...(body as Partial<BudgetPolicyDto>) } as Partial<BudgetPolicyDto>)),
    ...over,
  }
  const toasts = toastRecorder()
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  // vee-validate validates asynchronously, then the request settles: drain both before asserting.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { api, toasts, flush }
}

function mountDialog(props: Record<string, unknown>, api: Api, toasts: ReturnType<typeof toastRecorder>) {
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

const selects = (app: ReturnType<typeof mountDialog>): FakeNode[] => app.find('[data-stub="fleet-select"]')
const select = (app: ReturnType<typeof mountDialog>, testid: string): FakeNode | undefined =>
  selects(app).find((s) => s.props.testid === testid)
const optionValues = (node: FakeNode | undefined): string[] =>
  ((node?.props.options ?? []) as Array<{ value: string }>).map((o) => o.value)

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetBudgetEditDialog (behaviour)', () => {
  test('editing patches all four editable fields on the admin route, then emits saved and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/fleet/budgets/p1', { amountUsd: 5, warnPercent: 80, hardStop: true, runningJobs: 'finish' })
    expect(app.emitted('saved')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toEqual(['Budget policy saved'])
    app.unmount()
  })

  test('the project route patches under the project prefix', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog(
      { open: true, base: { kind: 'project', slug: 'koda' }, policy: policy({ scopeType: 'project', scopeId: 'proj1', projectId: 'proj1' }) },
      api, toasts,
    )
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/budgets/p1', expect.objectContaining({ amountUsd: 5 }))
    app.unmount()
  })

  test('a policy without a warn threshold sends an explicit null (blank means "no warning")', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy({ warnPercent: null, hardStop: false, runningJobs: 'cancel' }) }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/fleet/budgets/p1', { amountUsd: 5, warnPercent: null, hardStop: false, runningJobs: 'cancel' })
    app.unmount()
  })

  test('a refusal shows the server message, keeps the dialog open and tells the page to reload', async () => {
    const { api, toasts, flush } = harness({ patch: jest.fn(async () => { throw new ApiError(404, 'Budget policy not found') }) })
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(toasts.errors).toEqual(['Budget policy not found'])
    expect(app.emitted('saved')).toHaveLength(0)
    expect(app.emitted('update:open')).toHaveLength(0)
    expect(app.emitted('failed')).toHaveLength(1)
    app.unmount()
  })

  test('creating with an empty limit is blocked before any request', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.post).not.toHaveBeenCalled()
    expect(app.emitted('saved')).toHaveLength(0)
    app.unmount()
  })

  test('create mode offers scope and window; edit mode shows neither, only the fixed-after-create hint', async () => {
    const { api, toasts, flush } = harness()
    const creating = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()
    expect(selects(creating).map((s) => s.props.testid)).toEqual([
      'fleet-budget-scope-type', 'fleet-budget-window', 'fleet-budget-hard-stop', 'fleet-budget-running-jobs',
    ])
    expect(creating.find('[data-testid="fleet-budget-fixed-hint"]')).toHaveLength(0)
    creating.unmount()

    const editing = mountDialog({ open: true, base: { kind: 'admin' }, policy: policy() }, api, toasts)
    await flush()
    expect(selects(editing).map((s) => s.props.testid)).toEqual(['fleet-budget-hard-stop', 'fleet-budget-running-jobs'])
    expect(editing.find('[data-testid="fleet-budget-fixed-hint"]')).toHaveLength(1)
    editing.unmount()
  })

  test('each route offers its own scope types (2a D162)', async () => {
    const { api, toasts, flush } = harness()
    const admin = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()
    expect(optionValues(select(admin, 'fleet-budget-scope-type'))).toEqual(['global', 'runner'])
    admin.unmount()

    const project = mountDialog({ open: true, base: { kind: 'project', slug: 'koda' }, policy: null }, api, toasts)
    await flush()
    expect(optionValues(select(project, 'fleet-budget-scope-type'))).toEqual(['project', 'repo'])
    project.unmount()
  })

  test('the window, hard-stop and running-jobs selects list the API values', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, base: { kind: 'admin' }, policy: null }, api, toasts)
    await flush()
    expect(optionValues(select(app, 'fleet-budget-window'))).toEqual(['calendar_month_utc', 'lifetime'])
    expect(optionValues(select(app, 'fleet-budget-hard-stop'))).toEqual(['true', 'false'])
    expect(optionValues(select(app, 'fleet-budget-running-jobs'))).toEqual(['finish', 'cancel'])
    app.unmount()
  })
})
