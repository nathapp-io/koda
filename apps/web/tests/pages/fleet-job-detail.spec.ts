import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as Vue from 'vue'
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue'
import { loadFleetJobDetail } from '~/lib/fleet-job-detail'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'
import type { ApprovalRequestDetail, ApprovalRequestSummary } from '../../lib/approval-requests'
import type { FleetJobDto } from '../../lib/fleet-types'
import type { ProjectEventHandlers } from '../../lib/project-event-stream'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const detail = read('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue')
const timeline = read('components', 'fleet', 'FleetJobTimeline.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('job detail', () => {
  test('a successful retry initializes events and display names after the first job request failed', async () => {
    let jobAvailable = false
    const initializeRelatedData = jest.fn()
    const loadJob = jest.fn(async () => jobAvailable)

    await loadFleetJobDetail(loadJob, initializeRelatedData)
    expect(initializeRelatedData).not.toHaveBeenCalled()

    jobAvailable = true
    await loadFleetJobDetail(loadJob, initializeRelatedData)

    expect(loadJob).toHaveBeenCalledTimes(2)
    expect(initializeRelatedData).toHaveBeenCalledTimes(1)
    expect(detail).toContain('onMounted(loadJobDetail)')
    expect(detail).toContain('@retry="loadJobDetail()"')
    expect(detail).toMatch(/function initializeRelatedData\(\): void[\s\S]*?loadEventsFrom\(1\)[\s\S]*?options\.load\(\)[\s\S]*?people\.load\(\)/)
    expect(detail).toContain('await loadFleetJobDetail(loadJob, initializeRelatedData)')
  })

  test('reacts only to events for this job and never flips pending from live handlers', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).toContain('if (event.jobId === jobId) liveReload.trigger()')
    expect(handlers).not.toContain('loadJob(')
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?catch \{/)
  })

  test('actions are gated by the pure permission helpers, one flag per key (Permissions P1 US-008)', () => {
    expect(detail).toContain("canCancel: permissions.value.has('fleet.job.cancel')")
    expect(detail).toContain("canRequeue: permissions.value.has('fleet.job.requeue')")
    expect(detail).toContain("canDispatch: permissions.value.has('fleet.job.dispatch')")
    expect(detail).toContain('canCancelJob(job.value, viewer.value)')
    expect(detail).toContain('canRequeueJob(job.value, viewer.value)')
    expect(detail).toContain('mayHaveBundle(job.value.state)')
    expect(detail).not.toContain('canWorkOnFleet')
  })

  test('a live reload catches up a bounded number of event pages; a failed first load is reported', () => {
    expect(detail).toContain('const LIVE_CATCH_UP_PAGES = 10')
    expect(detail).toMatch(/for \(let i = 0; i < LIVE_CATCH_UP_PAGES && moreEvents\.value; i \+= 1\)/)
    expect(detail).toContain('void loadEventsFrom(1).catch((err: unknown) => toast.error(extractApiError(err)))')
  })

  test('a requeue shows its placement without a link to this same job', () => {
    expect(detail).toContain('<FleetPlacementResult v-if="requeueResult"')
    expect(detail).toContain('hide-open-link')
  })

  test('cancel asks for confirmation first', () => {
    expect(detail).toContain('@click="confirmCancel = true"')
    expect(detail).toContain('data-testid="fleet-job-cancel-confirm"')
  })

  test('the timeline lists each transition once (server rows only) and names the dispatch row Queued', () => {
    expect(timeline).toContain('visibleTimelineEvents(props.events)')
    expect(timeline).toContain("t('fleet.jobs.timeline.queued')")
    expect(timeline).not.toContain('timeline.reported')
  })

  test('the PR link is rendered only through safePrUrl, opened without opener', () => {
    expect(detail).toContain('safePrUrl(job.value?.resultPrUrl)')
    expect(detail).toMatch(/<a v-if="prUrl" :href="prUrl" target="_blank" rel="noopener noreferrer"/)
  })

  test('renders the story pipeline (graph/list) under the progress block (S2b j, spec J3)', () => {
    expect(detail).toContain("import FleetJobPipeline from '~/components/fleet/story-graph/FleetJobPipeline.vue'")
    expect(detail).toMatch(/<FleetJobProgress v-if="!configJob" :job="job" \/>\s*<FleetJobPipeline v-if="!configJob" :job="job" \/>/)
    expect(detail).not.toContain('FleetJobStories')
  })

  test('the pipeline follows live updates through the existing job reload only', () => {
    expect(liveHandlers(detail)).toContain('if (event.jobId === jobId) liveReload.trigger()')
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?job\.value = await jobsApi\.get\(jobId\)/)
  })

  test('a scheduled job links back to its schedule and shows merged fires (3b D216)', () => {
    expect(detail).toContain('<span v-if="job.scheduleId"')
    expect(detail).toContain(':to="`/${slug}/fleet/schedules/${job.scheduleId}`"')
    expect(detail).toContain('data-testid="fleet-job-schedule-link"')
    expect(detail).toContain("t('fleet.jobs.detail.coalesced', { count: job.coalescedCount })")
  })

  test('S1.5 2b / P3b US-007: callout, shell approvals line and approvals section read the engine', () => {
    expect(detail).toContain("import { useApprovalInbox } from '~/composables/useApprovalInbox'")
    expect(detail).toContain("import { inboxHref, sortPendingRequests } from '~/lib/approval-requests'")
    expect(detail).toContain("import type { JobApprovalRow } from '~/composables/useApprovalInbox'")
    expect(detail).not.toContain('useFleetApprovals')
    expect(detail).toContain("import { useApprovalCountdown } from '~/composables/useApprovalCountdown'")
    expect(detail).toMatch(/const jobApprovals = ref<JobApprovalRow\[\]>\(\[\]\)/)
    expect(detail).toContain('await inbox.listForJob(jobId)')
    expect(detail).toMatch(/<div v-if="job\.pendingApprovals > 0"[^>]*data-testid="fleet-job-approval-callout"/)
    expect(detail).toContain(':to="reviewHref"')
    expect(detail).toContain('inboxHref(slug, soonestPending.value?.id)')
    expect(detail).toContain('bashSummary(t, job.bashMode, job.approvalTimeoutSec)')
    expect(detail).toMatch(/<FleetJobApprovals v-if="showApprovals" :slug="slug" :approvals="jobApprovals" :now="now" \/>/)
    expect(detail).toContain("job.value.bashMode !== 'raw' || jobApprovals.value.length > 0")
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?await loadApprovals\(\)/)
    expect(timeline).toContain("case 'approval':")
  })

  test('P3b US-007: live reloads follow the engine approval notice; the fleet one is retired in 7c', () => {
    expect(liveHandlers(detail)).toContain('onApprovalRequest: () => liveReload.trigger()')
    expect(liveHandlers(detail)).not.toContain('onFleetApproval')
  })

  test('S2a §4.2: Logs link, expired bundle, timeline log rows, and a list reload for a new attempt (D357)', () => {
    expect(detail).toContain('data-testid="fleet-job-logs-link"')
    expect(detail).toContain('const logsHref = `/${slug}/fleet/jobs/${jobId}/logs`')
    expect(detail).toContain(':disabled="busy || bundleExpired"')
    expect(detail).toContain("bundleExpired ? t('fleet.jobs.actions.bundleExpired') : t('fleet.jobs.actions.bundle')")
    expect(detail).toContain('if (err instanceof ApiError && err.code === 410) bundleGone.value = true')
    expect(detail).toContain(':log-attempts="logAttempts" :logs-href="logsHref"')
    expect(detail).toMatch(/function initializeRelatedData\(\): void[\s\S]*?void loadLogList\(\)\.catch\(\(\) => undefined\)/)
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?await loadLogList\(\)/)
    expect(liveHandlers(detail)).toContain('if (event.jobId === jobId && !logAttempts.value.includes(event.leaseEpoch)) liveReload.trigger()')
  })

  test('a COMPLETED PLAN offers Dispatch run pre-filled with repo, feature and resultBranch (#205)', () => {
    expect(detail).toContain('showDispatchRun')
    expect(detail).toContain('viewer.value.canDispatch')
    expect(detail).toContain("job.value.command === 'PLAN' && job.value.state === 'COMPLETED'")
    expect(detail).toContain('job.value.resultBranch !== null')
    expect(detail).toContain('data-testid="fleet-job-dispatch-run"')
    expect(detail).toContain("t('fleet.jobs.actions.dispatchRun')")
    expect(detail).toContain("query: { command: 'RUN', repoId: current.repoId, feature: current.feature, ref: current.resultBranch, ...(tickets ? { tickets } : {}) }")
  })

  test('S2b: the cost and quality section reloads with every live reload (D396)', () => {
    expect(detail).toContain("import FleetJobAnalytics from '~/components/fleet/JobAnalytics.vue'")
    expect(detail).toContain('<FleetJobAnalytics v-if="!configJob" :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />')
    expect(detail).toMatch(/async function reloadSilently\(\): Promise<void> \{\s*analyticsReload\.value \+= 1/)
  })

  test('C9: the hand-off carries the PLAN job tickets', () => {
    expect(detail).toContain("import { ticketsQueryValue } from '~/lib/fleet-ticket-links'")
    expect(detail).toContain('const tickets = ticketsQueryValue(current.tickets)')
  })

  test('C9: a Tickets row lists the linked tickets with status, linking to each ticket', () => {
    expect(detail).toContain("import { STATUS_DOT, TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'")
    expect(detail).toMatch(/<div v-if="job\.tickets && job\.tickets\.length > 0"[^>]*data-testid="fleet-job-tickets"/)
    expect(detail).toContain(':to="`/${slug}/tickets/${linked.ref}`"')
    expect(detail).toContain('data-testid="fleet-job-ticket"')
    expect(detail).toContain("t(`tickets.status.${linked.status}`)")
    expect(detail).toContain("t('fleet.jobs.detail.tickets')")
  })

  test('C9: cancel and requeue render the job from the response, which now carries tickets (Task 1)', () => {
    expect(detail).toContain('job.value = await jobsApi.cancel(jobId)')
    expect(detail).toContain('job.value = result.job')
  })
})

