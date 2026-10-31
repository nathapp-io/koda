import { describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '../../lib/fleet-types'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const list = read('pages', '[project]', 'fleet', 'index.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('fleet jobs list', () => {
  test('renders REVIEW as PR review and PR #42 while RUN keeps its feature text', async () => {
    const fixture = (id: string, command: FleetJobDto['command'], feature: string): FleetJobDto => ({
      id, projectId: 'p1', repoId: 'r1', ref: 'main', command, feature, planFrom: null, profiles: [], maxCostUsd: '1',
      bashMode: 'raw', approvalTimeoutSec: 600, pendingApprovals: 0, selectorLabels: [], pinnedRunnerId: null,
      runnerId: null, leaseEpoch: 1, state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T00:00:00Z',
      assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null,
      naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', lastHeartbeatAt: null,
      finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
      wipPush: null, stories: null, storiesTruncated: false, postRun: null, scheduleId: null, coalescedCount: 0,
      configEdit: null, workflow: null,
    })
    const jobs = ref([fixture('review', 'REVIEW', 'review-pr-42'), fixture('run', 'RUN', 'login')])
    const noop = async (): Promise<void> => undefined
    const mounted = mountSfc(path.join(__dirname, '../../pages/[project]/fleet/index.vue'), {
      globals: {
        useRoute: () => ({ params: { project: 'demo' } }),
        useI18n: () => enI18n(), useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
        useFleetJobs: () => ({ jobs, total: ref(2), hasNext: ref(false), load: async () => true }),
        useFleetDispatchOptions: () => ({ repos: ref([]), runners: ref([]), repoName: () => 'repo', runnerName: () => null, load: noop }),
        useProjectMemberNames: () => ({ members: ref([]), nameOf: () => 'Member', load: noop }),
        useProjectPermissions: () => ({ permissions: ref({ has: () => true }) }),
        useProjectEvents: noop,
      },
      components: { ...uiStubs, RepoConfigList: { template: '<div />' } },
    })
    try {
      await new Promise((resolve) => { setImmediate(resolve) })
      const rows = mounted.find('[data-testid="fleet-job-row-review"]')
      expect(rows).toHaveLength(1)
      expect(mounted.textOf(rows[0])).toContain('PR #42')
      expect(mounted.textOf(rows[0])).toContain('PR review')
      const runRow = mounted.one('[data-testid="fleet-job-row-run"]')
      expect(runRow).toBeDefined()
      if (runRow) expect(mounted.textOf(runRow)).toContain('login')
    }
    finally {
      mounted.unmount()
    }
  })
  test('renders the bot_review placement reason in English', () => {
    const mounted = mountSfc(webFile('components', 'fleet', 'FleetPlacementResult.vue'), {
      props: {
        slug: 'demo', runnerName: () => null,
        result: { job: { id: 'j1' }, placement: { assigned: false, runnerId: null, misfits: [{ runnerId: 'r1', name: 'runner', reason: 'bot_review' }] } },
      },
      globals: { useI18n: () => enI18n() },
      components: uiStubs,
    })
    try {
      expect(mounted.text()).toContain('nax on this runner cannot run PR reviews')
    }
    finally {
      mounted.unmount()
    }
  })

  test('loads through useFleetJobs with the four filters, sentinel for "all"', () => {
    expect(list).toContain('useFleetJobs(slug)')
    expect(list).toMatch(/state: pick\(filters\.state\)[\s\S]*repoId: pick\(filters\.repoId\)[\s\S]*runnerId: pick\(filters\.runnerId\)[\s\S]*requestedById: pick\(filters\.requestedById\)/)
    expect(list).toContain("const ALL = '__all__'")
  })

  test('a stale successful reload cannot clear the newest reload error or pending state', () => {
    expect(list).toContain('const reloadId = ++latestReloadId')
    expect(list).toMatch(/const accepted = await jobsApi\.load\([\s\S]*?if \(!accepted \|\| reloadId !== latestReloadId\) return/)
    expect(list).toMatch(/catch \(err: unknown\) \{[\s\S]*?if \(reloadId !== latestReloadId\) return/)
    expect(list).toMatch(/finally \{\s*if \(reloadId === latestReloadId\) pending\.value = false/)
  })

  test('refreshes on any fleet_job event, debounced, and cancels on unmount', () => {
    const handlers = liveHandlers(list)
    expect(handlers).toContain('onFleetJob: () => liveReload.trigger()')
    expect(handlers).toContain('onResync: () => liveReload.trigger()')
    expect(list).toMatch(/onBeforeUnmount\(\(\) => liveReload\.cancel\(\)\)/)
  })

  test('the dispatch button stays visible but disabled without fleet.job.dispatch, with a tooltip (#205, US-008)', () => {
    expect(list).toContain("const canDispatch = computed(() => permissions.value.has('fleet.job.dispatch'))")
    expect(list).toMatch(/<Button :disabled="!canDispatch"[^>]*data-testid="fleet-dispatch-button"/)
    expect(list).toContain("t('fleet.jobs.dispatchNoPermission')")
    expect(list).not.toContain('canWorkOnFleet')
  })

  test('the table scrolls sideways on narrow screens and names a requester who left', () => {
    expect(list).toMatch(/<div class="overflow-x-auto">\s*<Table data-testid="fleet-jobs-table">/)
    expect(list).toContain("people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember')")
  })

  test('every member gets a Budgets button next to Dispatch (D187)', () => {
    expect(list).toMatch(/<Button variant="outline" data-testid="fleet-budgets-link" @click="navigateTo\(`\/\$\{slug\}\/fleet\/budgets`\)">/)
    expect(list.indexOf('fleet-budgets-link')).toBeLessThan(list.indexOf('fleet-dispatch-button'))
  })

  test('every member gets a Schedules button before Budgets (3b D216)', () => {
    expect(list).toMatch(/<Button variant="outline" data-testid="fleet-schedules-link" @click="navigateTo\(`\/\$\{slug\}\/fleet\/schedules`\)">/)
    expect(list.indexOf('fleet-schedules-link')).toBeLessThan(list.indexOf('fleet-budgets-link'))
  })

  test('every member gets an Approvals button first, pointing at the engine inbox (S1.5 1b D239, P3b US-007)', () => {
    expect(list).toMatch(/<Button variant="outline" data-testid="fleet-approvals-link" @click="navigateTo\(`\/\$\{slug\}\/approvals`\)">/)
    expect(list.indexOf('fleet-approvals-link')).toBeLessThan(list.indexOf('fleet-schedules-link'))
  })

  test('the list reloads on an approval_request event; the fleet_approval handler is gone (P3b US-007, 7c US-007)', () => {
    expect(liveHandlers(list)).toContain('onApprovalRequest: () => liveReload.trigger()')
    expect(liveHandlers(list)).not.toContain('onFleetApproval')
  })

  test('slice 4: the state filter is a single-select chip row that drives the same filters.state', () => {
    expect(list).toContain('data-testid="fleet-filter-state"')
    expect(list).toMatch(/:aria-pressed="filters\.state === chip\.value"/)
    expect(list).toMatch(/@click="filters\.state = chip\.value"/)
    // chips cover All + every API state, labelled through the same codeLabel fallback as the old select
    expect(list).toMatch(/const stateChips = \[\{ value: ALL, label: t\('fleet\.jobs\.filters\.allStates'\) \}, \.\.\.FLEET_JOB_STATES\.map/)
    // the three name filters keep the shared filter bar, now three columns wide
    expect(list).toContain('<FilterBar columns="3">')
    expect(list).not.toContain('fleet.jobs.filters.allStates\') </SelectItem>') // the state select is gone
  })

  test('slice 4: the visible page lists running jobs first (lib-owned sort)', () => {
    expect(list).toContain("runningFirstJobs(jobsApi.jobs.value)")
    expect(list).toMatch(/<TableRow v-for="job in sortedJobs"/)
  })

  test('a job with pending approvals is marked next to its state, and the list reloads on approval_request (spec §5)', () => {
    expect(list).toMatch(/<FleetJobStateBadge :state="job\.state" \/>\s*<Badge v-if="job\.pendingApprovals > 0"[^>]*:data-testid="`fleet-job-needs-approval-\$\{job\.id\}`"/)
    expect(list).toContain("t('fleet.jobs.needsApproval', { count: job.pendingApprovals })")
    expect(liveHandlers(list)).toContain('onApprovalRequest: () => liveReload.trigger()')
  })

  test('S3 §6: the command column shows translated kinds and config jobs show a readable feature', () => {
    expect(list).toContain("codeLabel(t, te, 'fleet.command', job.command)")
    expect(list).toContain("if (isConfigJob(job)) return t('fleet.jobs.configFeature')")
    expect(list).toContain("if (job.command !== 'REVIEW') return job.feature")
  })

  test('S3 §6: the fleet page shows the Repos card from the loaded dispatch options', () => {
    const list = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'index.vue'), 'utf-8')
    expect(list).toContain("import RepoConfigList from '~/components/fleet/config/RepoConfigList.vue'")
    expect(list).toContain('<RepoConfigList :slug="slug" :repos="options.repos.value" />')
  })
})

/**
 * P3b US-007: the browser journeys the fleet approvals run drive the approval engine's inbox, because the two
 * links they click (the jobs list's banner review link and the job page's Review callout) now open
 * `/<slug>/approvals`. The specs pin the engine route and row testids here, so a future edit cannot quietly point
 * one of them back at the fleet inbox US-007 deleted.
 */
describe('the approval journeys drive the engine inbox (P3b US-007)', () => {
  const journeys: Array<[string, string]> = [
    ['bash journey', read('tests', 'e2e', 'fleet-bash-approvals.e2e.spec.ts')],
    ['budget journey', read('tests', 'e2e', 'fleet-approvals.e2e.spec.ts')],
  ]
  /** The fleet inbox row testids, none of which the engine inbox renders. */
  const RETIRED = [
    'fleet-approval-row-',
    'fleet-approval-bash-',
    'fleet-approval-budget-panel',
    'fleet-approval-candidate-',
    'fleet-approval-amount',
    'fleet-approval-raise',
    'fleet-approval-outcome',
    'fleet-approval-requeue',
    'fleet-approval-countdown',
  ]

  test.each(journeys)('%s opens the engine inbox row it landed on', (_name, source) => {
    expect(source).toContain('/${SLUG}/approvals')
    expect(source).toContain('approval-request-row-${approval.id}')
  })

  test.each(journeys)('%s asserts no retired fleet inbox path or row testid', (_name, source) => {
    for (const retired of RETIRED) expect(source).not.toContain(retired)
  })
})
