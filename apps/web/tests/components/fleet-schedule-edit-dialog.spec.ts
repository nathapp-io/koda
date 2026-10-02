import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { ScheduleDto } from '../../lib/fleet-types'

const dialog = webFile('components', 'fleet', 'ScheduleEditDialog.vue')

const schedule = (over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: 's1', projectId: 'p1', repoId: 'r1', name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', feature: 'login',
  ref: 'main', profiles: ['fast'], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: 'run1', enabled: true,
  nextFireAt: '2026-10-05T01:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'u1', updatedById: 'u1',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

interface Api { post: jest.Mock; patch: jest.Mock }

function harness(over: Partial<Api> = {}) {
  const api: Api = {
    post: jest.fn(async () => schedule({ id: 'new' })),
    patch: jest.fn(async () => schedule()),
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
    props: { slug: 'koda', repoOptions: [{ value: 'r1', label: 'acme/app' }], runnerOptions: [{ value: 'run1', label: 'mac-1' }], ...props },
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
const testids = (app: ReturnType<typeof mountDialog>): string[] =>
  [...app.find('[data-stub="fleet-select"]').map((n) => n.props.testid), ...app.find('[data-stub="input"]').map((n) => n.props['data-testid'])]
    .filter((id): id is string => typeof id === 'string')

afterEach(() => { delete (globalThis as Record<string, unknown>).useApi })

describe('FleetScheduleEditDialog (behaviour)', () => {
  test('edit of a pinned schedule patches every editable field, keeps the pin, then emits saved and closes', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()

    await submit(app)
    await flush()

    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/schedules/s1', {
      name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', ref: 'main', profiles: ['fast'], maxCostUsd: 5,
      noProgressLimit: 3, selectorLabels: [], pinnedRunnerId: 'run1',
    })
    expect(app.emitted('saved')).toHaveLength(1)
    expect(app.emitted('update:open').at(-1)).toEqual([false])
    expect(toasts.successes).toEqual(['Schedule saved'])
    app.unmount()
  })

  test('edit of a labels schedule sends pinnedRunnerId null (Review Focus 1)', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule({ pinnedRunnerId: null, selectorLabels: ['gpu'] }) }, api, toasts)
    await flush()
    await submit(app)
    await flush()
    expect(api.patch).toHaveBeenCalledWith('/projects/koda/fleet/schedules/s1', expect.objectContaining({ selectorLabels: ['gpu'], pinnedRunnerId: null }))
    app.unmount()
  })

  test('create shows repo and feature; edit shows the fixed hint instead (D203)', async () => {
    const { api, toasts, flush } = harness()
    const create = mountDialog({ open: true, schedule: null }, api, toasts)
    await flush()
    expect(testids(create)).toEqual(expect.arrayContaining(['fleet-schedule-repo', 'fleet-schedule-feature', 'fleet-schedule-placement']))
    expect(create.text()).not.toContain('The repo and the feature are fixed after create.')
    create.unmount()

    const edit = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    expect(testids(edit)).not.toContain('fleet-schedule-repo')
    expect(testids(edit)).not.toContain('fleet-schedule-feature')
    expect(edit.text()).toContain('The repo and the feature are fixed after create.')
    edit.unmount()
  })

  test('the placement select offers the three modes, and the pin select is shown for a pinned schedule', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    const placement = app.find('[data-stub="fleet-select"]').find((n) => n.props.testid === 'fleet-schedule-placement')
    expect(((placement?.props.options ?? []) as Array<{ value: string }>).map((o) => o.value)).toEqual(['auto', 'labels', 'pin'])
    expect(testids(app)).toContain('fleet-schedule-pin')
    app.unmount()
  })

  test('an empty create form does not post', async () => {
    const { api, toasts, flush } = harness()
    const app = mountDialog({ open: true, schedule: null }, api, toasts)
    await flush()
    await submit(app)
    await flush()
    expect(api.post).not.toHaveBeenCalled()
    app.unmount()
  })

  test('a refused save keeps the dialog open, shows the server message and emits failed', async () => {
    const { api, toasts, flush } = harness({
      patch: jest.fn(async () => { throw new ApiError(400, 'The schedule fires more often than every 15 minutes') }),
    })
    const app = mountDialog({ open: true, schedule: schedule() }, api, toasts)
    await flush()
    await submit(app)
    await flush()
    expect(toasts.errors).toEqual(['The schedule fires more often than every 15 minutes'])
    expect(app.emitted('failed')).toHaveLength(1)
    expect(app.emitted('update:open')).toEqual([])
    app.unmount()
  })
})
