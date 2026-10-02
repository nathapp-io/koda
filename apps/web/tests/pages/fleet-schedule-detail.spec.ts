import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const detail = readFileSync(path.join(__dirname, '../..', 'pages', '[project]', 'fleet', 'schedules', '[id].vue'), 'utf-8')

const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('schedule detail page', () => {
  test('history comes from the jobs API filtered by this schedule, paged, newest first (D221)', () => {
    expect(detail).toContain('jobsApi.load({ scheduleId, page: historyPage.value })')
    expect(detail).toContain('historyRows(jobsApi.jobs.value, !jobsApi.hasNext.value)')
    expect(detail).toContain('<FleetScheduleHistory :slug="slug" :rows="rows" />')
  })

  test('live: any fleet_job notice and resync reload schedule and history, debounced; 60 s poll (D222)', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).toContain('onFleetJob: () => liveReload.trigger()')
    expect(handlers).toContain('onResync: () => liveReload.trigger()')
    expect(detail).toContain('const POLL_MS = 60_000')
    expect(detail).toMatch(/async function reload\(\): Promise<void> \{\s*await Promise\.all\(\[loadSchedule\(true\), loadHistory\(\)\]\)/)
    expect(detail).toMatch(/onBeforeUnmount\(\(\) => \{\s*polling\.stop\(\)\s*liveReload\.cancel\(\)/)
  })

  test('controls only for the owner or a project admin; delete goes back to the list (D217, D223)', () => {
    expect(detail).toContain('canChangeSchedule(schedule.value, viewer.value)')
    expect(detail).toContain('<template v-if="canChange">')
    expect(detail).toContain('if (await actions.remove(current)) await navigateTo(`/${slug}/fleet/schedules`)')
  })

  test('a schedule that is gone drops the page to the error state even on a silent reload (Review Focus 4)', () => {
    expect(detail).toContain('const isNotFound = (err: unknown): boolean => err instanceof ApiError && (err.code === 40004 || err.code === 404)')
    expect(detail).toMatch(/if \(!silent \|\| isNotFound\(err\)\) \{\s*schedule\.value = null\s*loadFailed\.value = true/)
    expect(detail).toContain('const actions = useFleetScheduleActions(api, () => { void reload() })')
  })

  test('polling starts synchronously in onMounted, so leaving during the first load cannot leak it', () => {
    expect(detail).toMatch(/onMounted\(\(\) => \{[\s\S]*?polling\.start\(\)\s*void loadSchedule\(false\)/)
  })

  test('status, next fire in the schedule zone, and the cost so far are rendered with test ids', () => {
    expect(detail).toContain('data-testid="fleet-schedule-status"')
    expect(detail).toContain(':data-status="scheduleStatusKey(schedule)"')
    expect(detail).toContain('formatInZone(schedule.nextFireAt, schedule.timezone)')
    expect(detail).toContain('data-testid="fleet-schedule-total-cost"')
  })
})
