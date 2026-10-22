import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as protocol from '@nathapp/fleet-protocol'
import { canCancelJob, canRequeueJob } from '~/lib/fleet-jobs'
import type { JobViewer } from '~/lib/fleet-jobs'
import type { BudgetPolicyDto, ConfigJobOutcomeDto, FleetJobConfigEditDto, FleetJobDto } from '~/lib/fleet-types'
import { useGlobalPermissions, useProjectPermissions } from '~/composables/usePermissions'
import { useFleetRunners } from '~/composables/useFleetRunners'
import * as apiModule from '../../composables/useApi'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { fakeAsyncData, resetAsyncCalls } from '../helpers/permission-nav'

/**
 * Permissions P1 US-008: the fleet job, dispatch, repo-config and budget gates.
 *
 * Every gate AC mounts the REAL page (or the real table) with the REAL `useProjectPermissions` /
 * `useGlobalPermissions` composable; the only thing a test supplies is `$api.get('/me/permissions')`,
 * which answers the key list for the scope being asked for. So a control that still read a role
 * boolean fails here, and the whole permission path (fetch, fail-closed default, key lookup) runs
 * instead of being mocked away.
 */

const g = globalThis as Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// shared harness
// ─────────────────────────────────────────────────────────────────────────────

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
  /** A path whose GET never settles: the page is left with the fail-closed permission set. */
  hang?: readonly string[]
}

/**
 * A `$api.get` that answers the permissions endpoint from the given key lists and every other path
 * from `routes`. `/me/permissions` without a query is the global scope; with `?project=` it is that
 * project's scope, exactly as the API answers (US-001).
 */
function permissionsApi(answer: RouteAnswer, fallback: unknown = {}): jest.Mock {
  return jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
    if (answer.hang?.includes(path)) return new Promise(() => undefined)
    if (path === '/me/permissions') {
      const project = options?.query?.project
      return project === undefined
        ? { scope: 'global', projectSlug: null, keys: [...(answer.global ?? [])] }
        : { scope: 'project', projectSlug: project, keys: [...(answer.project ?? [])] }
    }
    if (answer.routes && path in answer.routes) return answer.routes[path]
    return fallback
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

const byTestId = (app: Mounted, testId: string): FakeNode | undefined =>
  app.find(`[data-testid="${testId}"]`)[0]

/** A component the spec does not assert on: it renders nothing, so it cannot influence an assertion. */
function inert(name: string) {
  return defineComponent({ name, setup: () => () => null })
}

/** Renders its slots/attrs as one inert element, for the selects and wrappers a page only nests. */
function slotStub(tag: string) {
  return defineComponent({
    name: `Stub-${tag}`,
    inheritAttrs: false,
    setup(_props: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
      return () => {
        const children = Object.values(slots).flatMap((slot) => {
          const rendered = slot?.()
          if (Array.isArray(rendered)) return rendered
          return rendered === undefined || rendered === null ? [] : [rendered]
        })
        return h('x-stub-stub', { ...attrs, 'data-stub': tag }, children as never)
      }
    },
  })
}

/** The banner fetches on mount and the jobs list nudges it through this handle. */
const BannerStub = defineComponent({
  name: 'StubFleetBudgetBanner',
  props: { slug: { type: String, default: '' }, repoName: { type: Function, default: () => null } },
  setup(_props: unknown, { expose, attrs }: { expose: (value: Record<string, unknown>) => void; attrs: Record<string, unknown> }) {
    expose({ refresh: async (): Promise<void> => undefined })
    return () => h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-budget-banner' })
  },
})

const SELECT_STUBS = {
  Select: slotStub('select'),
  SelectTrigger: slotStub('select-trigger'),
  SelectValue: slotStub('select-value'),
  SelectContent: slotStub('select-content'),
  SelectItem: slotStub('select-item'),
}

beforeEach(() => {
  // The budgets pages confirm a delete through window.confirm and the job page reads no window.
  g.window = { confirm: (): boolean => true }
})

afterEach(() => {
  delete g.window
  delete g.useAsyncData
  delete g.useApi
  resetAsyncCalls()
})

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

const jobFixture = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null,
  profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600, pendingApprovals: 0,
  selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1, state: 'COMPLETED',
  stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null,
  naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0.0000',
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null,
  resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null,
  scheduleId: null, coalescedCount: 0, tickets: null, configEdit: null, workflow: null,
  ...over,
} as unknown as FleetJobDto)

