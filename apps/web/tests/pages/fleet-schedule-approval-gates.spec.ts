import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { canChangeSchedule, canDeleteSchedule } from '~/lib/fleet-schedules'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import { canDecide } from '~/lib/fleet-approvals'
import type { ApprovalViewer } from '~/lib/fleet-approvals'
import { useGlobalPermissions, useProjectPermissions } from '~/composables/usePermissions'
import type { ApprovalCountsDto, FleetApprovalDto, ScheduleDto } from '~/lib/fleet-types'
import * as apiModule from '../../composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { fakeAsyncData, globalPermissionsStub, resetAsyncCalls } from '../helpers/permission-nav'

/**
 * Permissions P1 US-009: the fleet schedule and approval gates.
 *
 * Every gate AC mounts the REAL page (or the real table/badge) with the REAL `useProjectPermissions`
 * / `useGlobalPermissions` composable; the only thing a test supplies is `$api.get('/me/permissions')`,
 * which answers the key list for the scope being asked for. A control that still read a role name or
 * a `canManage` boolean therefore fails here, and the whole permission path (fetch, fail-closed
 * default, key lookup) runs instead of being mocked away.
 */

// ─────────────────────────────────────────────────────────────────────────────
// AC-1, AC-2, AC-7 — the pure helpers
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

/** An `ApprovalViewer` holding no decision key. */
const approvalViewer = (over: Partial<ApprovalViewer> = {}): ApprovalViewer =>
  ({ kind: 'project', userId: 'u1', canDecideBudget: false, canDecideBash: false, ...over }) as ApprovalViewer

const schedule = (createdById: string): Pick<ScheduleDto, 'createdById'> => ({ createdById })

const approval = (over: Partial<FleetApprovalDto> = {}): Pick<FleetApprovalDto, 'type' | 'status' | 'payload'> => ({
  type: 'budget_override_required',
  status: 'pending',
  payload: {},
  ...over,
} as Pick<FleetApprovalDto, 'type' | 'status' | 'payload'>)

const bashAsk = (over: Partial<FleetApprovalDto> = {}): Pick<FleetApprovalDto, 'type' | 'status' | 'payload'> =>
  approval({ type: 'nax_bash_escalate', ...over })

const actionAsk = (requestedById: string): Pick<FleetApprovalDto, 'type' | 'status' | 'payload'> =>
  approval({
    type: 'assistant_action',
    payload: { actionId: 'a1', tool: 'ticket.update', threadId: 't1', threadPath: '/koda/threads/t1', requestedById },
  })

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

describe('US-009 AC-2: canDecide follows the budget and bash keys', () => {
  test('AC-2: a pending budget override follows canDecideBudget', () => {
    expect(canDecide(approval(), approvalViewer({ canDecideBudget: true }))).toBe(true)
    expect(canDecide(approval(), approvalViewer({ canDecideBudget: false }))).toBe(false)
  })

  test('AC-2: a pending bash ask follows canDecideBash', () => {
    expect(canDecide(bashAsk(), approvalViewer({ canDecideBash: true }))).toBe(true)
    expect(canDecide(bashAsk(), approvalViewer({ canDecideBash: false }))).toBe(false)
  })

  test('AC-2 (control): the other key does not open either kind', () => {
    expect(canDecide(approval(), approvalViewer({ canDecideBash: true }))).toBe(false)
    expect(canDecide(bashAsk(), approvalViewer({ canDecideBudget: true }))).toBe(false)
  })

  test('AC-2: an assistant_action stays the requester\'s alone, whatever keys the viewer holds', () => {
    const bothKeys = approvalViewer({ canDecideBudget: true, canDecideBash: true })
    expect(canDecide(actionAsk('u1'), { ...bothKeys, userId: 'u1' } as ApprovalViewer)).toBe(true)
    expect(canDecide(actionAsk('u1'), { ...bothKeys, userId: 'u2' } as ApprovalViewer)).toBe(false)
    expect(canDecide(actionAsk('u1'), { ...bothKeys, userId: null } as ApprovalViewer)).toBe(false)
  })
})

