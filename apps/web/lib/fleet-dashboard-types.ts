/**
 * Wire types of GET /fleet/dashboard and GET /projects/:slug/fleet/dashboard (S2b (c) spec §1.2, §2).
 * Hand-written (the web has no generated client); mirrors apps/api/src/fleet/dashboard/dto/fleet-dashboard.dto.ts.
 * D415: enum-like fields are `string` on the wire so a newer API value degrades to generic text; the known values
 * are the lists below, pinned against the locale files by tests/i18n/fleet-locale-parity.spec.ts.
 */

export const ATTENTION_KINDS = ['job_silent', 'job_waiting_approval', 'job_unplaceable', 'runner_unhealthy'] as const
export const SEVERITIES = ['error', 'warning'] as const
export const UNPLACEABLE_VERDICTS = [
  'never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed',
] as const
export const CONDITION_TYPES = ['offline', 'credential', 'interaction', 'stale_nax', 'configuration'] as const
export const CREDENTIAL_WHY = ['missing', 'unavailable', 'expired', 'expiring'] as const
export const TILE_IDS = ['runners', 'queued', 'running', 'attention'] as const

export type Severity = (typeof SEVERITIES)[number]
export type TileId = (typeof TILE_IDS)[number]

export interface DashboardCounts {
  runnersOnline: number
  runnersTotal: number
  /** QUEUED jobs in scope (not capped). */
  queued: number
  /** ASSIGNED + RUNNING + UPLOADING jobs in scope (not capped). */
  running: number
  attention: number
}

export interface DashboardCredential {
  providerId: string
  /** nax's verdict (ignores OAuth access-token expiry). */
  available: boolean
  kind: 'api-key' | 'oauth' | null
  expiresAt: string | null
  expired: boolean
}

export interface DashboardRunner {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  enabled: boolean
  online: boolean
  lastSeenAt: string
  capacity: number
  /** Runner-held jobs of every project. */
  activeJobs: number
  /** Global admin scope only; null in project scope or when capabilities are unreadable. */
  naxVersion: string | null
  /** Global admin scope only. */
  daemonVersion: string | null
  /** Global admin scope only; empty in project scope. */
  credentials: DashboardCredential[]
}

export interface DashboardActiveJob {
  id: string
  projectSlug: string
  /** "owner/name". */
  repo: string
  feature: string
  command: string
  state: string
  runnerId: string | null
  runnerName: string | null
  currentStoryId: string | null
  currentPhase: string | null
  storiesDone: number | null
  storiesTotal: number | null
  /** Decimal as string. */
  costSpentUsd: string
  /** Decimal as string. */
  maxCostUsd: string
  queuedAt: string
  startedAt: string | null
  lastHeartbeatAt: string | null
  pendingApprovals: number
}

export interface DashboardRecentJob {
  id: string
  projectSlug: string
  repo: string
  feature: string
  command: string
  state: string
  stateReason: string | null
  runnerName: string | null
  /** Decimal as string. */
  costSpentUsd: string
  startedAt: string | null
  finishedAt: string
  resultPrUrl: string | null
}

export interface AttentionReason {
  runnerName: string
  /** A placement MisfitReason (fleet.misfit.*). */
  reason: string
}

export interface RunnerCondition {
  type: string
  jobsHeld?: number
  providerId?: string
  why?: string
  version?: string
  latest?: string
  /** #207 interaction: absent profile means the base config. */
  plugin?: string
  code?: string
  profile?: string
}

/** Spec §2: one flat shape; fields after `since` belong to one kind each. */
export interface AttentionItem {
  /** `${kind}:${subjectId}`, stable across polls. */
  key: string
  kind: string
  severity: string
  subjectType: 'job' | 'runner'
  subjectId: string
  /** Job feature or runner name. */
  subjectName: string
  /** null for runner items. */
  projectSlug: string | null
  since: string | null
  stage?: string
  silentSec?: number
  runnerName?: string | null
  pending?: number
  oldestSec?: number
  verdict?: string
  reasons?: AttentionReason[]
  reasonsTotal?: number
  conditions?: RunnerCondition[]
}

export interface FleetDashboard {
  /** Server time every age is measured against. */
  generatedAt: string
  counts: DashboardCounts
  runners: DashboardRunner[]
  /** Oldest first, at most 200. */
  activeJobs: DashboardActiveJob[]
  activeTruncated: boolean
  /** Finished in the last 24 h, newest first, at most 20. */
  recentJobs: DashboardRecentJob[]
  recentTruncated: boolean
  /** Errors first, then oldest since. */
  attention: AttentionItem[]
}

/** Spec §1.1: the admin route sees every project; the project route one project. */
export type DashboardScope = { kind: 'global' } | { kind: 'project'; slug: string }
export type ScopeKind = DashboardScope['kind']
