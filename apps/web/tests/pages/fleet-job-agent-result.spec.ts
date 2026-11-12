import { describe, expect, test, jest } from '@jest/globals'
import { computed, defineComponent, nextTick, ref } from 'vue'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { ProjectEventHandlers } from '~/lib/project-event-stream'

const inert = (name: string) => defineComponent({ name, setup: () => () => null })
const fixture = (command: FleetJobDto['command']): FleetJobDto => ({
  id: 'agent-job', projectId: 'p1', repoId: 'r1', ref: 'main', command, feature: 'review', planFrom: null,
  profiles: [], maxCostUsd: '1.0000', bashMode: 'raw', approvalTimeoutSec: 600, pendingApprovals: 0,
  selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 1, state: 'COMPLETED', stateReason: null,
  requestedById: 'u1', queuedAt: '2026-11-01T00:00:00.000Z', assignedAt: null, startedAt: null, finishedAt: null,
  cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null,
  currentStoryId: null, currentPhase: null, costSpentUsd: '0.0000', lastHeartbeatAt: null, finishResult: null,
  escalationReason: null, exitCode: 0, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
  stories: null, storiesTruncated: false, postRun: null, scheduleId: null, coalescedCount: 0, tickets: null,
  configEdit: null, workflow: null, agent: null,
  agentResult: { status: 'completed', output: 'result', truncated: false, deniedAsks: [], deniedAsksTruncated: false },
})

describe('AGENT job page result', () => {
  test.each(['AGENT', 'RUN'] as const)('AC-1/AC-2: %s job controls whether the result panel renders', async (command) => {
    const job = fixture(command)
    const app = mountSfc(webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue'), {
      components: {
        ...uiStubs,
        FleetBudgetBanner: defineComponent({ name: 'StubFleetBudgetBanner', setup: () => () => null }),
      },
      alias: {
        '~/components/fleet/FleetJobAgentResult.vue': { __esModule: true, default: defineComponent({ name: 'FleetJobAgentResult', props: ['agentResult'], setup: (props: { agentResult: { output?: string } | null }) => () => Vue.h('x-agent-result', { 'data-testid': 'fleet-job-agent-result', 'data-output': props.agentResult?.output ?? 'pending' }) }) },
        '~/components/fleet/FleetJobProgress.vue': { __esModule: true, default: inert('Progress') },
        '~/components/fleet/FleetJobStateBadge.vue': { __esModule: true, default: inert('Badge') },
        '~/components/fleet/FleetJobTimeline.vue': { __esModule: true, default: inert('Timeline') },
        '~/components/fleet/FleetJobWorkflow.vue': { __esModule: true, default: inert('Workflow') },
        '~/components/fleet/FleetJobOpenItems.vue': { __esModule: true, default: inert('OpenItems') },
        '~/components/fleet/FleetPlacementResult.vue': { __esModule: true, default: inert('Placement') },
        '~/components/fleet/JobAnalytics.vue': { __esModule: true, default: inert('Analytics') },
        '~/components/fleet/story-graph/FleetJobPipeline.vue': { __esModule: true, default: inert('Pipeline') },
        '~/components/fleet/config/ConfigJobPanel.vue': { __esModule: true, default: inert('ConfigPanel') },
        '~/components/fleet/config/ConfigPrDialog.vue': { __esModule: true, default: inert('ConfigDialog') },
        '~/components/fleet/JobApprovals.vue': { __esModule: true, default: inert('Approvals') },
      },
      globals: {
        ref, computed, nextTick,
        onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda', id: job.id } }),
        useI18n: () => enI18n(), useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
        useAuth: () => ({ user: ref({ id: 'u1' }) }), useProjectPermissions: () => projectPermissionsStub([]),
        useApi: () => ({ $api: { get: jest.fn(async () => ({ records: [], total: 0, current: 1, size: 100, hasNext: false, hasPrev: false })) } }),
        useFleetJobs: () => ({ get: jest.fn(async () => job), events: jest.fn(async () => ({ records: [], hasNext: false })) }),
        useFleetDispatchOptions: () => ({ settled: ref(true), load: jest.fn(async () => undefined), repoName: (id: string) => id, runnerName: () => null }),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
        useFleetRepoConfig: () => ({ submitRegenerate: jest.fn() }),
        useFleetJobLogs: () => ({ list: jest.fn(async () => ({ attempts: [] })) }),
        useProjectEvents: (_slug: string, _handlers: ProjectEventHandlers) => undefined,
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    await nextTick()
    const resultPanel = app.find('[data-testid="fleet-job-agent-result"]')
    expect(resultPanel).toHaveLength(command === 'AGENT' ? 1 : 0)
    if (command === 'AGENT') expect(resultPanel[0].props['data-output']).toBe('result')
    app.unmount()
  })
})