/** A `JobViewer` with the flags a test does not name switched off. */
const viewer = (over: Partial<JobViewer> = {}): JobViewer => ({
  userId: 'u2', canCancel: false, canRequeue: false, canDispatch: false, ...over,
})

const configEdit = (mode: FleetJobConfigEditDto['mode'], outcome: ConfigJobOutcomeDto | null): FleetJobConfigEditDto => ({
  mode, files: [], prTitle: null, result: outcome === null ? null : { outcome } as FleetJobConfigEditDto['result'],
})

const policy = (id: string, over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id, scopeType: 'project', scopeId: 'p1', projectId: 'p1', windowKind: 'calendar_month_utc', amountUsd: '5.0000',
  warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-1, AC-2, AC-10, AC-11 — lib/fleet-jobs.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('US-008 AC-1: cancel is fleet.job.cancel or the requester, on an unfinished job', () => {
  test('AC-1: the holder of fleet.job.cancel may cancel somebody else\'s job; so may its requester; nobody else', () => {
    const running = jobFixture({ state: 'RUNNING', requestedById: 'u1' })

    expect(canCancelJob(running, viewer({ userId: 'u2', canCancel: true }))).toBe(true)
    expect(canCancelJob(running, viewer({ userId: 'u1', canCancel: false }))).toBe(true)
    expect(canCancelJob(running, viewer({ userId: 'u2', canCancel: false }))).toBe(false)
  })

  test('AC-1 (edge): a signed-out caller holding no key cannot claim someone else\'s job', () => {
    const running = jobFixture({ state: 'RUNNING', requestedById: 'u1' })
    expect(canCancelJob(running, viewer({ userId: null, canCancel: false }))).toBe(false)
  })
})

describe('US-008 AC-2: requeue follows fleet.job.requeue alone', () => {
  test('AC-2: a requeueable FAILED job is requeued with canRequeue and not without it', () => {
    const failed = jobFixture({ state: 'FAILED', configEdit: null })
    expect(canRequeueJob(failed, viewer({ canRequeue: true }))).toBe(true)
    expect(canRequeueJob(failed, viewer({ canRequeue: false }))).toBe(false)
  })

  test('AC-2 (control): an unfollowed canCancel does not open requeue', () => {
    const failed = jobFixture({ state: 'FAILED', configEdit: null })
    expect(canRequeueJob(failed, viewer({ canCancel: true, canRequeue: false }))).toBe(false)
  })
})

describe('US-008 AC-10: a terminal job is never cancellable', () => {
  test('AC-10: COMPLETED with the key and the matching requester still hides cancel', () => {
    const done = jobFixture({ state: 'COMPLETED', requestedById: 'u1' })
    expect(canCancelJob(done, viewer({ userId: 'u1', canCancel: true }))).toBe(false)
  })

  test('AC-10 (control): every terminal state is refused; an active one is not', () => {
    for (const state of ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'] as const) {
      expect(canCancelJob(jobFixture({ state, requestedById: 'u1' }), viewer({ userId: 'u1', canCancel: true }))).toBe(false)
    }
    expect(canCancelJob(jobFixture({ state: 'QUEUED' }), viewer({ userId: 'u1', canCancel: true }))).toBe(true)
  })
})

describe('US-008 AC-11: an unrecoverable config edit is never requeueable', () => {
  test('AC-11: an edit that ended in conflict or invalid stays unrequeueable even with canRequeue', () => {
    for (const outcome of ['conflict', 'invalid'] as const) {
      const job = jobFixture({ state: 'FAILED', configEdit: configEdit('edit', outcome) })
      expect(canRequeueJob(job, viewer({ canRequeue: true }))).toBe(false)
    }
  })

  test('AC-11 (control): a push failure and a drift job keep requeue', () => {
    expect(canRequeueJob(jobFixture({ state: 'FAILED', configEdit: configEdit('edit', 'push_failed') }), viewer({ canRequeue: true }))).toBe(true)
    expect(canRequeueJob(jobFixture({ state: 'FAILED', configEdit: configEdit('drift', 'invalid') }), viewer({ canRequeue: true }))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 — pages/[project]/fleet/index.vue and pages/[project]/fleet/dispatch.vue
// ─────────────────────────────────────────────────────────────────────────────

function mountFleetIndex(project: readonly string[]): Mounted {
  const get = permissionsApi({ project })
  installPermissionsRuntime(get)
  return mountSfc(webFile('pages', '[project]', 'fleet', 'index.vue'), {
    components: {
      ...uiStubs,
      ...SELECT_STUBS,
      FilterBar: slotStub('filter-bar'),
      FleetBudgetBanner: BannerStub,
      FleetJobStateBadge: inert('StubStateBadge'),
      RepoConfigList: inert('StubRepoConfigList'),
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'koda' } }),
      navigateTo: jest.fn(async () => undefined),
      useProjectEvents: () => undefined,
      useFleetJobs: () => ({ jobs: ref([]), total: ref(0), hasNext: ref(false), load: jest.fn(async () => true) }),
      useFleetDispatchOptions: () => ({
        repos: ref([]), runners: ref([]), repoName: (id: string) => id, runnerName: (id: string | null) => id,
        load: jest.fn(async () => undefined),
      }),
      useProjectMemberNames: () => ({ members: ref([]), nameOf: () => null, load: jest.fn(async () => undefined) }),
    },
  })
}

function mountDispatchPage(project: readonly string[]): Mounted {
  const get = permissionsApi({ project })
  installPermissionsRuntime(get)
  return mountSfc(webFile('pages', '[project]', 'fleet', 'dispatch.vue'), {
    components: { ...uiStubs, FleetTicketPicker: inert('StubTicketPicker'), FleetTokenListInput: inert('StubTokenInput') },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'koda' }, query: {} }),
      navigateTo: jest.fn(async () => undefined),
      useFleetJobs: () => ({ dispatch: jest.fn(), findActiveJob: jest.fn(async () => null) }),
      useFleetDispatchOptions: () => ({
        repos: ref([{ id: 'r1', owner: 'acme', name: 'app', defaultBranch: 'main' }]),
        runners: ref([{ id: 'r1', name: 'box-1' }]), moreRepos: ref(false), moreRunners: ref(false),
        profileOptions: ref([]), labelOptions: ref([]), repoName: (id: string) => id, runnerName: (id: string | null) => id,
        load: jest.fn(async () => undefined),
      }),
    },
  })
}

