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

  test('the dispatch button is shown to project ADMIN and DEVELOPER only, through the shared rule', () => {
    expect(list).toContain('const canWork = computed(() => canWorkOnFleet(viewer.value))')
    expect(list).toMatch(/<Button v-if="canWork"[^>]*data-testid="fleet-dispatch-button"/)
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

  test('a job with pending approvals is marked next to its state, and the list reloads on fleet_approval (spec §5)', () => {
    expect(list).toMatch(/<FleetJobStateBadge :state="job\.state" \/>\s*<Badge v-if="job\.pendingApprovals > 0"[^>]*:data-testid="`fleet-job-needs-approval-\$\{job\.id\}`"/)
    expect(list).toContain("t('fleet.jobs.needsApproval', { count: job.pendingApprovals })")
    expect(liveHandlers(list)).toContain('onFleetApproval: () => liveReload.trigger()')
  })
})
