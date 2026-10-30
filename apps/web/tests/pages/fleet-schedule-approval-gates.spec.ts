import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { canChangeSchedule, canDeleteSchedule } from '~/lib/fleet-schedules'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import { useProjectPermissions } from '~/composables/usePermissions'
import type { ScheduleDto } from '~/lib/fleet-types'
import * as apiModule from '../../composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { fakeAsyncData, resetAsyncCalls } from '../helpers/permission-nav'

/**
 * Permissions P1 US-009: the fleet schedule gates.
 *
 * Every gate AC mounts the REAL page (or the real table) with the REAL `useProjectPermissions`
 * composable; the only thing a test supplies is `$api.get('/me/permissions')`, which answers the key
 * list for the scope being asked for. A control that still read a role name or a `canManage` boolean
 * therefore fails here, and the whole permission path (fetch, fail-closed default, key lookup) runs
 * instead of being mocked away.
 *
 * US-010 retired the fleet inbox, so this spec covers the schedule gates only: the approval viewer
 * those pages built and the `canDecide` helper they read are gone with the pages.
 */

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 — the pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A `ScheduleViewer` holding no key; a test names only the ones it needs. */
const scheduleViewer = (over: Partial<ScheduleViewer> = {}): ScheduleViewer => ({
  userId: 'u1',
  canCreate: false,
  canUpdateAny: false,
  canUpdateOwn: false,
  canDeleteAny: false,
  canDeleteOwn: false,
  ...over,
})

const schedule = (createdById: string): Pick<ScheduleDto, 'createdById'> => ({ createdById })

describe('US-009 AC-1: canChangeSchedule follows update any/own', () => {
  test('AC-1: canUpdateAny changes a schedule somebody else created', () => {
    const viewer = scheduleViewer({ userId: 'u2', canUpdateAny: true, canUpdateOwn: false })
    expect(canChangeSchedule(schedule('u1'), viewer)).toBe(true)
  })

  test('AC-1: canUpdateOwn changes the caller\'s own schedule and nobody else\'s', () => {
    const viewer = scheduleViewer({ userId: 'u1', canUpdateAny: false, canUpdateOwn: true })
    expect(canChangeSchedule(schedule('u1'), viewer)).toBe(true)
    expect(canChangeSchedule(schedule('u2'), viewer)).toBe(false)
  })

  test('AC-1: canDeleteSchedule follows canDeleteAny/canDeleteOwn by the same rule', () => {
    expect(canDeleteSchedule(schedule('u1'), scheduleViewer({ userId: 'u2', canDeleteAny: true }))).toBe(true)
    expect(canDeleteSchedule(schedule('u1'), scheduleViewer({ userId: 'u1', canDeleteOwn: true }))).toBe(true)
    expect(canDeleteSchedule(schedule('u2'), scheduleViewer({ userId: 'u1', canDeleteOwn: true }))).toBe(false)
    expect(canDeleteSchedule(schedule('u1'), scheduleViewer({ userId: 'u1' }))).toBe(false)
  })

  test('AC-1 (control): update does not imply delete, and delete does not imply update', () => {
    const updater = scheduleViewer({ userId: 'u1', canUpdateAny: true, canUpdateOwn: true })
    expect(canDeleteSchedule(schedule('u1'), updater)).toBe(false)

    const deleter = scheduleViewer({ userId: 'u1', canDeleteAny: true, canDeleteOwn: true })
    expect(canChangeSchedule(schedule('u1'), deleter)).toBe(false)
  })

  test('AC-1 (edge): a signed-out caller owns nothing, so an own key grants nothing', () => {
    const signedOut = scheduleViewer({ userId: null, canUpdateOwn: true, canDeleteOwn: true })
    expect(canChangeSchedule(schedule('u1'), signedOut)).toBe(false)
    expect(canDeleteSchedule(schedule('u1'), signedOut)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// shared mount harness
// ─────────────────────────────────────────────────────────────────────────────

const g = globalThis as Record<string, unknown>

/**
 * Every surface this spec mounted. The notification composable starts a real 1 s ticker on mount, so a
 * failed assertion must not leave one behind: `afterEach` unmounts whatever a test did not.
 */
const mountedApps: Mounted[] = []
function track(app: Mounted): Mounted {
  mountedApps.push(app)
  return app
}

/** i18n with the real English copy, plus the `locale` ref some fleet components read. */
function pageI18n(): Record<string, unknown> {
  return { ...enI18n(), locale: ref('en') }
}

interface RouteAnswer {
  /** The project-scope keys `/me/permissions?project=<slug>` answers. */
  project?: readonly string[]
  /** The global-scope keys `/me/permissions` answers. */
  global?: readonly string[]
  /** Any other GET the mounted surface makes, by path. */
  routes?: Record<string, unknown>
  /** A path whose GET never settles. */
  hang?: readonly string[]
  /** A path whose GET rejects. */
  fail?: readonly string[]
}

/**
 * A `$api.get` that answers the permissions endpoint from the given key lists and every other path
 * from `routes`. `/me/permissions` without a query is the global scope; with `?project=` it is that
 * project's scope, exactly as the API answers (US-001).
 */
function permissionsApi(answer: RouteAnswer): jest.Mock {
  return jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
    if (answer.fail?.includes(path)) throw new Error(`failed ${path}`)
    if (answer.hang?.includes(path)) return new Promise(() => undefined)
    if (path === '/me/permissions') {
      const project = options?.query?.project
      return project === undefined
        ? { scope: 'global', projectSlug: null, keys: [...(answer.global ?? [])] }
        : { scope: 'project', projectSlug: project, keys: [...(answer.project ?? [])] }
    }
    if (answer.routes && path in answer.routes) return answer.routes[path]
    return {}
  })
}

/** Installs the two Nuxt auto-imports the real permissions composable resolves at runtime. */
function installPermissionsRuntime(get: jest.Mock): void {
  g.useAsyncData = fakeAsyncData
  g.useApi = () => ({ $api: { get } })
}

/** Drains the fetch microtasks plus the Vue scheduler. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

const byTestId = (app: Mounted, testId: string, scope?: FakeNode): FakeNode | undefined =>
  app.find(`[data-testid="${testId}"]`, scope)[0]

beforeEach(() => {
  // The schedule delete confirm reads window.confirm; node has no window.
  g.window = { confirm: (): boolean => true }
})

afterEach(() => {
  for (const app of mountedApps.splice(0)) {
    try { app.unmount() } catch { /* already unmounted by the test */ }
  }
  delete g.window
  delete g.useAsyncData
  delete g.useApi
  resetAsyncCalls()
})

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

