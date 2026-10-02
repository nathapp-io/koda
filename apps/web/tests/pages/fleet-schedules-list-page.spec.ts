import { describe, test, expect, afterEach, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n, toastRecorder } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { ScheduleDto } from '../../lib/fleet-types'

const pageFile = webFile('pages', '[project]', 'fleet', 'schedules', 'index.vue')
const source = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'schedules', 'index.vue'), 'utf-8')

const schedule = (id: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name: `s-${id}`, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, enabled: true,
  nextFireAt: '2026-10-05T09:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0,
  noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'owner', updatedById: 'owner',
  createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
})

const ROWS = [schedule('a'), schedule('b', { createdById: 'someone-else' })]
type Role = { canManage: boolean; viewerRole: string | null }
const DEVELOPER: Role = { canManage: false, viewerRole: 'DEVELOPER' }
const VIEWER: Role = { canManage: false, viewerRole: 'VIEWER' }
const ADMIN: Role = { canManage: true, viewerRole: 'ADMIN' }

function mountList(rows: ScheduleDto[], role: Role, get?: jest.Mock) {
  const api = {
    get: get ?? jest.fn(async () => rows),
    post: jest.fn(async (p: string) => schedule('a', { enabled: !p.endsWith('/disable') })),
    patch: jest.fn(),
    delete: jest.fn(async () => undefined),
  }
  const toasts = toastRecorder()
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  globalThis.window = { confirm: () => true } as never
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })

  const app = mountSfc(pageFile, {
    components: uiStubs,
    fleetComponents: ['FleetScheduleTable'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
      useAppToast: () => toasts,
      useApi: () => ({ $api: api }),
      useRoute: () => ({ params: { project: 'koda' } }),
      useAuth: () => ({ user: ref({ id: 'owner' }) }),
      useProjectViewerRole: () => ({ data: ref(role) }),
      useFleetDispatchOptions: () => ({
        repos: ref([{ id: 'r1', owner: 'acme', name: 'app' }]), runners: ref([]),
        repoName: (id: string) => (id === 'r1' ? 'acme/app' : id), runnerName: (id: string | null) => id,
        profileOptions: ref([]), labelOptions: ref([]), load: async () => undefined,
      }),
      useProjectMemberNames: () => ({ load: async () => undefined, nameOf: (id: string) => (id === 'owner' ? 'Olive' : null) }),
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
  const row = (id: string) => app.find('[data-stub="tr"]').find((r) => r.props['data-testid'] === `fleet-schedule-row-${id}`)
  const rowButtons = (id: string): string[] => {
    const r = row(id)
    return r ? app.find('[data-stub="button"]', r).map((b) => String(b.props['data-testid'])) : ['<missing>']
  }
  const hasTestid = (testid: string): boolean => app.find('[data-stub="button"]').some((b) => b.props['data-testid'] === testid)
  return { app, api, toasts, polling, settle, row, rowButtons, hasTestid }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).useApi
})

describe('Schedules list page (behaviour)', () => {
  test('a developer creates, and changes only their own schedule (Review Focus 2)', async () => {
    const m = mountList(ROWS, DEVELOPER)
    await m.settle()
    expect(m.hasTestid('fleet-schedule-create')).toBe(true)
    expect(m.rowButtons('a')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete'])
    expect(m.rowButtons('b')).toEqual([])
    expect(m.app.text()).toContain('Only the schedule owner or a project administrator can change a schedule.')
    m.app.unmount()
  })

  test('a viewer reads only: no create, no row action, no dialog', async () => {
    const m = mountList(ROWS, VIEWER)
    await m.settle()
    expect(m.hasTestid('fleet-schedule-create')).toBe(false)
    expect(m.rowButtons('a')).toEqual([])
    expect(m.app.find('[data-stub="fleet-schedule-edit-dialog"]')).toHaveLength(0)
    expect(m.app.text()).toContain('Only the schedule owner or a project administrator can change a schedule.')
    m.app.unmount()
  })

  test('a project admin changes every schedule and sees no read-only line', async () => {
    const m = mountList(ROWS, ADMIN)
    await m.settle()
    expect(m.rowButtons('b')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete'])
    expect(m.app.text()).not.toContain('Only the schedule owner or a project administrator can change a schedule.')
    m.app.unmount()
  })

  test('Disable posts to the disable route, updates the row and toasts', async () => {
    const m = mountList(ROWS, DEVELOPER)
    await m.settle()
    const disable = m.app.find('[data-stub="button"]', m.row('a')).find((b) => b.props['data-testid'] === 'fleet-schedule-disable')
    await (disable?.props.onClick as () => Promise<void>)()
    await m.settle()
    expect(m.api.post).toHaveBeenCalledWith('/projects/koda/fleet/schedules/a/disable')
    expect(m.row('a')?.props['data-enabled']).toBe('false')
    expect(m.toasts.successes).toEqual(['Schedule disabled'])
    m.app.unmount()
  })

  test('Edit opens the dialog on that schedule; Create opens it empty', async () => {
    const m = mountList(ROWS, DEVELOPER)
    await m.settle()
    const edit = m.app.find('[data-stub="button"]', m.row('a')).find((b) => b.props['data-testid'] === 'fleet-schedule-edit')
    ;(edit?.props.onClick as () => void)()
    await m.settle()
    const dialog = m.app.one('[data-stub="fleet-schedule-edit-dialog"]')
    expect(dialog?.props.open).toBe(true)
    expect(dialog?.props['data-schedule']).toBe('a')
    m.app.unmount()
  })

  test('a 403 shows the forbidden line, no table, and stops polling', async () => {
    const m = mountList(ROWS, VIEWER, jest.fn(async () => { throw new ApiError(40003, 'forbidden') }))
    await m.settle()
    expect(m.app.text()).toContain('You do not have access to this project.')
    expect(m.app.find('[data-stub="tr"]')).toHaveLength(0)
    expect(m.polling.stop).toHaveBeenCalled()
    m.app.unmount()
  })

  test('no schedules shows the empty state', async () => {
    const m = mountList([], DEVELOPER)
    await m.settle()
    expect(m.app.one('[data-stub="empty-state"]')?.props.message).toBe('No schedules yet')
    m.app.unmount()
  })

  test('live: fleet_job notices and resync reload, debounced; the poll runs every 60 s (D222)', () => {
    expect(source).toContain('const POLL_MS = 60_000')
    expect(source).toContain('onFleetJob: () => liveReload.trigger()')
    expect(source).toContain('onResync: () => liveReload.trigger()')
    expect(source).toContain(':key="editing?.id ?? \'new\'"')
  })
})