describe('US-008 AC-3: dispatch follows fleet.job.dispatch', () => {
  test('AC-3: the fleet index enables its dispatch button with the key', async () => {
    const app = mountFleetIndex(['fleet.job.dispatch'])
    await settle()

    expect(byTestId(app, 'fleet-dispatch-button')?.props.disabled).toBe(false)
    app.unmount()
  })

  test('AC-3 (control): without the key the button stays visible but disabled', async () => {
    const app = mountFleetIndex(['fleet.job.cancel', 'fleet.job.requeue'])
    await settle()

    expect(byTestId(app, 'fleet-dispatch-button')).toBeDefined()
    expect(byTestId(app, 'fleet-dispatch-button')?.props.disabled).toBe(true)
    app.unmount()
  })

  test('AC-3: the dispatch page renders its no-permission notice without the key', async () => {
    const app = mountDispatchPage(['fleet.job.cancel'])
    await settle()

    expect(byTestId(app, 'dispatch-no-permission')).toBeDefined()
    expect(byTestId(app, 'dispatch-form')).toBeUndefined()
    app.unmount()
  })

  test('AC-3 (control): with the key the form renders and the notice does not', async () => {
    const app = mountDispatchPage(['fleet.job.dispatch'])
    await settle()

    expect(byTestId(app, 'dispatch-form')).toBeDefined()
    expect(byTestId(app, 'dispatch-no-permission')).toBeUndefined()
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-4, AC-5 — pages/[project]/fleet/jobs/[id]/index.vue
// ─────────────────────────────────────────────────────────────────────────────

/** Records the `canWork` prop the job page hands the config panel. */
const ConfigJobPanelRecorder = defineComponent({
  name: 'StubConfigJobPanel',
  props: { job: { type: Object, default: null }, slug: { type: String, default: '' }, canWork: { type: Boolean, default: false } },
  setup(props: { canWork: boolean }, { attrs }: { attrs: Record<string, unknown> }) {
    return () => h('x-stub-stub', { ...attrs, 'data-testid': 'config-job-panel', 'data-can-work': props.canWork === true ? 'true' : 'false' })
  },
})

interface JobDetailOver {
  job: FleetJobDto
  project?: readonly string[]
  userId?: string
}

function mountJobDetail(over: JobDetailOver): Mounted {
  const job = over.job
  const get = permissionsApi({ project: over.project ?? [] })
  installPermissionsRuntime(get)
  const analytics = inert('StubJobAnalytics')
  return mountSfc(webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue'), {
    components: { ...uiStubs, FleetBudgetBanner: BannerStub },
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useFleetApprovals': { useFleetApprovals: () => ({ listForJob: jest.fn(async () => []) }) },
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(new Date('2026-10-03T00:00:00.000Z')) }) },
      '~/components/fleet/FleetJobProgress.vue': { __esModule: true, default: inert('StubJobProgress') },
      '~/components/fleet/FleetJobStateBadge.vue': { __esModule: true, default: inert('StubStateBadge') },
      '~/components/fleet/FleetJobTimeline.vue': { __esModule: true, default: inert('StubJobTimeline') },
      '~/components/fleet/FleetJobWorkflow.vue': { __esModule: true, default: inert('StubJobWorkflow') },
      '~/components/fleet/FleetPlacementResult.vue': { __esModule: true, default: inert('StubPlacementResult') },
      '~/components/fleet/JobApprovals.vue': { __esModule: true, default: inert('StubJobApprovals') },
      '~/components/fleet/JobAnalytics.vue': { __esModule: true, default: analytics },
      '~/components/fleet/story-graph/FleetJobPipeline.vue': { __esModule: true, default: inert('StubJobPipeline') },
      '~/components/fleet/config/ConfigJobPanel.vue': { __esModule: true, default: ConfigJobPanelRecorder },
      '~/components/fleet/config/ConfigPrDialog.vue': { __esModule: true, default: inert('StubConfigPrDialog') },
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useRoute: () => ({ params: { project: 'koda', id: job.id } }),
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useAuth: () => ({ user: ref({ id: over.userId ?? 'u2' }) }),
      navigateTo: jest.fn(async () => undefined),
      useFleetJobs: () => ({
        get: jest.fn(async () => job),
        events: jest.fn(async () => ({ records: [], total: 0, current: 1, size: 50, hasNext: false, hasPrev: false })),
        cancel: jest.fn(), requeue: jest.fn(), downloadBundle: jest.fn(),
      }),
      useFleetDispatchOptions: () => ({
        load: jest.fn(async () => undefined), repoName: (id: string) => id, runnerName: (id: string | null) => id,
      }),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
      useFleetRepoConfig: () => ({ submitRegenerate: jest.fn() }),
      useFleetJobLogs: () => ({ list: jest.fn(async () => ({ attempts: [] })) }),
      useProjectEvents: () => undefined,
    },
  })
}

