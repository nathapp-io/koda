import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'
import type { FleetJobDto } from '../../lib/fleet-types'

const g = globalThis as Record<string, unknown>

const jobFixture = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null,
  profiles: [], maxCostUsd: '5.0000', bashMode: 'approve', approvalTimeoutSec: 600, pendingApprovals: 0,
  selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1, state: 'RUNNING', stateReason: null,
  requestedById: 'u1', queuedAt: '2026-10-01T00:00:00.000Z', assignedAt: null, startedAt: null, finishedAt: null,
  cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', lastHeartbeatAt: null, finishResult: null, escalationReason: null,
  exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null,
  storiesTruncated: false, postRun: null, scheduleId: null, coalescedCount: 0, tickets: null, configEdit: null,
  workflow: null, ...over,
} as FleetJobDto)

function mountEnginePage(job: FleetJobDto, permissions: string[]) {
  const get = jest.fn(async () => ({ total: 0, current: 1, size: 100, hasNext: false, hasPrev: false, records: [] }))
  g.useApi = () => ({ $api: { get } })
  const app = mountSfc(webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue'), {
    components: {
      ...uiStubs,
      FleetBudgetBanner: defineComponent({
        name: 'StubFleetBudgetBanner',
        props: { slug: String, repoName: Function },
        setup: () => () => h('x-stub-stub', { 'data-stub': 'fleet-budget-banner' }),
      }),
    },
    alias: {
      '~/composables/useApi': apiModule,
      '~/components/fleet/FleetJobProgress.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/FleetJobStateBadge.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/FleetJobTimeline.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/FleetJobWorkflow.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/FleetPlacementResult.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/JobAnalytics.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/story-graph/FleetJobPipeline.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/config/ConfigJobPanel.vue': { __esModule: true, default: { setup: () => () => null } },
      '~/components/fleet/config/ConfigPrDialog.vue': { __esModule: true, default: { setup: () => () => null } },
    },
    globals: {
      ref, computed, watch, nextTick, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      definePageMeta: () => undefined, useRoute: () => ({ params: { project: 'koda', id: job.id } }),
      useI18n: () => enI18n(), useAppToast: () => toastRecorder(), useApi: () => ({ $api: { get } }),
      useAuth: () => ({ user: ref({ id: 'u2' }) }), useProjectPermissions: () => projectPermissionsStub(permissions),
      useFleetJobs: () => ({
        get: jest.fn(async () => job),
        events: jest.fn(async () => ({ records: [], total: 0, current: 1, size: 50, hasNext: false, hasPrev: false })),
        cancel: jest.fn(), requeue: jest.fn(), downloadBundle: jest.fn(),
      }),
      useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => id, runnerName: (id: string | null) => id }),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
      useFleetRepoConfig: () => ({ submitRegenerate: jest.fn() }),
      useFleetJobLogs: () => ({ list: jest.fn(async () => ({ attempts: [] })) }),
      useProjectEvents: () => undefined,
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await nextTick()
    }
  }
  return { app, settle, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

afterEach(() => { delete g.useApi; jest.useRealTimers() })

describe('completed REVIEW Fix action', () => {
  const review = () => jobFixture({ command: 'REVIEW', state: 'COMPLETED', feature: 'review-pr-23', profiles: ['native-codex'] })

  test('AC-1: renders Fix for a completed review when viewer can dispatch', async () => {
    const m = mountEnginePage(review(), ['fleet.job.dispatch'])
    await m.settle()
    expect(m.byId('fleet-job-dispatch-fix')).toHaveLength(1)
    m.app.unmount()
  })

  test('AC-2: Fix dispatch query contains only the PR prefill and copied profiles', async () => {
    const m = mountEnginePage(review(), ['fleet.job.dispatch'])
    await m.settle()
    expect(m.byId('fleet-job-dispatch-fix')[0].props.to).toEqual({
      path: '/koda/fleet/dispatch', query: { command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex'] },
    })
    m.app.unmount()
  })

  test('AC-3: Fix action uses the English locale value', async () => {
    const m = mountEnginePage(review(), ['fleet.job.dispatch'])
    await m.settle()
    expect(m.app.textOf(m.byId('fleet-job-dispatch-fix')[0])).toBe('Fix')
    m.app.unmount()
  })

  test('AC-4: Fix is hidden without dispatch permission', async () => {
    const m = mountEnginePage(review(), [])
    await m.settle()
    expect(m.byId('fleet-job-dispatch-fix')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-5: Fix is hidden for a failed review', async () => {
    const m = mountEnginePage(jobFixture({ ...review(), state: 'FAILED' }), ['fleet.job.dispatch'])
    await m.settle()
    expect(m.byId('fleet-job-dispatch-fix')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-6: completed PLAN retains the Dispatch run handoff unchanged', async () => {
    const m = mountEnginePage(jobFixture({ command: 'PLAN', state: 'COMPLETED', feature: 'login', resultBranch: 'feat/login', tickets: [] }), ['fleet.job.dispatch'])
    await m.settle()
    expect(m.byId('fleet-job-dispatch-run')).toHaveLength(1)
    expect(m.byId('fleet-job-dispatch-run')[0].props.to).toEqual({
      path: '/koda/fleet/dispatch', query: { command: 'RUN', repoId: 'r1', feature: 'login', ref: 'feat/login' },
    })
    m.app.unmount()
  })
})
