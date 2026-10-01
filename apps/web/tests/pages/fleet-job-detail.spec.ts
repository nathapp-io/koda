import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadFleetJobDetail } from '~/lib/fleet-job-detail'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const detail = read('pages', '[project]', 'fleet', 'jobs', '[id].vue')
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

  test('actions are gated by the pure permission helpers', () => {
    expect(detail).toContain('canWork: canWorkOnFleet(viewerRole.value)')
    expect(detail).toContain('canCancelJob(job.value, viewer.value)')
    expect(detail).toContain('canRequeueJob(job.value, viewer.value)')
    expect(detail).toContain('mayHaveBundle(job.value.state)')
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

  test('renders the story checklist under the progress block', () => {
    expect(detail).toMatch(/<FleetJobProgress :job="job" \/>\s*<FleetJobStories :job="job" \/>/)
  })
})
