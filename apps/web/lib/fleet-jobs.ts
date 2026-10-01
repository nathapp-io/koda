import type { FleetJobDto, FleetJobEventDto, FleetJobState } from '~/lib/fleet-types'

/** Mirrors apps/api/src/fleet/jobs/job-state.ts (S1 spec §5.4). */
export const ACTIVE_JOB_STATES: readonly FleetJobState[] = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']
export const TERMINAL_JOB_STATES: readonly FleetJobState[] = ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']
/** The server's requeue rows: CRASHED|FAILED|CANCELLED -> QUEUED. */
export const REQUEUEABLE_JOB_STATES: readonly FleetJobState[] = ['CRASHED', 'FAILED', 'CANCELLED']

export const isActiveJobState = (state: string): boolean => (ACTIVE_JOB_STATES as readonly string[]).includes(state)
export const isTerminalJobState = (state: string): boolean => (TERMINAL_JOB_STATES as readonly string[]).includes(state)

/** A bundle can exist once the runner may upload (RUNNING partial on cancel, UPLOADING) or the job ended. */
export const mayHaveBundle = (state: string): boolean => state === 'UPLOADING' || isTerminalJobState(state)

/** Dispatch and requeue: project ADMIN (`canManage`) or DEVELOPER (S1 spec §2.2); one rule for every fleet page. */
export function canWorkOnFleet(role: { canManage: boolean; viewerRole: string | null }): boolean {
  return role.canManage || role.viewerRole === 'DEVELOPER'
}

export interface JobViewer {
  userId: string | null
  /** Project ADMIN or DEVELOPER (S1 spec §2.2), from canWorkOnFleet. */
  canWork: boolean
}

/** Cancel: project DEVELOPER+ or the requester, and only while the job is unfinished. */
export function canCancelJob(job: Pick<FleetJobDto, 'state' | 'requestedById'>, viewer: JobViewer): boolean {
  if (isTerminalJobState(job.state)) return false
  return viewer.canWork || (viewer.userId !== null && viewer.userId === job.requestedById)
}

export function canRequeueJob(job: Pick<FleetJobDto, 'state'>, viewer: JobViewer): boolean {
  return viewer.canWork && (REQUEUEABLE_JOB_STATES as readonly string[]).includes(job.state)
}

/** "$0.42" from the API's decimal string; sub-cent values keep 4 decimals; garbage is shown raw. */
export function formatUsd(decimal: string | null | undefined): string {
  if (decimal === null || decimal === undefined || decimal.trim() === '') return '-'
  const n = Number(decimal)
  if (!Number.isFinite(n)) return decimal
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2
  return `$${n.toFixed(digits)}`
}

export interface JobProgress {
  total: number
  passed: number
  failed: number
  pending: number
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** nax status.json progress ({ total, passed, failed, paused, blocked, pending }); null when unusable. */
export function extractProgress(progress: unknown): JobProgress | null {
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return null
  const p = progress as Record<string, unknown>
  const total = count(p.total)
  if (total === null || total === 0) return null
  return { total, passed: count(p.passed) ?? 0, failed: count(p.failed) ?? 0, pending: count(p.pending) ?? 0 }
}

/** Only an https PR link is rendered as a link (the API also accepts http). */
export function safePrUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  }
  catch {
    return null
  }
}

export type TimelineEntry =
  | { kind: 'transition'; from: string | null; to: string; reason: string | null; source: 'server' | 'runner' }
  | { kind: 'snapshot'; parts: string[] }
  | { kind: 'lifecycle'; level: string; message: string }
  | { kind: 'log'; text: string }
  | { kind: 'unknown'; type: string }

const LOG_PREVIEW = 300
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

/** One timeline row from a job event; the payload is untrusted JSON, so every field is checked. */
export function summarizeEvent(event: Pick<FleetJobEventDto, 'type' | 'payload' | 'runnerSeq'>): TimelineEntry {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  switch (event.type) {
    case 'state': {
      const to = text(p.to)
      if (!to) return { kind: 'unknown', type: event.type }
      return { kind: 'transition', from: text(p.from), to, reason: text(p.reason), source: event.runnerSeq === null ? 'server' : 'runner' }
    }
    case 'snapshot': {
      const progress = extractProgress(p.progress)
      const cost = text(p.costSpentUsd)
      const parts = [
        text(p.currentStoryId),
        text(p.currentPhase),
        progress ? `${progress.passed}/${progress.total}` : null,
        cost ? formatUsd(cost) : null,
        text(p.finishResult),
      ].filter((part): part is string => part !== null)
      return { kind: 'snapshot', parts }
    }
    case 'lifecycle':
      return { kind: 'lifecycle', level: text(p.level) ?? 'info', message: text(p.message) ?? '' }
    case 'log': {
      const body = text(p.text) ?? ''
      return { kind: 'log', text: body.length > LOG_PREVIEW ? `${body.slice(0, LOG_PREVIEW)}...` : body }
    }
    default:
      return { kind: 'unknown', type: event.type }
  }
}

/**
 * Timeline rows: the runner's own `state` events (runnerSeq set) are dropped because the server writes
 * the transition it applied as well (runnerSeq null), with `from`; everything else is kept.
 */
export function visibleTimelineEvents(events: readonly FleetJobEventDto[]): FleetJobEventDto[] {
  return events.filter(event => !(event.type === 'state' && event.runnerSeq !== null))
}

/** The active job behind a dispatch 409 (D121): newest first, at most one is active. */
export function pickActiveJob(records: readonly FleetJobDto[]): FleetJobDto | null {
  return records.find(job => isActiveJobState(job.state)) ?? null
}

/** `koda-job-<id>.tar.gz`, same stem the API's Content-Disposition uses. */
export const bundleFileName = (jobId: string): string => `koda-job-${jobId}.tar.gz`

/** Merges a fetched events page into the loaded timeline: one row per id, ordered by seq. */
export function mergeEvents(existing: readonly FleetJobEventDto[], incoming: readonly FleetJobEventDto[]): FleetJobEventDto[] {
  const byId = new Map([...existing, ...incoming].map(event => [event.id, event]))
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}