describe('config jobs (S3 §6)', () => {
  test('the page swaps nax-only sections for the config panel', () => {
    expect(detail).toContain("import ConfigJobPanel from '~/components/fleet/config/ConfigJobPanel.vue'")
    expect(detail).toContain('const configJob = computed(() => job.value !== null && isConfigJob(job.value))')
    expect(detail).toContain('<ConfigJobPanel v-if="configJob" :job="job" :slug="slug" :can-work="canEditConfig" @regenerate="regenOpen = true" />')
    expect(detail).toContain('<FleetJobProgress v-if="!configJob" :job="job" />')
    expect(detail).toContain('<FleetJobPipeline v-if="!configJob" :job="job" />')
    expect(detail).toContain('<FleetJobAnalytics v-if="!configJob" :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />')
    expect(detail).toMatch(/const showBundle = computed\(\(\) => job\.value !== null && !configJob\.value && mayHaveBundle\(job\.value\.state\)\)/)
  })

  test('regenerate submits for the job repo and opens the new job', () => {
    expect(detail).toContain('configApi.submitRegenerate(current.repoId, body)')
    expect(detail).toContain('await navigateTo(`/${slug}/fleet/jobs/${created.job.id}`)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P3b US-007 — the job page's approvals on the approval engine
// ─────────────────────────────────────────────────────────────────────────────

const g = globalThis as Record<string, unknown>

const jobFixture = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'j1',
  projectId: 'p1',
  repoId: 'r1',
  ref: 'main',
  command: 'RUN',
  feature: 'login',
  planFrom: null,
  profiles: [],
  maxCostUsd: '5.0000',
  bashMode: 'approve',
  approvalTimeoutSec: 600,
  pendingApprovals: 0,
  selectorLabels: [],
  pinnedRunnerId: null,
  runnerId: null,
  leaseEpoch: 1,
  state: 'RUNNING',
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
} as FleetJobDto)

const request = (id: string, over: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  id,
  permissionKey: 'fleet.job.shell.escalate',
  projectId: 'p1',
  actorType: 'AGENT',
  actorId: 'runner-1',
  onBehalfOfType: null,
  onBehalfOfId: null,
  origin: 'fleet',
  redeem: false,
  requiredMode: 'human',
  status: 'pending',
  satisfiedBy: null,
  approverType: null,
  approverId: null,
  expiresAt: '2026-10-03T10:10:00.000Z',
  decidedAt: null,
  settledAt: null,
  createdAt: '2026-10-03T10:00:00.000Z',
  ...over,
})

const COMMAND = 'git push --force origin HEAD'

const bashDetail = (summary: ApprovalRequestSummary): ApprovalRequestDetail => ({
  ...summary,
  input: {
    payload: {
      command: COMMAND, commandTruncated: false, maskedCount: 0, root: '/w', stage: 'execution',
      storyId: null, featureName: 'login', reason: 'r', options: ['allow', 'deny'],
    },
  },
  result: null,
  details: { jobId: 'j1' },
  decisions: [],
})

const approvalsPage = (records: ApprovalRequestSummary[]) => ({
  total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records,
})

const inert = (name: string) => defineComponent({ name, setup: () => () => null })

interface EnginePageOver {
  job?: FleetJobDto
  records: ApprovalRequestSummary[]
  /** Request ids whose detail read fails. */
  failing?: readonly string[]
}

/**
 * Mounts the real job page. `useFleetJobs` and the presentation components are doubled, but the page
 * runs the real `useApprovalInbox`, so the engine request and the rows it renders are the ones under test.
 */
function mountEnginePage(over: EnginePageOver) {
  const job = over.job ?? jobFixture()
  const get = jest.fn(async (path: string) => {
    if (path === '/approvals') return approvalsPage(over.records)
    const id = path.slice('/approvals/'.length)
    if (over.failing?.includes(id) === true) throw new Error('down')
    const summary = over.records.find((record) => record.id === id)
    return summary === undefined ? bashDetail(request(id)) : bashDetail(summary)
  })
  g.useApi = () => ({ $api: { get } })
  let live: ProjectEventHandlers | null = null
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
      '~/composables/useApprovalCountdown': { useApprovalCountdown: () => ({ now: ref(new Date('2026-10-03T10:05:00.000Z')) }) },
      '~/components/fleet/FleetJobProgress.vue': { __esModule: true, default: inert('StubJobProgress') },
      '~/components/fleet/FleetJobStateBadge.vue': { __esModule: true, default: inert('StubStateBadge') },
      '~/components/fleet/FleetJobTimeline.vue': { __esModule: true, default: inert('StubJobTimeline') },
      '~/components/fleet/FleetJobWorkflow.vue': { __esModule: true, default: inert('StubJobWorkflow') },
      '~/components/fleet/FleetPlacementResult.vue': { __esModule: true, default: inert('StubPlacementResult') },
      '~/components/fleet/JobAnalytics.vue': { __esModule: true, default: inert('StubJobAnalytics') },
      '~/components/fleet/story-graph/FleetJobPipeline.vue': { __esModule: true, default: inert('StubJobPipeline') },
      '~/components/fleet/config/ConfigJobPanel.vue': { __esModule: true, default: inert('StubConfigJobPanel') },
      '~/components/fleet/config/ConfigPrDialog.vue': { __esModule: true, default: inert('StubConfigPrDialog') },
    },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      definePageMeta: () => undefined,
      useRoute: () => ({ params: { project: 'koda', id: job.id } }),
      useI18n: () => enI18n(),
      useAppToast: () => toastRecorder(),
      useApi: () => ({ $api: { get } }),
      useAuth: () => ({ user: ref({ id: 'u2' }) }),
      useProjectPermissions: () => projectPermissionsStub([]),
      navigateTo: jest.fn(async () => undefined),
      useFleetJobs: () => ({
        get: jest.fn(async () => job),
        events: jest.fn(async () => ({ records: [], total: 0, current: 1, size: 50, hasNext: false, hasPrev: false })),
        cancel: jest.fn(), requeue: jest.fn(), downloadBundle: jest.fn(),
      }),
      useFleetDispatchOptions: () => ({
        load: jest.fn(async () => undefined),
        repoName: (id: string) => id,
        runnerName: (id: string | null) => id,
      }),
      useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
      useFleetRepoConfig: () => ({ submitRegenerate: jest.fn() }),
      useFleetJobLogs: () => ({ list: jest.fn(async () => ({ attempts: [] })) }),
      useProjectEvents: (_slug: string, handlers: ProjectEventHandlers) => { live = handlers },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await nextTick()
    }
  }
  return { app, get, settle, live: () => live, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

afterEach(() => { delete g.useApi; jest.useRealTimers() })

describe('review and config job headers', () => {
  test('REVIEW header shows PR #42 and config header keeps the translated nax config label', async () => {
    const review = mountEnginePage({ job: jobFixture({ command: 'REVIEW', feature: 'review-pr-42' }), records: [] })
    await review.settle()
    expect(review.app.one('[data-stub="page-header"]')?.props.title).toBe('PR #42')
    review.app.unmount()

    const config = mountEnginePage({ job: jobFixture({ command: 'CONFIG_EDIT', feature: 'nax-config' }), records: [] })
    await config.settle()
    expect(config.app.one('[data-stub="page-header"]')?.props.title).toBe('nax config')
    config.app.unmount()
  })
})

describe('job page approvals on the engine (P3b US-007)', () => {
  test('AC-1: the page asks the engine for this job\'s requests in one page of 100', async () => {
    const m = mountEnginePage({ records: [request('r1')] })
    await m.settle()

    expect(m.get).toHaveBeenCalledWith('/approvals', { query: { jobId: 'j1', size: '100' } })
    m.app.unmount()
  })

  test('AC-4: an approval_request live event reloads the approvals after the 300 ms debounce', async () => {
    const m = mountEnginePage({ records: [request('r1')] })
    await m.settle()
    const lists = () => m.get.mock.calls.filter(([path]) => path === '/approvals').length
    expect(lists()).toBe(1)
    expect(m.live()?.onApprovalRequest).toBeDefined()

    jest.useFakeTimers()
    m.live()?.onApprovalRequest?.({
      id: 'e1', type: 'approval_request', projectId: 'p1', requestId: 'r1', status: 'pending', at: '2026-10-03T10:00:00.000Z',
    })
    jest.advanceTimersByTime(299)
    expect(lists()).toBe(1)
    jest.advanceTimersByTime(1)
    jest.useRealTimers()
    await m.settle()

    expect(lists()).toBe(2)
    m.app.unmount()
  })

  test('AC-7: the review callout opens the pending request that expires soonest', async () => {
    const m = mountEnginePage({
      job: jobFixture({ pendingApprovals: 2 }),
      records: [
        request('later', { expiresAt: '2026-10-03T11:00:00.000Z' }),
        request('sooner', { expiresAt: '2026-10-03T10:20:00.000Z' }),
      ],
    })
    await m.settle()

    expect(m.byId('fleet-job-approval-review')[0].props.to).toBe('/koda/approvals?id=sooner')
    // The section is bound the engine's rows, not the fleet DTO.
    expect(m.byId('fleet-job-approval-sooner')).toHaveLength(1)
    expect(m.byId('fleet-job-approval-later')).toHaveLength(1)
    m.app.unmount()
  })

  test('AC-13: a failed detail read leaves that row on its raw key, the others keep their previews', async () => {
    const m = mountEnginePage({
      records: [
        request('a1', { expiresAt: '2026-10-03T10:20:00.000Z' }),
        request('a2', { expiresAt: '2026-10-03T10:30:00.000Z' }),
      ],
      failing: ['a2'],
    })
    await m.settle()

    const loaded = m.byId('fleet-job-approval-a1')[0]
    const failed = m.byId('fleet-job-approval-a2')[0]
    expect(m.app.textOf(loaded)).toContain(COMMAND)
    expect(m.app.textOf(failed)).toContain('fleet.job.shell.escalate')
    expect(m.app.textOf(failed)).not.toContain(COMMAND)
    m.app.unmount()
  })
})