describe('US-009 AC-7: an admin-kind viewer decides only what its keys allow', () => {
  test('AC-7: a pending budget override is not decidable for canDecideBudget:false, even on the admin inbox', () => {
    const admin = approvalViewer({ kind: 'admin', userId: null, canDecideBudget: false, canDecideBash: false })
    expect(canDecide(approval(), admin)).toBe(false)
  })

  test('AC-7 (control): the same admin viewer decides it once the budget key is held', () => {
    const admin = approvalViewer({ kind: 'admin', userId: null, canDecideBudget: true })
    expect(canDecide(approval(), admin)).toBe(true)
    expect(canDecide(bashAsk(), admin)).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────────
// AC-6 — pages/[project]/fleet/approvals.vue and pages/admin/fleet/approvals.vue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Captures the `viewer` prop the approvals page hands the inbox. The page renders before the keys
 * arrive (fail-closed), so the recorder writes on every render and a test reads the last entry.
 */
function viewerRecorder(seen: Array<Record<string, unknown>>) {
  return defineComponent({
    name: 'StubFleetApprovalInbox',
    inheritAttrs: false,
    props: ['base', 'viewer', 'scopeLabel', 'nameOf', 'jobLink', 'projectName'],
    setup(props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
      return () => {
        seen.push({ ...props, ...attrs })
        return h('x-stub-stub', { 'data-stub': 'approval-inbox' })
      }
    },
  })
}

/** The viewer the approvals page handed the inbox once the keys had arrived. */
const lastViewer = (seen: Array<Record<string, unknown>>): unknown => seen[seen.length - 1]?.viewer

function mountProjectApprovals(project: readonly string[]): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = []
  const get = permissionsApi({ project })
  installPermissionsRuntime(get)
  track(mountSfc(webFile('pages', '[project]', 'fleet', 'approvals.vue'), {
    components: { ...uiStubs, FleetApprovalInbox: viewerRecorder(seen) },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useRoute: () => ({ params: { project: 'koda' } }),
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useAuth: () => ({ user: ref({ id: 'u1' }) }),
      navigateTo: jest.fn(async () => undefined),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
      useFleetDispatchOptions: () => ({
        repos: ref([]), runners: ref([]), repoName: (id: string) => id, runnerName: (id: string | null) => id,
        load: jest.fn(async () => undefined),
      }),
    },
  }))
  return seen
}

function mountAdminApprovals(global: readonly string[]): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = []
  const get = permissionsApi({ global })
  installPermissionsRuntime(get)
  track(mountSfc(webFile('pages', 'admin', 'fleet', 'approvals.vue'), {
    components: { ...uiStubs, FleetApprovalInbox: viewerRecorder(seen) },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useGlobalPermissions,
      useAuth: () => ({ user: ref({ id: 'u1' }) }),
      navigateTo: jest.fn(async () => undefined),
      useFleetRepos: () => ({ projects: ref([{ id: 'p1', slug: 'koda', name: 'Koda' }]), loadProjects: jest.fn(async () => undefined) }),
      useFleetRunners: () => ({ runners: ref([]), load: jest.fn(async () => undefined) }),
      useAdminUsers: () => ({ users: ref([]), load: jest.fn(async () => undefined) }),
    },
  }))
  return seen
}