const scheduleFixture = (id: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id, projectId: 'p1', repoId: 'r1', name: `s-${id}`, cron: '0 9 * * 1-5', timezone: 'UTC', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5.0000', selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', approvalTimeoutSec: 600,
  enabled: true, nextFireAt: '2026-10-05T09:00:00.000Z', lastFiredAt: null, lastJobId: null, lastPassedCount: 0,
  noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000', createdById: 'u1',
  updatedById: 'u1', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...over,
} as ScheduleDto)

/**
 * A polling double whose `runNow` runs the page's own task, as the real composable does on mount.
 * `useVisiblePolling` must be handed back the double this returns, so it captures the page task.
 */
function pollingDouble(): Record<string, unknown> {
  let task: () => Promise<void> = async () => undefined
  return {
    start: jest.fn(),
    stop: jest.fn(),
    runNow: async (): Promise<void> => { await task() },
    isActive: () => true,
    capture: (pageTask: () => Promise<void>): void => { task = pageTask },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-3, AC-5 — pages/[project]/fleet/schedules/index.vue
// ─────────────────────────────────────────────────────────────────────────────

interface SchedulesIndexOver {
  project: readonly string[]
  rows?: ScheduleDto[]
  userId?: string | null
}

function mountSchedulesIndex(over: SchedulesIndexOver): Mounted {
  const rows = over.rows ?? []
  const get = permissionsApi({ project: over.project, routes: { '/projects/koda/fleet/schedules': rows } })
  installPermissionsRuntime(get)
  const polling = pollingDouble()
  const post = jest.fn(async (path: string) => scheduleFixture('a', { enabled: !path.endsWith('/disable') }))
  return track(mountSfc(webFile('pages', '[project]', 'fleet', 'schedules', 'index.vue'), {
    components: uiStubs,
    fleetComponents: ['FleetScheduleTable'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get, post, patch: jest.fn(), delete: jest.fn(async () => undefined) } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'koda' } }),
      useAuth: () => ({ user: ref(over.userId === undefined ? { id: 'u1' } : over.userId === null ? null : { id: over.userId }) }),
      navigateTo: jest.fn(async () => undefined),
      useProjectEvents: () => undefined,
      useVisiblePolling: (pageTask: () => Promise<void>) => { (polling.capture as (t: () => Promise<void>) => void)(pageTask); return polling },
      useFleetDispatchOptions: () => ({
        repos: ref([]), runners: ref([]), profileOptions: ref([]), labelOptions: ref([]),
        repoName: (id: string) => id, runnerName: (id: string | null) => id, load: jest.fn(async () => undefined),
      }),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
    },
  }))
}

