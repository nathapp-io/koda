import { describe, expect, test } from '@jest/globals'
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

  test('the list reloads on an approval_request event as well as fleet_approval (P3b US-007)', () => {
    expect(liveHandlers(list)).toContain('onApprovalRequest: () => liveReload.trigger()')
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

  test('a job with pending approvals is marked next to its state, and the list reloads on fleet_approval (spec §5)', () => {
    expect(list).toMatch(/<FleetJobStateBadge :state="job\.state" \/>\s*<Badge v-if="job\.pendingApprovals > 0"[^>]*:data-testid="`fleet-job-needs-approval-\$\{job\.id\}`"/)
    expect(list).toContain("t('fleet.jobs.needsApproval', { count: job.pendingApprovals })")
    expect(liveHandlers(list)).toContain('onFleetApproval: () => liveReload.trigger()')
  })

  test('S3 §6: the command column shows translated kinds and config jobs show a readable feature', () => {
    expect(list).toContain("codeLabel(t, te, 'fleet.command', job.command)")
    expect(list).toContain("isConfigJob(job) ? t('fleet.jobs.configFeature') : job.feature")
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
 * one of them back at the fleet inbox the redirect retires.
 */
describe('the approval journeys drive the engine inbox (P3b US-007)', () => {
  const journeys: Array<[string, string]> = [
    ['bash journey', read('tests', 'e2e', 'fleet-bash-approvals.e2e.spec.ts')],
    ['budget journey', read('tests', 'e2e', 'fleet-approvals.e2e.spec.ts')],
  ]
  /** The retired fleet inbox route and the fleet row testids, none of which the engine inbox renders. */
  const RETIRED = [
    '/${SLUG}/fleet/approvals',
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