describe('US-009 AC-6: both approvals pages build their viewer from the decision keys', () => {
  test('AC-6: the project page answers canDecideBudget/canDecideBash from the project set', async () => {
    const seen = mountProjectApprovals(['fleet.approval.decide.bash'])
    await settle()

    expect(lastViewer(seen)).toEqual({ kind: 'project', userId: 'u1', canDecideBudget: false, canDecideBash: true })
  })

  test('AC-6: the project page follows the budget key too, and holds neither without them', async () => {
    const both = mountProjectApprovals(['fleet.approval.decide.budget', 'fleet.approval.decide.bash'])
    await settle()
    expect(lastViewer(both)).toMatchObject({ kind: 'project', canDecideBudget: true, canDecideBash: true })

    const none = mountProjectApprovals([])
    await settle()
    expect(lastViewer(none)).toEqual({ kind: 'project', userId: 'u1', canDecideBudget: false, canDecideBash: false })
  })

  test('AC-6: the admin page answers the same two flags from the global set', async () => {
    const seen = mountAdminApprovals(['fleet.approval.decide.budget'])
    await settle()

    expect(lastViewer(seen)).toEqual({ kind: 'admin', userId: 'u1', canDecideBudget: true, canDecideBash: false })
  })

  test('AC-6 (control): a global admin holding neither key decides nothing, whatever the account role', async () => {
    const seen = mountAdminApprovals(['user.read'])
    await settle()

    expect(lastViewer(seen)).toEqual({ kind: 'admin', userId: 'u1', canDecideBudget: false, canDecideBash: false })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-8, AC-10, AC-11 — composables/useApprovalNotifications.ts (mounted through the header badge)
// ─────────────────────────────────────────────────────────────────────────────

interface NotifyOver {
  /** The global-scope keys `/me/permissions` answers; a function lets a test change them between polls. */
  global: readonly string[] | (() => readonly string[])
  /** Per-project keys, by slug. A project not listed answers no key at all. */
  projects?: Record<string, readonly string[]>
  counts?: ApprovalCountsDto
  /** A path whose GET never settles (the global read, for AC-10). */
  hang?: readonly string[]
  /** A path whose GET rejects (the global read, for AC-11). */
  fail?: readonly string[]
  /** A path whose GET rejects with a specific error, e.g. `{ statusCode: 403 }`. */
  reject?: Record<string, unknown>
  /** The pending page one inbox path answers (`approvalRoot`), empty when not named. */
  rows?: Record<string, readonly unknown[]>
  /**
   * Answer the old membership route as a project ADMIN. Nothing reads it any more, but a harness that did
   * would scan on it — so AC-10/AC-11 cannot pass by a membership that simply never had the rights.
   */
  membersGrant?: boolean
  /**
   * The signed-in account the mounted badge reads through `useAuth().user`. Pass one so a spec can
   * change the identity (id or role) while a refresh is in flight; US-011's identity ACs need that.
   */
  user?: Ref<NotifyUser>
}

/** The account fields `useApprovalNotifications` reads from `auth.user`. */
interface NotifyUser {
  id: string
  role: string
}

/** A callable toast double that records what was shown and what was dismissed (`dismiss(toastId)`). */
function notifyToasts(): {
  toast: ((title: string, options?: { id?: string }) => string) & { dismiss: jest.Mock }
  calls: Array<{ title: string; id: string | undefined }>
  dismiss: jest.Mock
} {
  const calls: Array<{ title: string; id: string | undefined }> = []
  const dismiss = jest.fn()
  const toast = Object.assign(
    (title: string, options?: { id?: string }): string => { calls.push({ title, id: options?.id }); return 'toast' },
    { dismiss },
  )
  return { toast, calls, dismiss }
}

/** One pending approval the badge may notify about; `budget` decides which decide key it needs. */
const notifyRow = (id: string, projectId = 'p1', over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, type: 'budget_override_required', status: 'pending', projectId, jobId: null, policyId: null,
  payload: {}, requestedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, outcome: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
})

const notifyCounts = (projects: string[]): ApprovalCountsDto => ({
  total: projects.length,
  unscoped: 0,
  projects: projects.map((slug, index) => ({ projectId: `p${index}`, slug, pending: 1 })),
} as ApprovalCountsDto)

/**
 * Mounts the real header badge — and through it the real `useApprovalNotifications` — over a `$api.get`
 * that answers `/me/permissions`, the approval counts and one pending page per inbox. Every call is
 * recorded in order, which is what the scan ACs assert on.
 */
function mountNotifications(over: NotifyOver): {
  app: Mounted
  get: jest.Mock
  paths: () => string[]
  toasts: ReturnType<typeof notifyToasts>
  poll: () => Promise<void>
  /** The shared account ref the mounted badge reads; replacing it switches identity mid-refresh. */
  user: Ref<NotifyUser>
  /**
   * Paths whose GET is held open: add one before `poll()` so a spec can change the identity while a
   * refresh is really running, then resolve the recorded call on `pending`.
   */
  defer: Set<string>
  /** The held-open GETs, in call order. */
  pending: Array<{ path: string; resolve: (body: unknown) => void }>
} {
  const counts = over.counts ?? notifyCounts([])
  const globalKeys = (): readonly string[] => (typeof over.global === 'function' ? over.global() : over.global)
  const user: Ref<NotifyUser> = over.user ?? ref({ id: 'u1', role: 'MEMBER' })
  const defer = new Set<string>()
  const pending: Array<{ path: string; resolve: (body: unknown) => void }> = []
  const get = jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
    if (defer.has(path)) return new Promise(resolve => { pending.push({ path, resolve }) })
    if (over.reject && path in over.reject) throw over.reject[path]
    if (over.fail?.includes(path)) throw new Error(`failed ${path}`)
    if (over.hang?.includes(path)) return new Promise(() => undefined)
    if (path === '/fleet/approval-counts') return counts
    if (over.membersGrant === true && path.endsWith('/members')) return { viewerRole: 'ADMIN', canManage: true }
    if (path === '/me/permissions') {
      const project = options?.query?.project
      return project === undefined
        ? { scope: 'global', projectSlug: null, keys: [...globalKeys()] }
        : { scope: 'project', projectSlug: project, keys: [...(over.projects?.[project] ?? [])] }
    }
    return { records: [...(over.rows?.[path] ?? [])], total: 0, current: 1, size: 100, hasNext: false }
  })
  installPermissionsRuntime(get)
  const polling = pollingDouble()
  const toasts = notifyToasts()
  const state = new Map<string, unknown>()
  const app = track(mountSfc(webFile('components', 'fleet', 'ApprovalBadge.vue'), {
    components: uiStubs,
    props: { slug: null },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useI18n: () => pageI18n(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      // The badge's own link target is AC-9's subject; these ACs are about the notification scans.
      useGlobalPermissions: () => globalPermissionsStub(globalKeys()),
      useState: (key: string, init: () => unknown) => {
        if (!state.has(key)) state.set(key, ref(init()))
        return state.get(key)
      },
      useAuth: () => ({ user }),
      useAppToast: () => toasts.toast,
      useHead: () => undefined,
      navigateTo: jest.fn(async () => undefined),
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        (polling.capture as (t: () => Promise<void>) => void)(pageTask)
        return polling
      },
    },
  }))
  const paths = (): string[] => (get.mock.calls as unknown as [string][]).map(([path]) => path)
  return { app, get, paths, toasts, poll: () => (polling.runNow as () => Promise<void>)(), user, defer, pending }
}