/** The control test ids rendered in one schedule's row, in template order. */
function rowControls(app: Mounted, id: string): string[] {
  const row = app.find('[data-stub="tr"]').find((node) => node.props['data-testid'] === `fleet-schedule-row-${id}`)
  if (!row) return ['<missing>']
  return app.find('[data-stub="button"]', row).map((button) => String(button.props['data-testid']))
}

describe('US-009 AC-3: the schedules index gates create, change and delete separately', () => {
  test('AC-3: fleet.schedule.create renders create; update.own gives the creator edit but no delete', async () => {
    const app = mountSchedulesIndex({
      project: ['fleet.schedule.create', 'fleet.schedule.update.own'],
      rows: [scheduleFixture('a', { createdById: 'u1' }), scheduleFixture('b', { createdById: 'u2' })],
    })
    await settle()

    expect(byTestId(app, 'fleet-schedule-create')).toBeDefined()
    expect(rowControls(app, 'a')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit'])
    expect(rowControls(app, 'b')).toEqual([])
    app.unmount()
  })

  test('AC-3: adding fleet.schedule.delete.own puts the delete button on the creator\'s row only', async () => {
    const app = mountSchedulesIndex({
      project: ['fleet.schedule.update.own', 'fleet.schedule.delete.own'],
      rows: [scheduleFixture('a', { createdById: 'u1' }), scheduleFixture('b', { createdById: 'u2' })],
    })
    await settle()

    expect(byTestId(app, 'fleet-schedule-create')).toBeUndefined()
    expect(rowControls(app, 'a')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit', 'fleet-schedule-delete'])
    expect(rowControls(app, 'b')).toEqual([])
    app.unmount()
  })

  test('AC-3 (control): the any-row update key reaches every row, and update never buys delete', async () => {
    const app = mountSchedulesIndex({
      project: ['fleet.schedule.update'],
      rows: [scheduleFixture('a', { createdById: 'u1' }), scheduleFixture('b', { createdById: 'u2' })],
    })
    await settle()

    expect(rowControls(app, 'a')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit'])
    expect(rowControls(app, 'b')).toEqual(['fleet-schedule-disable', 'fleet-schedule-edit'])
    app.unmount()
  })

  test('AC-3 (edge): a signed-out visitor holding only an own key gets no control at all', async () => {
    const app = mountSchedulesIndex({
      project: ['fleet.schedule.update.own', 'fleet.schedule.delete.own'],
      rows: [scheduleFixture('a', { createdById: 'u1' })],
      userId: null,
    })
    await settle()

    expect(rowControls(app, 'a')).toEqual([])
    app.unmount()
  })
})

describe('US-009 AC-5: an empty project key set is a read-only schedules index', () => {
  test('AC-5: no keys renders the read-only notice and no create button', async () => {
    const app = mountSchedulesIndex({ project: [], rows: [scheduleFixture('a', { createdById: 'u1' })] })
    await settle()

    expect(byTestId(app, 'fleet-schedule-readonly')).toBeDefined()
    expect(byTestId(app, 'fleet-schedule-create')).toBeUndefined()
    // The table did render (so the empty row is a real "no controls", not a page that never loaded).
    expect(byTestId(app, 'fleet-schedules-table')).toBeDefined()
    expect(rowControls(app, 'a')).toEqual([])
    app.unmount()
  })

  test('AC-5 (control): holding fleet.schedule.create drops the notice', async () => {
    const app = mountSchedulesIndex({ project: ['fleet.schedule.create'], rows: [] })
    await settle()

    expect(byTestId(app, 'fleet-schedule-readonly')).toBeUndefined()
    expect(byTestId(app, 'fleet-schedule-create')).toBeDefined()
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-4 — pages/[project]/fleet/schedules/[id].vue
// ─────────────────────────────────────────────────────────────────────────────

function mountScheduleDetail(project: readonly string[], row: ScheduleDto): Mounted {
  const get = permissionsApi({ project, routes: { [`/projects/koda/fleet/schedules/${row.id}`]: row } })
  installPermissionsRuntime(get)
  const polling = pollingDouble()
  return track(mountSfc(webFile('pages', '[project]', 'fleet', 'schedules', '[id].vue'), {
    components: uiStubs,
    fleetComponents: ['FleetScheduleHistory'],
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get, post: jest.fn(), patch: jest.fn(), delete: jest.fn(async () => undefined) } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'koda', id: row.id } }),
      useAuth: () => ({ user: ref({ id: 'u1' }) }),
      navigateTo: jest.fn(async () => undefined),
      useProjectEvents: () => undefined,
      useVisiblePolling: (pageTask: () => Promise<void>) => { (polling.capture as (t: () => Promise<void>) => void)(pageTask); return polling },
      useFleetJobs: () => ({ jobs: ref([]), hasNext: ref(false), load: jest.fn(async () => true) }),
      useFleetDispatchOptions: () => ({
        repos: ref([]), runners: ref([]), profileOptions: ref([]), labelOptions: ref([]),
        repoName: (id: string) => id, runnerName: (id: string | null) => id, load: jest.fn(async () => undefined),
      }),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
    },
  }))
}

describe('US-009 AC-4: the schedule detail page gates change and delete separately', () => {
  test('AC-4: update.own without a delete key renders edit, enable and disable, and no delete', async () => {
    const app = mountScheduleDetail(['fleet.schedule.update.own'], scheduleFixture('a', { createdById: 'u1' }))
    await settle()

    expect(byTestId(app, 'fleet-schedule-edit')).toBeDefined()
    expect(byTestId(app, 'fleet-schedule-disable')).toBeDefined()
    expect(byTestId(app, 'fleet-schedule-delete')).toBeUndefined()
    app.unmount()
  })

  test('AC-4 (control): adding fleet.schedule.delete.own adds the delete button beside them', async () => {
    const app = mountScheduleDetail(['fleet.schedule.update.own', 'fleet.schedule.delete.own'], scheduleFixture('a', { createdById: 'u1' }))
    await settle()

    expect(byTestId(app, 'fleet-schedule-edit')).toBeDefined()
    expect(byTestId(app, 'fleet-schedule-delete')).toBeDefined()
    app.unmount()
  })

  test('AC-4: a delete key alone leaves a schedule with no edit, enable or disable', async () => {
    const app = mountScheduleDetail(['fleet.schedule.delete.own'], scheduleFixture('a', { createdById: 'u1' }))
    await settle()

    expect(byTestId(app, 'fleet-schedule-delete')).toBeDefined()
    expect(byTestId(app, 'fleet-schedule-edit')).toBeUndefined()
    expect(byTestId(app, 'fleet-schedule-disable')).toBeUndefined()
    app.unmount()
  })

  test('AC-4 (edge): update.own on somebody else\'s schedule renders no control', async () => {
    const app = mountScheduleDetail(['fleet.schedule.update.own', 'fleet.schedule.delete.own'], scheduleFixture('a', { createdById: 'u2' }))
    await settle()

    for (const id of ['fleet-schedule-edit', 'fleet-schedule-disable', 'fleet-schedule-delete']) {
      expect(byTestId(app, id)).toBeUndefined()
    }
    app.unmount()
  })
})
