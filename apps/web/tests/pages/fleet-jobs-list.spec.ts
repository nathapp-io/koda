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

  test('the dispatch button stays visible but disabled without DEVELOPER+, with a tooltip (#205)', () => {
    expect(list).toContain('const canWork = computed(() => canWorkOnFleet(viewer.value))')
    expect(list).toMatch(/<Button :disabled="!canWork"[^>]*data-testid="fleet-dispatch-button"/)
    expect(list).toContain("t('fleet.jobs.dispatchNoPermission')")
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

  test('every member gets an Approvals button first (S1.5 1b D239)', () => {
    expect(list).toMatch(/<Button variant="outline" data-testid="fleet-approvals-link" @click="navigateTo\(`\/\$\{slug\}\/fleet\/approvals`\)">/)
    expect(list.indexOf('fleet-approvals-link')).toBeLessThan(list.indexOf('fleet-schedules-link'))
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
