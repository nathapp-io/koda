import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadFleetJobDetail } from '~/lib/fleet-job-detail'

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

  test('renders the story pipeline (graph/list) under the progress block (S2b j, spec J3)', () => {
    expect(detail).toContain("import FleetJobPipeline from '~/components/fleet/story-graph/FleetJobPipeline.vue'")
    expect(detail).toMatch(/<FleetJobProgress :job="job" \/>\s*<FleetJobPipeline :job="job" \/>/)
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

  test('S1.5 2b: callout, shell approvals line, approvals section, live reload on fleet_approval (D297)', () => {
    expect(detail).toContain("import { useFleetApprovals } from '~/composables/useFleetApprovals'")
    expect(detail).toContain("import { useApprovalCountdown } from '~/composables/useApprovalCountdown'")
    expect(detail).toMatch(/<div v-if="job\.pendingApprovals > 0"[^>]*data-testid="fleet-job-approval-callout"/)
    expect(detail).toContain(':to="reviewHref"')
    expect(detail).toContain("inboxPath({ kind: 'project', slug }, firstPending(jobApprovals.value)?.id)")
    expect(detail).toContain('bashSummary(t, job.bashMode, job.approvalTimeoutSec)')
    expect(detail).toMatch(/<FleetJobApprovals v-if="showApprovals" :slug="slug" :approvals="jobApprovals" :now="now" \/>/)
    expect(detail).toContain("job.value.bashMode !== 'raw' || jobApprovals.value.length > 0")
    expect(liveHandlers(detail)).toContain('onFleetApproval: () => liveReload.trigger()')
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?await loadApprovals\(\)/)
    expect(timeline).toContain("case 'approval':")
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

  test('S2b: the cost and quality section reloads with every live reload (D396)', () => {
    expect(detail).toContain("import FleetJobAnalytics from '~/components/fleet/JobAnalytics.vue'")
    expect(detail).toContain('<FleetJobAnalytics :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />')
    expect(detail).toMatch(/async function reloadSilently\(\): Promise<void> \{\s*analyticsReload\.value \+= 1/)
  })
})
