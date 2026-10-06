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

export interface WipPushStatus {
  readonly key: 'pushed' | 'none' | 'failed'
  readonly reason: string | null
}

/** S1b §1.1: the runner's progress-push outcome after an unfinished RUN. */
export function wipPushStatus(value: string | null | undefined): WipPushStatus | null {
  if (value === 'pushed' || value === 'none') return { key: value, reason: null }
  if (typeof value === 'string' && value.startsWith('failed:')) return { key: 'failed', reason: value.slice('failed:'.length) }
  return null
}

export interface StoryRow {
  id: string
  title: string
  status: string
  attempts: number
  /** D152: only while the job is active. */
  current: boolean
  phase: string | null
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
  /** S2b (j) D439: ids this story waits on; strings only, de-duplicated, never itself. */
  dependsOn: string[]
}

const STORY_VARIANTS: Readonly<Record<string, StoryRow['variant']>> = {
  'passed': 'default',
  'in-progress': 'secondary',
  'failed': 'destructive',
  'regression-failed': 'destructive',
}

/** D439: the PRD's dependsOn as clean ids; anything that is not a non-empty string is dropped. */
const dependsOnOf = (value: unknown, self: string): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((dep): dep is string => typeof dep === 'string' && dep.length > 0 && dep !== self))]
    : []

/** S1b §1.4: the job page's story checklist. The server validated the list; each row is still checked. */
export function storyRows(job: Pick<FleetJobDto, 'stories' | 'state' | 'currentStoryId' | 'currentPhase'>): StoryRow[] {
  if (!Array.isArray(job.stories)) return []
  const active = isActiveJobState(job.state)
  return job.stories.flatMap((entry: unknown): StoryRow[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const s = entry as Record<string, unknown>
    const id = text(s.id)
    if (id === null) return []
    const status = text(s.status) ?? 'pending'
    const current = active && id === job.currentStoryId
    return [{
      id,
      title: text(s.title) ?? '',
      status,
      attempts: count(s.attempts) ?? 0,
      current,
      phase: current ? job.currentPhase : null,
      variant: STORY_VARIANTS[status] ?? 'outline',
      dependsOn: dependsOnOf(s.dependsOn, id),
    }]
  })
}

export type TimelineEntry =
  | { kind: 'transition'; from: string | null; to: string; reason: string | null; source: 'server' | 'runner' }
  | { kind: 'snapshot'; parts: string[] }
  | { kind: 'lifecycle'; level: string; message: string }
  | { kind: 'log'; text: string }
  | { kind: 'approval'; command: string }
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
    case 'approval_request': {
      // S1.5 2a: a relayed bash ask; the full text lives on the approval, the timeline shows its first line.
      const body = text(p.command) ?? text(p.rawDetail) ?? ''
      const first = body.split('\n')[0] ?? ''
      return { kind: 'approval', command: first.length > LOG_PREVIEW ? `${first.slice(0, LOG_PREVIEW)}...` : first }
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

/** States that count as "running" for the jobs-list ordering (slice 4). */
export const RUNNING_JOB_STATES: ReadonlyArray<string> = ['RUNNING', 'UPLOADING']

/**
 * Slice 4: running jobs first — the longest-running (earliest start) on top, since those are the
 * ones a supervisor goes to check — then everything else newest-queued first. Sorting is within
 * the loaded page only: the API owns the cross-page order (one `state` filter, queuedAt desc).
 */
export function runningFirstJobs(jobs: readonly FleetJobDto[]): FleetJobDto[] {
  return [...jobs].sort((a, b) => {
    const aRunning = RUNNING_JOB_STATES.includes(a.state) ? 0 : 1
    const bRunning = RUNNING_JOB_STATES.includes(b.state) ? 0 : 1
    if (aRunning !== bRunning) return aRunning - bRunning
    if (aRunning === 0) return (a.startedAt ?? '').localeCompare(b.startedAt ?? '')
    return b.queuedAt.localeCompare(a.queuedAt)
  })
}

/** Merges a fetched events page into the loaded timeline: one row per id, ordered by seq. */
export function mergeEvents(existing: readonly FleetJobEventDto[], incoming: readonly FleetJobEventDto[]): FleetJobEventDto[] {
  const byId = new Map([...existing, ...incoming].map(event => [event.id, event]))
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}