/** First index of `path` in the recorded call order, or -1. */
const callIndex = (paths: readonly string[], path: string): number => paths.indexOf(path)

const INBOX_CALL = (path: string): boolean => /\/fleet\/approvals$/.test(path)

describe('US-009 AC-8: the notification scan reads /me/permissions before it scans anything', () => {
  test('AC-8: the global read comes first, and fleet.approval.read scans the admin inbox', async () => {
    const { app, paths } = mountNotifications({ global: ['fleet.approval.read'], counts: notifyCounts(['beta']) })
    await settle()
    const calls = paths()

    expect(calls[0]).toBe('/fleet/approval-counts')
    expect(callIndex(calls, '/me/permissions')).toBeGreaterThan(0)
    expect(callIndex(calls, '/me/permissions')).toBeLessThan(callIndex(calls, '/fleet/approvals'))
    expect(calls).toContain('/fleet/approvals')
    expect(calls.filter((path) => path.startsWith('/projects/'))).toEqual([])
    app.unmount()
  })

  test('AC-8: without it, each project is asked with query.project and only a decide key scans it', async () => {
    const { app, paths } = mountNotifications({
      global: ['user.read'],
      counts: notifyCounts(['beta', 'gamma', 'delta']),
      projects: {
        beta: ['fleet.approval.decide.budget'],
        gamma: ['fleet.job.dispatch'],
        delta: ['fleet.approval.decide.bash'],
      },
    })
    await settle()
    const calls = paths()

    expect(calls).not.toContain('/fleet/approvals')
    expect(calls).toContain('/projects/beta/fleet/approvals')
    expect(calls).toContain('/projects/delta/fleet/approvals')
    expect(calls).not.toContain('/projects/gamma/fleet/approvals')
    // The membership read the old gate used is gone.
    expect(calls.filter((path) => path.endsWith('/members'))).toEqual([])
    // Each inbox is decided after its own project-scope permission read.
    expect(callIndex(calls, '/me/permissions')).toBeLessThan(callIndex(calls, '/projects/beta/fleet/approvals'))
    app.unmount()
  })

  test('AC-8 (control): a project holding no decide key is never scanned, even when the inbox has pending rows', async () => {
    const { app, paths } = mountNotifications({
      global: [],
      counts: notifyCounts(['beta']),
      projects: { beta: ['fleet.approval.read'] },
    })
    await settle()

    expect(paths().filter(INBOX_CALL)).toEqual([])
    app.unmount()
  })
})