describe('US-008 AC-4: the job page gates cancel and requeue separately', () => {
  test('AC-4: fleet.job.requeue without fleet.job.cancel shows requeue on a requeueable job', async () => {
    const app = mountJobDetail({ project: ['fleet.job.requeue'], job: jobFixture({ state: 'FAILED' }) })
    await settle()

    expect(byTestId(app, 'fleet-job-requeue')).toBeDefined()
    expect(byTestId(app, 'fleet-job-cancel')).toBeUndefined()
    app.unmount()
  })

  test('AC-4: on an unfinished job a non-requester holding only fleet.job.requeue gets no cancel', async () => {
    const app = mountJobDetail({ project: ['fleet.job.requeue'], job: jobFixture({ state: 'RUNNING', requestedById: 'u1' }), userId: 'u2' })
    await settle()

    expect(byTestId(app, 'fleet-job-cancel')).toBeUndefined()
    app.unmount()
  })

  test('AC-4: the requester gets cancel on their own unfinished job without any key', async () => {
    const app = mountJobDetail({ project: [], job: jobFixture({ state: 'RUNNING', requestedById: 'u1' }), userId: 'u1' })
    await settle()

    expect(byTestId(app, 'fleet-job-cancel')).toBeDefined()
    expect(byTestId(app, 'fleet-job-requeue')).toBeUndefined()
    app.unmount()
  })

  test('AC-4 (control): fleet.job.cancel lets a non-requester cancel an unfinished job', async () => {
    const app = mountJobDetail({ project: ['fleet.job.cancel'], job: jobFixture({ state: 'RUNNING', requestedById: 'u1' }), userId: 'u2' })
    await settle()

    expect(byTestId(app, 'fleet-job-cancel')).toBeDefined()
    app.unmount()
  })

  test('AC-4 (control): a COMPLETED PLAN without fleet.job.dispatch offers no Dispatch run link', async () => {
    const app = mountJobDetail({
      project: ['fleet.job.cancel'],
      job: jobFixture({ state: 'COMPLETED', command: 'PLAN', resultBranch: 'nax/f' }),
    })
    await settle()

    expect(byTestId(app, 'fleet-job-dispatch-run')).toBeUndefined()
    app.unmount()
  })

  test('AC-4 (control): fleet.job.dispatch opens the Dispatch run hand-off on that same job', async () => {
    const app = mountJobDetail({
      project: ['fleet.job.dispatch'],
      job: jobFixture({ state: 'COMPLETED', command: 'PLAN', resultBranch: 'nax/f' }),
    })
    await settle()

    expect(byTestId(app, 'fleet-job-dispatch-run')).toBeDefined()
    app.unmount()
  })
})

