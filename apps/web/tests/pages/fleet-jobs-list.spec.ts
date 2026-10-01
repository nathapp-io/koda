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
})