describe('US-009 AC-10: no scan starts while the global read is pending', () => {
  test('AC-10: a hanging /me/permissions leaves both inboxes unscanned', async () => {
    const { app, paths } = mountNotifications({
      global: ['fleet.approval.read'],
      counts: notifyCounts(['beta']),
      projects: { beta: ['fleet.approval.decide.budget'] },
      membersGrant: true,
      hang: ['/me/permissions'],
    })
    await settle()

    expect(paths()).toContain('/me/permissions')
    expect(paths().filter(INBOX_CALL)).toEqual([])
    expect(paths()).not.toContain('/projects/beta/fleet/approvals')
    app.unmount()
  })
})

describe('US-009 AC-11: a failed global read scans nothing', () => {
  test('AC-11: a rejected /me/permissions leaves both inboxes unscanned', async () => {
    const { app, paths } = mountNotifications({
      global: ['fleet.approval.read'],
      counts: notifyCounts(['beta']),
      projects: { beta: ['fleet.approval.decide.budget'] },
      membersGrant: true,
      fail: ['/me/permissions'],
    })
    await settle()

    expect(paths()).toContain('/me/permissions')
    expect(paths().filter(INBOX_CALL)).toEqual([])
    expect(paths()).not.toContain('/projects/beta/fleet/approvals')
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — components/fleet/ApprovalBadge.vue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mounts the real badge with the REAL `useGlobalPermissions`, outside a project (so the link target is the
 * `globalAdmin` branch of `badgeTarget`) and with one project holding the pending count.
 */
function mountBadge(global: readonly string[]): { app: Mounted; target: () => unknown } {
  const get = permissionsApi({ global, routes: { '/fleet/approval-counts': notifyCounts(['beta']) } })
  installPermissionsRuntime(get)
  const polling = pollingDouble()
  const toasts = notifyToasts()
  const state = new Map<string, unknown>()
  const app = track(mountSfc(webFile('components', 'fleet', 'ApprovalBadge.vue'), {
    components: uiStubs,
    props: { slug: null },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useI18n: () => pageI18n(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useGlobalPermissions,
      useState: (key: string, init: () => unknown) => {
        if (!state.has(key)) state.set(key, ref(init()))
        return state.get(key)
      },
      useAuth: () => ({ user: ref({ id: 'u1', role: 'MEMBER' }) }),
      useAppToast: () => toasts.toast,
      useHead: () => undefined,
      navigateTo: jest.fn(async () => undefined),
      useVisiblePolling: (pageTask: () => Promise<void>) => {
        (polling.capture as (t: () => Promise<void>) => void)(pageTask)
        return polling
      },
    },
  }))
  return { app, target: () => byTestId(app, 'fleet-approval-badge')?.props.to }
}

describe('US-009 AC-9: the badge links to the inbox the global read key opens', () => {
  test('AC-9: fleet.approval.read in the global set targets the admin approvals page', async () => {
    const { app, target } = mountBadge(['fleet.approval.read'])
    await settle()

    expect(target()).toBe('/admin/fleet/approvals')
    app.unmount()
  })

  test('AC-9: without it the badge falls back to a project inbox, even for a role that used to be enough', async () => {
    const { app, target } = mountBadge(['user.read', 'fleet.dashboard.read'])
    await settle()

    expect(target()).toBe('/beta/fleet/approvals')
    app.unmount()
  })

  test('AC-9 (edge): a pending global read links to no admin inbox (fail closed)', async () => {
    const get = permissionsApi({ hang: ['/me/permissions'], routes: { '/fleet/approval-counts': notifyCounts(['beta']) } })
    installPermissionsRuntime(get)
    const polling = pollingDouble()
    const state = new Map<string, unknown>()
    const app = track(mountSfc(webFile('components', 'fleet', 'ApprovalBadge.vue'), {
      components: uiStubs,
      props: { slug: null },
      globals: {
        ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
        useI18n: () => pageI18n(),
        useApi: () => ({ $api: { get } }),
        useAsyncData: fakeAsyncData,
        useGlobalPermissions,
        useState: (key: string, init: () => unknown) => {
          if (!state.has(key)) state.set(key, ref(init()))
          return state.get(key)
        },
        useAuth: () => ({ user: ref({ id: 'u1', role: 'MEMBER' }) }),
        useAppToast: () => toastRecorder(),
        useHead: () => undefined,
        navigateTo: jest.fn(async () => undefined),
        useVisiblePolling: (pageTask: () => Promise<void>) => {
          (polling.capture as (t: () => Promise<void>) => void)(pageTask)
          return polling
        },
      },
    }))
    await settle()

    expect(byTestId(app, 'fleet-approval-badge')?.props.to).toBe('/beta/fleet/approvals')
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 1 — per-project failure isolation and admin revalidation
// ─────────────────────────────────────────────────────────────────────────────

describe('US-009 AC-8 (fix round 1): one refused inbox does not stop the other projects', () => {
  test('AC-8: a project whose inbox rejects is skipped, and the next project still notifies', async () => {
    const { app, paths, toasts } = mountNotifications({
      global: [],
      counts: notifyCounts(['beta', 'gamma']),
      projects: { beta: ['fleet.approval.decide.budget'], gamma: ['fleet.approval.decide.budget'] },
      // A decide key without fleet.approval.read: the list route refuses this caller.
      reject: { '/projects/beta/fleet/approvals': { statusCode: 403 } },
      rows: { '/projects/gamma/fleet/approvals': [notifyRow('g1')] },
    })
    await settle()

    expect(paths()).toContain('/projects/gamma/fleet/approvals')
    expect(toasts.calls).toHaveLength(1)
    app.unmount()
  })

  test('AC-8: a 403 on a project\'s inbox closes that project\'s alerts, and leaves another project\'s alone', async () => {
    const rows: Record<string, readonly unknown[]> = {
      '/projects/beta/fleet/approvals': [notifyRow('b1')],
      '/projects/gamma/fleet/approvals': [notifyRow('g1')],
    }
    const reject: Record<string, unknown> = {}
    const { app, toasts, poll } = mountNotifications({
      global: [],
      counts: notifyCounts(['beta', 'gamma']),
      projects: { beta: ['fleet.approval.decide.budget'], gamma: ['fleet.approval.decide.budget'] },
      rows,
      reject,
    })
    await settle()
    expect(toasts.calls.map((call) => call.id)).toEqual(['fleet-approval-u1-b1', 'fleet-approval-u1-g1'])

    // The next refresh is refused for beta only; gamma's ask is still pending and stays on screen.
    reject['/projects/beta/fleet/approvals'] = { statusCode: 403 }
    await poll()

    expect(toasts.dismiss.mock.calls).toEqual([['fleet-approval-u1-b1']])
    app.unmount()
  })
})

describe('US-009 (fix round 1): the admin branch revalidates the alerts it already shows', () => {
  test('AC-2/AC-8: losing fleet.approval.decide.budget closes an admin alert it can no longer answer', async () => {
    let global: readonly string[] = ['fleet.approval.read', 'fleet.approval.decide.budget']
    const { app, toasts, poll } = mountNotifications({
      global: () => global,
      counts: notifyCounts([]),
      rows: { '/fleet/approvals': [notifyRow('a1')] },
    })
    await settle()
    expect(toasts.calls.map((call) => call.id)).toEqual(['fleet-approval-u1-a1'])

    // fleet.approval.read stays: the inbox is still read, but this viewer may no longer decide a budget ask.
    global = ['fleet.approval.read']
    await poll()

    expect(toasts.dismiss.mock.calls).toEqual([['fleet-approval-u1-a1']])
    app.unmount()
  })

  test('AC-2: keeping the budget key keeps the alert on screen', async () => {
    let global: readonly string[] = ['fleet.approval.read', 'fleet.approval.decide.budget']
    const { app, toasts, poll } = mountNotifications({
      global: () => global,
      counts: notifyCounts([]),
      rows: { '/fleet/approvals': [notifyRow('a1')] },
    })
    await settle()
    global = ['fleet.approval.read', 'fleet.approval.decide.budget']
    await poll()

    expect(toasts.dismiss).not.toHaveBeenCalled()
    expect(toasts.calls).toHaveLength(1)
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Permissions P1 US-011 — the notification identity is the user id, not (id, role)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The identity a refresh is keyed on. A same-id role swap is not a different account, so it must not
 * throw away a refresh that is already running; an id change is, so it must.
 */
describe('US-011: useApprovalNotifications keys a refresh on the user id alone', () => {
  /** One pending budget ask, answered by the admin inbox; the badge holds the decision keys below. */
  const KEYS = ['fleet.approval.read', 'fleet.approval.decide.budget']
  const page = (id: string): Record<string, unknown> => ({
    records: [notifyRow(id)], total: 1, current: 1, size: 100, hasNext: false,
  })

  test('AC-7: a role-only change during a running refresh keeps that refresh\'s result', async () => {
    const m = mountNotifications({
      global: KEYS,
      counts: notifyCounts([]),
      rows: { '/fleet/approvals': [notifyRow('a1')] },
    })
    await settle()
    // The mount's own refresh delivered the first ask.
    expect(m.toasts.calls.map((call) => call.id)).toEqual(['fleet-approval-u1-a1'])

    // The next refresh reaches the inbox scan and is held there, so the identity change lands mid-flight.
    m.defer.add('/fleet/approvals')
    const running = m.poll()
    await settle()
    expect(m.pending.map((call) => call.path)).toEqual(['/fleet/approvals'])

    // Same account, other legacy role value: the refresh still belongs to this user.
    m.user.value = { id: 'u1', role: 'ADMIN' }
    await settle()

    // Both asks are pending, so a complete scan notifies the new one and dismisses nothing.
    m.pending[0]?.resolve({
      records: [notifyRow('a1'), notifyRow('a2')], total: 2, current: 1, size: 100, hasNext: false,
    })
    await running
    await settle()

    expect(m.toasts.calls.map((call) => call.id)).toContain('fleet-approval-u1-a2')
    // ...and the running refresh was not torn down either: nothing of this identity's was dismissed.
    expect(m.toasts.dismiss).not.toHaveBeenCalled()
    m.app.unmount()
  })

  test('AC-8: an id change during a running refresh discards that refresh\'s result', async () => {
    const m = mountNotifications({
      global: KEYS,
      counts: notifyCounts([]),
      rows: { '/fleet/approvals': [notifyRow('a1')] },
    })
    await settle()
    expect(m.toasts.calls.map((call) => call.id)).toEqual(['fleet-approval-u1-a1'])

    m.defer.add('/fleet/approvals')
    const running = m.poll()
    await settle()
    expect(m.pending.map((call) => call.path)).toEqual(['/fleet/approvals'])

    // A different account: the answer the u1 refresh is waiting for is no longer this caller's.
    m.user.value = { id: 'u2', role: 'MEMBER' }
    await settle()

    m.pending[0]?.resolve(page('a2'))
    await running
    await settle()

    expect(m.toasts.calls.map((call) => call.id)).not.toContain('fleet-approval-u1-a2')
    expect(m.toasts.calls.map((call) => call.id)).not.toContain('fleet-approval-u2-a2')
    m.app.unmount()
  })
})