describe('US-008 AC-5: the config panel follows fleet.job.config.edit', () => {
  test('AC-5: the key passes canWork true to ConfigJobPanel', async () => {
    const app = mountJobDetail({ project: ['fleet.job.config.edit'], job: jobFixture({ command: 'CONFIG_EDIT', state: 'COMPLETED' }) })
    await settle()

    expect(byTestId(app, 'config-job-panel')?.props['data-can-work']).toBe('true')
    app.unmount()
  })

  test('AC-5: without the key canWork is false', async () => {
    const app = mountJobDetail({ project: ['fleet.job.cancel', 'fleet.job.requeue'], job: jobFixture({ command: 'CONFIG_EDIT', state: 'COMPLETED' }) })
    await settle()

    expect(byTestId(app, 'config-job-panel')?.props['data-can-work']).toBe('false')
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-6 — pages/[project]/fleet/repos/[id]/config.vue
// ─────────────────────────────────────────────────────────────────────────────

const mdStub = {
  __esModule: true as const,
  default: {
    name: 'Md', props: ['modelValue'], emits: ['update:modelValue'],
    template: '<textarea data-testid="md-editor" :value="modelValue" />',
  },
}

const NAX_LIST = {
  baseSha: 'head1',
  defaultBranch: 'main',
  files: [
    { path: '.nax/context.md', size: 5, blobSha: 'ctx1', group: 'context' },
  ],
}

function mountConfigPage(project: readonly string[]): Mounted {
  const get = permissionsApi({ project })
  installPermissionsRuntime(get)
  const api = {
    list: jest.fn(async () => NAX_LIST),
    read: jest.fn(async (_repo: string, path: string) => ({ path, blobSha: 'ctx1', content: 'hello' })),
    submitEdit: jest.fn(async () => ({ job: { id: 'job-new' }, placement: {} })),
    submitRegenerate: jest.fn(),
    submitDrift: jest.fn(async () => ({ job: { id: 'job-drift' }, placement: {} })),
    jobEdits: jest.fn(),
    activeConfigJob: jest.fn(async () => null),
  }
  return mountSfc(webFile('pages', '[project]', 'fleet', 'repos', '[id]', 'config.vue'), {
    components: uiStubs,
    alias: {
      '@nathapp/fleet-protocol': protocol,
      '~/composables/useApi': apiModule,
      '~/components/MarkdownEditor.vue': mdStub,
      '~/components/fleet/config/ConfigPrDialog.vue': { __esModule: true, default: inert('StubConfigPrDialog') },
      '~/components/fleet/config/NewNaxFileDialog.vue': { __esModule: true, default: inert('StubNewNaxFileDialog') },
    },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      onBeforeRouteLeave: () => undefined,
      useRoute: () => ({ params: { project: 'koda', id: 'r1' }, query: {} }),
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useFleetRepoConfig: () => api,
      useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: () => 'acme/app' }),
      navigateTo: jest.fn(async () => undefined),
    },
  })
}

/** Opens the single file in the tree so the editor renders. */
async function openFirstFile(app: Mounted): Promise<void> {
  const file = app.find('[data-testid="nax-file"]')[0]
  if (!file) throw new Error('no nax file row rendered')
  ;(file.props.onClick as () => void)()
  await settle()
}

describe('US-008 AC-6: repo config splits editing from the drift check', () => {
  test('AC-6: fleet.repo.drift.check alone renders the drift button, no save or new file, and a read-only editor', async () => {
    const app = mountConfigPage(['fleet.repo.drift.check'])
    await settle()
    await openFirstFile(app)

    expect(byTestId(app, 'config-drift')).toBeDefined()
    expect(byTestId(app, 'config-save')).toBeUndefined()
    expect(byTestId(app, 'config-new-file')).toBeUndefined()
    expect(byTestId(app, 'config-delete-file')).toBeUndefined()
    expect(byTestId(app, 'nax-editor-readonly')).toBeDefined()
    app.unmount()
  })

  test('AC-6 (control): fleet.job.config.edit alone renders save and new file, and no drift button', async () => {
    const app = mountConfigPage(['fleet.job.config.edit'])
    await settle()
    await openFirstFile(app)

    expect(byTestId(app, 'config-save')).toBeDefined()
    expect(byTestId(app, 'config-new-file')).toBeDefined()
    expect(byTestId(app, 'config-drift')).toBeUndefined()
    expect(byTestId(app, 'nax-editor-readonly')).toBeUndefined()
    app.unmount()
  })

  test('AC-6 (control): neither key leaves the page with no action at all', async () => {
    const app = mountConfigPage([])
    await settle()
    await openFirstFile(app)

    for (const id of ['config-drift', 'config-save', 'config-new-file', 'config-delete-file']) {
      expect(byTestId(app, id)).toBeUndefined()
    }
    expect(byTestId(app, 'nax-editor-readonly')).toBeDefined()
    app.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — components/fleet/BudgetTable.vue
// ─────────────────────────────────────────────────────────────────────────────

interface TableCaps {
  resume?: boolean
  edit?: boolean
  remove?: boolean
}

function mountBudgetTable(policies: BudgetPolicyDto[], caps: TableCaps): Mounted {
  return mountSfc(webFile('components', 'fleet', 'BudgetTable.vue'), {
    components: uiStubs,
    props: { policies, canResume: caps.resume === true, canEdit: caps.edit === true, canDelete: caps.remove === true, scopeName: () => null },
    globals: { useI18n: () => pageI18n() },
  })
}

const rowLabels = (app: Mounted, id: string): string[] => {
  const row = app.find('[data-stub="tr"]').find((node) => node.props['data-testid'] === `fleet-budget-row-${id}`)
  if (!row) throw new Error(`no row ${id}`)
  return app.find('[data-stub="button"]', row).map((button) => app.textOf(button))
}

describe('US-008 AC-7: the budget table has three independent action keys', () => {
  test('AC-7: canResume alone offers Resume, and only on the paused row', () => {
    const app = mountBudgetTable([policy('ok'), policy('stop', { paused: true })], { resume: true })

    expect(rowLabels(app, 'ok')).toEqual([])
    expect(rowLabels(app, 'stop')).toEqual(['Resume'])
    app.unmount()
  })

  test('AC-7: canEdit alone offers Edit on every row', () => {
    const app = mountBudgetTable([policy('ok'), policy('stop', { paused: true })], { edit: true })

    expect(rowLabels(app, 'ok')).toEqual(['Edit'])
    expect(rowLabels(app, 'stop')).toEqual(['Edit'])
    app.unmount()
  })

  test('AC-7: canDelete alone offers Delete on every row', () => {
    const app = mountBudgetTable([policy('ok'), policy('stop', { paused: true })], { remove: true })

    expect(rowLabels(app, 'ok')).toEqual(['Delete'])
    expect(rowLabels(app, 'stop')).toEqual(['Delete'])
    app.unmount()
  })

  test('AC-7 (control): all three caps offer every action; none offers nothing', () => {
    const all = mountBudgetTable([policy('stop', { paused: true })], { resume: true, edit: true, remove: true })
    expect(rowLabels(all, 'stop')).toEqual(['Resume', 'Edit', 'Delete'])
    all.unmount()

    const none = mountBudgetTable([policy('stop', { paused: true })], {})
    expect(rowLabels(none, 'stop')).toEqual([])
    none.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-8, AC-9 — pages/[project]/fleet/budgets.vue and pages/admin/fleet/budgets.vue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stands in for the real table so a page test can read the three caps it forwards. The table's own
 * per-key rendering is AC-7's job; this asserts the wiring between the key set and the props.
 */
const BudgetTableRecorder = defineComponent({
  name: 'StubFleetBudgetTable',
  props: {
    policies: { type: Array, default: () => [] },
    canResume: { type: Boolean, default: false },
    canEdit: { type: Boolean, default: false },
    canDelete: { type: Boolean, default: false },
    scopeName: { type: Function, default: () => null },
    testid: { type: String, default: '' },
  },
  setup(props: { canResume: boolean; canEdit: boolean; canDelete: boolean; testid: string }, { attrs }: { attrs: Record<string, unknown> }) {
    return () => h('x-stub-stub', {
      ...attrs,
      'data-testid': props.testid,
      'data-can-resume': props.canResume === true ? 'true' : 'false',
      'data-can-edit': props.canEdit === true ? 'true' : 'false',
      'data-can-delete': props.canDelete === true ? 'true' : 'false',
    })
  },
})

const PROJECT_ROWS = [policy('pp'), policy('g', { scopeType: 'global', scopeId: null, projectId: null })]

function mountProjectBudgets(project: readonly string[], hang: readonly string[] = []): Mounted {
  const get = permissionsApi({ project, hang }, PROJECT_ROWS)
  installPermissionsRuntime(get)
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  return mountSfc(webFile('pages', '[project]', 'fleet', 'budgets.vue'), {
    components: { ...uiStubs, FleetBudgetTable: BudgetTableRecorder },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get, post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }),
      useAsyncData: fakeAsyncData,
      useProjectPermissions,
      useRoute: () => ({ params: { project: 'koda' } }),
      useProjectEvents: () => undefined,
      useVisiblePolling: (pageTask: () => Promise<void>) => { task = pageTask; return polling },
      useFleetDispatchOptions: () => ({
        repos: ref([{ id: 'r1', owner: 'acme', name: 'app' }]), repoName: (id: string) => id,
        load: jest.fn(async () => undefined),
      }),
    },
  })
}

function mountAdminBudgets(global: readonly string[]): Mounted {
  const get = permissionsApi({ global }, [policy('g', { scopeType: 'global', scopeId: null, projectId: null })])
  const withRunners = jest.fn(async (path: string, options?: { query?: Record<string, string> }) => {
    if (path === '/fleet/runners') {
      return { records: [{ id: 'r1', name: 'box-1' }], total: 1, current: 1, size: 100, hasNext: false, hasPrev: false }
    }
    return get(path, options)
  })
  installPermissionsRuntime(withRunners)
  let task: () => Promise<void> = async () => undefined
  const polling = { start: jest.fn(), stop: jest.fn(), runNow: async (): Promise<void> => { await task() }, isActive: () => true }
  return mountSfc(webFile('pages', 'admin', 'fleet', 'budgets.vue'), {
    components: { ...uiStubs, FleetBudgetTable: BudgetTableRecorder },
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => pageI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get: withRunners, post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }),
      useAsyncData: fakeAsyncData,
      useGlobalPermissions,
      useFleetRunners,
      useVisiblePolling: (pageTask: () => Promise<void>) => { task = pageTask; return polling },
    },
  })
}

const capsOf = (app: Mounted, testId: string): Record<string, unknown> | undefined => byTestId(app, testId)?.props

describe('US-008 AC-8: the budgets pages derive each table cap from its own key set', () => {
  test('AC-8: only create and resume render create and pass canResume, not canEdit or canDelete', async () => {
    const app = mountProjectBudgets(['fleet.budget.create', 'fleet.budget.resume'])
    await settle()

    expect(byTestId(app, 'fleet-budget-create')).toBeDefined()
    expect(capsOf(app, 'fleet-budgets-own')).toMatchObject({
      'data-can-resume': 'true', 'data-can-edit': 'false', 'data-can-delete': 'false',
    })
    app.unmount()
  })

  test('AC-8: fleet.budget.create alone opens the (create-mode) dialog its button needs', async () => {
    const app = mountProjectBudgets(['fleet.budget.create'])
    await settle()

    const dialog = app.find('[data-stub="fleet-budget-edit-dialog"]')[0]
    expect(dialog).toBeDefined()
    expect(dialog?.props['data-policy']).toBe('')
    app.unmount()
  })

  test('AC-8 (control): the remaining two keys travel through the same three props', async () => {
    const app = mountProjectBudgets(['fleet.budget.update', 'fleet.budget.delete'])
    await settle()

    expect(byTestId(app, 'fleet-budget-create')).toBeUndefined()
    expect(capsOf(app, 'fleet-budgets-own')).toMatchObject({
      'data-can-resume': 'false', 'data-can-edit': 'true', 'data-can-delete': 'true',
    })
    app.unmount()
  })

  test('AC-8: the admin page derives the same three props from the global set', async () => {
    const app = mountAdminBudgets(['fleet.budget.update'])
    await settle()

    expect(capsOf(app, 'fleet-budgets-admin')).toMatchObject({
      'data-can-resume': 'false', 'data-can-edit': 'true', 'data-can-delete': 'false',
    })
    app.unmount()
  })

  test('AC-8 (control): the admin page with all three global keys offers every action', async () => {
    const app = mountAdminBudgets(['fleet.budget.resume', 'fleet.budget.update', 'fleet.budget.delete'])
    await settle()

    expect(capsOf(app, 'fleet-budgets-admin')).toMatchObject({
      'data-can-resume': 'true', 'data-can-edit': 'true', 'data-can-delete': 'true',
    })
    app.unmount()
  })
})

describe('US-008 AC-9: an empty key set is a read-only budgets page', () => {
  test('AC-9: no project key renders the read-only notice and caps both tables at false', async () => {
    const app = mountProjectBudgets([])
    await settle()

    expect(byTestId(app, 'fleet-budget-readonly')).toBeDefined()
    expect(byTestId(app, 'fleet-budget-create')).toBeUndefined()
    for (const table of ['fleet-budgets-own', 'fleet-budgets-global']) {
      expect(capsOf(app, table)).toMatchObject({
        'data-can-resume': 'false', 'data-can-edit': 'false', 'data-can-delete': 'false',
      })
    }
    app.unmount()
  })

  test('AC-9 (control): holding any one budget key removes the notice', async () => {
    const app = mountProjectBudgets(['fleet.budget.delete'])
    await settle()

    expect(byTestId(app, 'fleet-budget-readonly')).toBeUndefined()
    app.unmount()
  })

  test('AC-9: the fleet-wide table is read-only even when every project key is held', async () => {
    const app = mountProjectBudgets([
      'fleet.budget.create', 'fleet.budget.resume', 'fleet.budget.update', 'fleet.budget.delete',
    ])
    await settle()

    expect(byTestId(app, 'fleet-budget-readonly')).toBeUndefined()
    expect(capsOf(app, 'fleet-budgets-global')).toMatchObject({
      'data-can-resume': 'false', 'data-can-edit': 'false', 'data-can-delete': 'false',
    })
    app.unmount()
  })

  test('AC-9 (edge): a pending key fetch fails closed — no create, no cap, the read-only notice', async () => {
    // The composable answers EMPTY_PERMISSIONS until the keys arrive, so a slow read must not
    // flash a control the caller may not have.
    const app = mountProjectBudgets(['fleet.budget.create'], ['/me/permissions'])
    await settle()

    expect(byTestId(app, 'fleet-budget-create')).toBeUndefined()
    expect(byTestId(app, 'fleet-budget-readonly')).toBeDefined()
    expect(capsOf(app, 'fleet-budgets-own')).toMatchObject({
      'data-can-resume': 'false', 'data-can-edit': 'false', 'data-can-delete': 'false',
    })
    app.unmount()
  })
})
