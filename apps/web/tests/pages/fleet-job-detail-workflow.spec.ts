import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, h, nextTick, reactive, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import type { FleetJobDto } from '../../lib/fleet-types'

const pageFile = webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue')

type JobOver = Partial<FleetJobDto> & Record<string, unknown>

const jobFixture = (over: JobOver = {}): FleetJobDto =>
  ({
    id: 'j1',
    projectId: 'p1',
    repoId: 'r1',
    ref: 'main',
    command: 'RUN',
    feature: 'login',
    planFrom: null,
    profiles: [],
    maxCostUsd: '5.0000',
    bashMode: 'raw',
    approvalTimeoutSec: 600,
    pendingApprovals: 0,
    selectorLabels: [],
    pinnedRunnerId: null,
    runnerId: null,
    leaseEpoch: 1,
    state: 'COMPLETED',
    stateReason: null,
    requestedById: 'u1',
    queuedAt: '2026-10-01T00:00:00.000Z',
    assignedAt: null,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    naxRunId: null,
    naxLogRunId: null,
    naxCostRunId: null,
    progress: null,
    currentStoryId: null,
    currentPhase: null,
    costSpentUsd: '0.0000',
    lastHeartbeatAt: null,
    finishResult: null,
    escalationReason: null,
    exitCode: null,
    resultBranch: null,
    resultSha: null,
    resultPrUrl: null,
    wipPush: null,
    stories: null,
    storiesTruncated: false,
    postRun: null,
    scheduleId: null,
    coalescedCount: 0,
    tickets: null,
    configEdit: null,
    workflow: null,
    ...over,
  }) as unknown as FleetJobDto

const workflowValue = {
  runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03',
  outcome: 'draft',
  workflowPassed: true,
  reasons: ['CI failed: test'],
  openItems: [],
}

function mountPage(job: FleetJobDto) {
  const get = jest.fn(async () => job)
  const events = jest.fn(async () => ({ records: [], total: 0, current: 1, size: 50, hasNext: false, hasPrev: false }))
  const route = reactive({ params: { project: 'koda', id: 'j1' } })
  const stubAnalytics = {
    name: 'StubJobAnalytics',
    setup: () => () => h('div', { 'data-testid': 'stub-analytics' }),
  }
  const stubPrDialog = {
    name: 'StubConfigPrDialog',
    props: ['open', 'mode', 'busy'],
    setup: () => () => h('div', { 'data-testid': 'stub-pr-dialog' }),
  }
  const stubBanner = {
    name: 'StubFleetBudgetBanner',
    props: ['slug', 'repoName'],
    setup: () => () => h('div', { 'data-testid': 'stub-budget-banner' }),
  }
  const app = mountSfc(pageFile, {
    components: { ...uiStubs, FleetBudgetBanner: stubBanner },
    alias: {
      '~/composables/useApi': apiModule,
      '~/composables/useFleetApprovals': {
        useFleetApprovals: () => ({ listForJob: jest.fn(async () => []) }),
      },
      '~/composables/useApprovalCountdown': {
        useApprovalCountdown: () => ({ now: ref(new Date('2026-10-03T00:00:00.000Z')) }),
      },
      '~/components/fleet/JobAnalytics.vue': {
        __esModule: true,
        default: stubAnalytics,
      },
      '~/components/fleet/config/ConfigPrDialog.vue': {
        __esModule: true,
        default: stubPrDialog,
      },
    },
    globals: {
      ref,
      computed,
      watch,
      nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      definePageMeta: () => undefined,
      useRoute: () => route,
      useI18n: () => enI18n(),
      useAppToast: () => toastRecorder(),
      useAuth: () => ({ user: ref({ id: 'u1' }) }),
      useFleetJobs: () => ({
        get,
        events,
        cancel: jest.fn(),
        requeue: jest.fn(),
        downloadBundle: jest.fn(),
      }),
      useFleetDispatchOptions: () => ({
        load: jest.fn(async () => undefined),
        repoName: (id: string) => id,
        runnerName: (id: string | null) => id,
      }),
      useProjectMemberNames: () => ({
        load: jest.fn(async () => undefined),
        nameOf: () => null,
      }),
      useFleetRepoConfig: () => ({
        submitRegenerate: jest.fn(),
      }),
      useProjectViewerRole: () => ({
        data: ref({ canManage: false, viewerRole: 'VIEWER' }),
      }),
      useFleetJobLogs: () => ({
        list: jest.fn(async () => ({ attempts: [] })),
      }),
      useProjectEvents: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await nextTick()
    }
  }
  return { app, settle }
}

describe('job detail workflow (US-006)', () => {
  test('AC-8: a job with a non-null workflow renders the workflow outcome', async () => {
    const { app, settle } = mountPage(jobFixture({ workflow: workflowValue }))
    await settle()
    expect(app.find('[data-testid="fleet-job-workflow-outcome"]')).toHaveLength(1)
    app.unmount()
  })

  test('AC-9: a job with a null workflow renders no workflow outcome', async () => {
    const { app, settle } = mountPage(jobFixture({ workflow: null }))
    await settle()
    expect(app.find('[data-testid="fleet-job-workflow-outcome"]')).toHaveLength(0)
    app.unmount()
  })
})
