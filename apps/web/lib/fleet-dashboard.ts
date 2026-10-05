import { ageParts } from '~/lib/fleet-age'
import type { AgeParts } from '~/lib/fleet-age'
import { usd } from '~/lib/fleet-analytics-format'
import type { DashboardCounts, TileId } from '~/lib/fleet-dashboard-types'

/** Spec §4.1 / B2: one snapshot request per 10 s while the tab is visible. */
export const DASHBOARD_POLL_MS = 10_000
/** D416: the client clock that advances ages between polls. */
export const CLOCK_TICK_MS = 1_000

/** Section anchors the tiles link to (D423). */
export const SECTION_IDS = {
  attention: 'fleet-dashboard-attention',
  active: 'fleet-dashboard-active',
  runners: 'fleet-dashboard-runners',
  recent: 'fleet-dashboard-recent',
} as const

/**
 * D416: server time now = generatedAt + client time elapsed since the snapshot arrived, never before generatedAt.
 * The browser clock is never compared with server time, so skew between them cannot distort an age.
 */
export function serverNow(generatedAt: string, receivedAtMs: number, clientNowMs: number): Date {
  return new Date(Date.parse(generatedAt) + Math.max(0, clientNowMs - receivedAtMs))
}

/** D417: seconds in the largest whole unit (190 s -> 3 m), the form `ageParts` uses. */
export function secParts(sec: number): AgeParts {
  const s = Math.max(0, Math.floor(sec))
  if (s >= 86_400) return { n: Math.floor(s / 86_400), unit: 'd' }
  if (s >= 3_600) return { n: Math.floor(s / 3_600), unit: 'h' }
  if (s >= 60) return { n: Math.floor(s / 60), unit: 'm' }
  return { n: s, unit: 's' }
}

/** D416: an age the server measured at generatedAt (silentSec, oldestSec), advanced to `now`. */
export function liveSec(baseSec: number | undefined, generatedAt: string, now: Date): number {
  const ms = now.getTime() - Date.parse(generatedAt)
  const elapsed = Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 1000))
  return Math.max(0, baseSec ?? 0) + elapsed
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** D420: the local wall-clock time of a client timestamp, for "showing data from HH:MM". */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** The project job page (same form as pages/[project]/fleet/index.vue). */
export function jobPath(slug: string, id: string): string {
  return `/${slug}/fleet/jobs/${id}`
}

/** "3/5"; "-" when the API could not count (no stories, or the list was truncated). */
export function storiesText(done: number | null, total: number | null): string {
  return done === null || total === null ? '-' : `${done}/${total}`
}

/** Money as the API sent it, against the job's cap. */
export function costText(spent: string, max: string): string {
  return `${usd(spent)} / ${usd(max)}`
}

/** How long a finished job ran; null without a start time or with an unreadable finish time. */
export function durationParts(startedAt: string | null, finishedAt: string): AgeParts | null {
  const end = Date.parse(finishedAt)
  if (startedAt === null || Number.isNaN(end)) return null
  return ageParts(startedAt, new Date(end))
}

/** D419: a link target only for http(s) URLs. */
export function safeHttpUrl(url: string | null): string | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export interface DashboardTile {
  id: TileId
  value: string
  href: string
  tone: 'ok' | 'warn' | 'bad'
}

/** D423: the four count tiles, each linking to its section. */
export function dashboardTiles(c: DashboardCounts): DashboardTile[] {
  return [
    { id: 'runners', value: `${c.runnersOnline}/${c.runnersTotal}`, href: `#${SECTION_IDS.runners}`, tone: c.runnersOnline < c.runnersTotal ? 'warn' : 'ok' },
    { id: 'queued', value: String(c.queued), href: `#${SECTION_IDS.active}`, tone: 'ok' },
    { id: 'running', value: String(c.running), href: `#${SECTION_IDS.active}`, tone: 'ok' },
    { id: 'attention', value: String(c.attention), href: `#${SECTION_IDS.attention}`, tone: c.attention > 0 ? 'bad' : 'ok' },
  ]
}
