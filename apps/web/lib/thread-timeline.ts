/**
 * Fleet S5a US-004: the thread timeline as one ordered list of messages and markers.
 *
 * Pure (no Vue imports). Only the latest write and the latest PLAN and RUN are known to the web
 * (C3-R1), so the timeline shows exactly those, anchored by their own timestamps.
 */

import type { FleetJobDto, FleetJobWorkflowOutcome } from '~/lib/fleet-types'
import type { ChatMessageDto, ThreadDetailDto, ThreadHandoffJob, ThreadWriteResult } from '~/lib/thread-types'

/** The loader's PLAN and RUN job details; a detail whose id is not the handoff's job is ignored. */
export interface HandoffJobs {
  plan: FleetJobDto | null
  run: FleetJobDto | null
}

export type ThreadTimelineEntry =
  | { kind: 'message'; key: string; message: ChatMessageDto }
  | { kind: 'write'; key: string; write: ThreadWriteResult }
  | { kind: 'job'; key: string; command: 'PLAN' | 'RUN'; handoff: ThreadHandoffJob; job: FleetJobDto | null }

/** What `ThreadWriteMarker` renders: a locale key, its params, and the (collapsible) path lists. */
export interface WriteMarkerView {
  key: string
  params: Record<string, string | number>
  paths: string[]
  ignored: string[]
}

/** A marker waits for the message it goes in front of; `anchor` is its timestamp, null when it has none. */
interface Marker {
  entry: ThreadTimelineEntry
  anchor: number | null
  /** write before PLAN before RUN, when two markers share a position and an anchor. */
  rank: number
}

const SHA_LENGTH = 7

function parseTime(iso: string): number | null {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

/** The locale key and params for a write result; the path lists only exist on a publish. */
export function writeMarkerView(write: ThreadWriteResult): WriteMarkerView {
  switch (write.kind) {
    case 'published':
      return {
        key: 'fleet.threads.handoff.marker.published',
        params: { sha: write.sha.slice(0, SHA_LENGTH), count: write.paths.length },
        paths: write.paths,
        ignored: write.ignored,
      }
    case 'publish_failed':
      if (write.reason === 'branch_moved') {
        return { key: 'fleet.threads.handoff.marker.publishFailedBranchMoved', params: {}, paths: [], ignored: [] }
      }
      return { key: 'fleet.threads.handoff.marker.publishFailed', params: { reason: write.reason }, paths: [], ignored: [] }
    case 'discarded':
      return {
        key: 'fleet.threads.handoff.marker.discarded',
        params: { sha: write.sha.slice(0, SHA_LENGTH) },
        paths: [],
        ignored: [],
      }
    case 'discard_failed':
      return { key: 'fleet.threads.handoff.marker.discardFailed', params: { reason: write.reason }, paths: [], ignored: [] }
  }
}

/** The outcome locale key under `fleet.jobs.workflow.outcome`: the wire `local-only` is `localOnly`. */
export function workflowOutcomeKey(outcome: FleetJobWorkflowOutcome): 'ready' | 'draft' | 'localOnly' {
  return outcome === 'local-only' ? 'localOnly' : outcome
}

/**
 * The PR link is runner-written text, so only an absolute http(s) URL becomes a link; anything else
 * (a script scheme, a relative path) is not linked.
 */
export function safePrHref(url: string | null): string | null {
  if (url === null) return null
  return /^https?:\/\//i.test(url) ? url : null
}

/** Where a marker goes: in front of the first message created strictly later than its anchor. */
function markerPosition(messages: readonly ChatMessageDto[], anchor: number | null): number {
  if (anchor === null) return messages.length
  const index = messages.findIndex(message => {
    const created = parseTime(message.createdAt)
    return created !== null && created > anchor
  })
  return index === -1 ? messages.length : index
}

function compareMarkers(a: { position: number; marker: Marker }, b: { position: number; marker: Marker }): number {
  if (a.position !== b.position) return a.position - b.position
  const [anchorA, anchorB] = [a.marker.anchor, b.marker.anchor]
  if (anchorA !== anchorB) {
    if (anchorA === null) return 1
    if (anchorB === null) return -1
    return anchorA - anchorB
  }
  return a.marker.rank - b.marker.rank
}

function jobMarker(handoff: ThreadHandoffJob | null, command: 'PLAN' | 'RUN', detail: FleetJobDto | null): Marker | null {
  if (handoff === null) return null
  const job = detail !== null && detail.id === handoff.jobId ? detail : null
  return {
    entry: { kind: 'job', key: `job:${handoff.jobId}`, command, handoff, job },
    anchor: job === null ? null : parseTime(job.queuedAt),
    rank: command === 'PLAN' ? 1 : 2,
  }
}

/**
 * The transcript: the messages in their given order, with the latest write and the latest PLAN and
 * RUN placed among them by their timestamps (see `markerPosition` and `compareMarkers`).
 */
export function buildThreadTimeline(
  messages: readonly ChatMessageDto[],
  thread: ThreadDetailDto,
  jobs: HandoffJobs,
): ThreadTimelineEntry[] {
  const markers: Marker[] = []
  if (thread.lastWrite !== null) {
    markers.push({
      entry: { kind: 'write', key: `write:${thread.lastWrite.jobId}`, write: thread.lastWrite },
      anchor: parseTime(thread.lastWrite.at),
      rank: 0,
    })
  }
  const plan = jobMarker(thread.handoff.plan, 'PLAN', jobs.plan)
  if (plan !== null) markers.push(plan)
  const run = jobMarker(thread.handoff.run, 'RUN', jobs.run)
  if (run !== null) markers.push(run)

  const placed = markers
    .map(marker => ({ position: markerPosition(messages, marker.anchor), marker }))
    .sort(compareMarkers)

  const timeline: ThreadTimelineEntry[] = []
  let next = 0
  messages.forEach((message, index) => {
    while (next < placed.length && placed[next].position <= index) {
      timeline.push(placed[next].marker.entry)
      next += 1
    }
    timeline.push({ kind: 'message', key: message.id, message })
  })
  while (next < placed.length) {
    timeline.push(placed[next].marker.entry)
    next += 1
  }
  return timeline
}
