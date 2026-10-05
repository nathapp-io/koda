import { ageParts } from '~/lib/fleet-age'
import type { AgeParts } from '~/lib/fleet-age'
import { usd } from '~/lib/fleet-analytics-format'
import type { ChipTone } from '~/lib/fleet-capabilities'
import { CREDENTIAL_WHY, UNPLACEABLE_VERDICTS } from '~/lib/fleet-dashboard-types'
import type {
  AttentionItem, DashboardCounts, DashboardCredential, RunnerCondition, ScopeKind, Severity, TileId,
} from '~/lib/fleet-dashboard-types'

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

/** D418: one translatable line. `ages` render through fleet.common.duration.*; `labels` are keys translated first. */
export interface I18nText {
  key: string
  params?: Readonly<Record<string, string | number>>
  ages?: Readonly<Record<string, AgeParts>>
  labels?: Readonly<Record<string, string>>
}

export type Translate = (key: string, named?: Record<string, unknown>) => string
export type HasKey = (key: string) => boolean

/** A label key with no translation shows its last segment: the raw server code (same rule as `codeLabel`, D126). */
const labelText = (key: string, t: Translate, te: HasKey): string => (te(key) ? t(key) : key.slice(key.lastIndexOf('.') + 1))

export function renderText(text: I18nText, t: Translate, te: HasKey): string {
  const ages = Object.entries(text.ages ?? {}).map(([name, age]) => [name, t(`fleet.common.duration.${age.unit}`, { n: age.n })] as const)
  const labels = Object.entries(text.labels ?? {}).map(([name, key]) => [name, labelText(key, t, te)] as const)
  return t(text.key, { ...(text.params ?? {}), ...Object.fromEntries(ages), ...Object.fromEntries(labels) })
}

export interface AttentionMessage {
  /** The line under the subject; null for a runner item, whose conditions are the message. */
  summary: I18nText | null
  details: I18nText[]
  /** Misfit runners beyond the ones listed (reasonsTotal minus the shown reasons). */
  more: number
}

const A = 'fleet.dashboard.attention'
const known = (list: readonly string[], value: string | undefined): value is string => value !== undefined && list.includes(value)

/** The runner name, or the translated "Unknown" when the API had none (a deleted runner). */
const runnerArg = (name: string | null | undefined): Pick<I18nText, 'params' | 'labels'> =>
  name ? { params: { runner: name } } : { labels: { runner: 'fleet.common.unknown' } }

function conditionText(c: RunnerCondition): I18nText {
  switch (c.type) {
    case 'offline':
      return (c.jobsHeld ?? 0) > 0 ? { key: `${A}.condition.offlineHolding`, params: { n: c.jobsHeld ?? 0 } } : { key: `${A}.condition.offline` }
    case 'credential':
      return { key: `${A}.condition.credential.${known(CREDENTIAL_WHY, c.why) ? c.why : 'unavailable'}`, params: { provider: c.providerId ?? '-' } }
    case 'stale_nax':
      return { key: `${A}.condition.staleNax`, params: { version: c.version ?? '-', latest: c.latest ?? '-' } }
    case 'configuration':
      return { key: `${A}.condition.configuration` }
    default:
      return { key: `${A}.condition.unknown`, params: { code: c.type } }
  }
}

function unplaceable(item: AttentionItem): AttentionMessage {
  const reasons = item.reasons ?? []
  const verdict = known(UNPLACEABLE_VERDICTS, item.verdict) ? item.verdict : 'unknown'
  return {
    summary: { key: `${A}.verdict.${verdict}` },
    details: reasons.map((r) => ({ key: `${A}.misfitOn`, params: { runner: r.runnerName }, labels: { reason: `fleet.misfit.${r.reason}` } })),
    more: Math.max(0, (item.reasonsTotal ?? reasons.length) - reasons.length),
  }
}

/** D418: the words for one attention item, from its structured fields only (the API sends no prose, spec §2). */
export function attentionMessage(item: AttentionItem, generatedAt: string, now: Date): AttentionMessage {
  const one = (summary: I18nText): AttentionMessage => ({ summary, details: [], more: 0 })
  switch (item.kind) {
    case 'job_silent':
      return one({
        key: item.stage === 'starting' ? `${A}.notStarted` : `${A}.silent`,
        ...runnerArg(item.runnerName),
        ages: { age: secParts(liveSec(item.silentSec, generatedAt, now)) },
      })
    case 'job_waiting_approval':
      return one({ key: `${A}.approvals`, params: { n: item.pending ?? 0 }, ages: { age: secParts(liveSec(item.oldestSec, generatedAt, now)) } })
    case 'job_unplaceable':
      return unplaceable(item)
    case 'runner_unhealthy':
      return { summary: null, details: (item.conditions ?? []).map(conditionText), more: 0 }
    default:
      return one({ key: `${A}.unknown` })
  }
}

/** Anything but `error` reads as a warning (D415: a newer severity never hides an item). */
export function severityOf(item: AttentionItem): Severity {
  return item.severity === 'error' ? 'error' : 'warning'
}

/** D419: where an attention item leads; null renders the subject as plain text. */
export function attentionLink(item: AttentionItem, scope: ScopeKind): string | null {
  if (item.subjectType === 'runner') return scope === 'global' ? '/admin/fleet/runners' : null
  if (item.projectSlug === null) return null
  if (item.kind === 'job_waiting_approval') return `/${item.projectSlug}/fleet/approvals`
  return jobPath(item.projectSlug, item.subjectId)
}

export interface DigestChip {
  id: string
  text: I18nText
  tone: ChipTone
}

/** D424: admin credential chips from the dashboard digest, reusing the Runners page chip keys. */
export function digestChips(creds: readonly DashboardCredential[]): DigestChip[] {
  return creds.map((c): DigestChip => {
    const id = `credential:${c.providerId}`
    const provider = { provider: c.providerId }
    if (!c.available) return { id, tone: 'bad', text: { key: 'fleet.dashboard.runners.credentialUnavailable', params: provider } }
    if (c.kind === null) return { id, tone: 'ok', text: { key: 'fleet.dashboard.runners.credentialServed', params: provider } }
    const labels = { kind: `fleet.runners.chip.kind.${c.kind}` }
    const expires = c.expiresAt ? c.expiresAt.slice(0, 10) : null
    if (c.expired) {
      return expires
        ? { id, tone: 'warn', text: { key: 'fleet.runners.chip.credentialExpired', params: { ...provider, expires }, labels } }
        : { id, tone: 'warn', text: { key: 'fleet.dashboard.runners.credentialExpiredUndated', params: provider, labels } }
    }
    return expires
      ? { id, tone: 'ok', text: { key: 'fleet.runners.chip.credentialExpires', params: { ...provider, expires }, labels } }
      : { id, tone: 'ok', text: { key: 'fleet.runners.chip.credential', params: provider, labels } }
  })
}
