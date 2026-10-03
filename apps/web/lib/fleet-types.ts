/**
 * Fleet S1 wire types for the web (hand-written: the web has no generated client).
 * Shapes follow docs/superpowers/plans/2026-10-01-fleet-s1-slice-4-overview.md.
 */

import type { FleetJobState } from '~/lib/project-event-stream'

/** Page envelope of every fleet list (`toPageResult`). */
export interface FleetPage<T> {
  records: T[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

/** Runner and repo lists ask for one page of this size (plan D125). */
export const FLEET_LIST_SIZE = 100

export type FleetProtocol = 'acp' | 'native'

export interface FleetProfileNeeds {
  protocol: FleetProtocol
  providers: string[]
  sandbox: boolean
}

export interface FleetCredentialStored {
  kind: 'api-key' | 'oauth'
  expires?: string
  expired: boolean
}

export interface FleetCredential {
  providerId: string
  available: boolean
  stored: FleetCredentialStored | null
  exec?: 'served' | 'declined' | 'error'
  ambient: boolean
}

/** `RunnerCapabilities` from packages/fleet-protocol; on the wire it is an untyped object. */
export interface FleetCapabilities {
  nax: { version: string; protocols: FleetProtocol[] }
  sandbox: { available: boolean; probedAt: string; error?: string }
  profiles: Record<string, FleetProfileNeeds>
  credentials: FleetCredential[]
  tools: { git: boolean; gh: boolean; glab: boolean }
  executors: string[]
}

export interface FleetRunner {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  capacity: number
  capabilities: Record<string, unknown>
  daemonVersion: string
  protocolVersion: number
  enabled: boolean
  lastSeenAt: string
  createdAt: string
  bootId: string
  bootedAt: string | null
  online: boolean
}

export interface FleetRunnerPatch {
  enabled?: boolean
  labels?: string[]
  capacity?: number
}

export interface FleetEnrollment {
  id: string
  labels: string[]
  expiresAt: string
  usedAt: string | null
  runnerId: string | null
  createdById: string
  createdAt: string
}

export interface FleetEnrollmentCreated extends FleetEnrollment {
  token: string
}

/** Project-member view of a runner (GET /projects/:slug/fleet/runners). */
export interface FleetRunnerSummary {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  enabled: boolean
  online: boolean
  profiles: string[]
}

export type FleetProvider = 'github' | 'gitlab'

export interface FleetRepo {
  id: string
  projectId: string
  provider: FleetProvider
  owner: string
  name: string
  defaultBranch: string
  githubInstallationId: string | null
  createdAt: string
}

export interface NewFleetRepo {
  projectSlug: string
  provider: FleetProvider
  owner: string
  name: string
}

export interface FleetRepoCheck {
  repoId: string
  reachable: boolean
  reason: string | null
  checkedAt: string
}

export type { FleetJobState }

export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity'

export interface FleetJobStoryDto {
  id: string
  title: string
  status: string
  attempts: number
  dependsOn: string[]
}

export interface FleetJobDto {
  id: string
  projectId: string
  repoId: string
  ref: string
  command: 'RUN' | 'PLAN'
  feature: string
  planFrom: string | null
  profiles: string[]
  maxCostUsd: string
  bashMode: string
  selectorLabels: string[]
  pinnedRunnerId: string | null
  runnerId: string | null
  leaseEpoch: number
  state: FleetJobState
  stateReason: string | null
  requestedById: string
  queuedAt: string
  assignedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  naxRunId: string | null
  naxLogRunId: string | null
  naxCostRunId: string | null
  progress: unknown
  currentStoryId: string | null
  currentPhase: string | null
  costSpentUsd: string
  lastHeartbeatAt: string | null
  finishResult: string | null
  escalationReason: string | null
  exitCode: number | null
  resultBranch: string | null
  resultSha: string | null
  resultPrUrl: string | null
  wipPush: string | null
  stories: FleetJobStoryDto[] | null
  storiesTruncated: boolean
  /** S1b 3a D205: the schedule that dispatched the job, and fires merged into it while it was QUEUED. */
  scheduleId: string | null
  coalescedCount: number
}

export interface FleetJobEventDto {
  id: string
  seq: number
  leaseEpoch: number
  runnerSeq: number | null
  type: 'state' | 'snapshot' | 'lifecycle' | 'log'
  payload: unknown
  createdAt: string
}

export interface PlacementMisfit {
  runnerId: string
  name: string
  reason: MisfitReason
}

export interface DispatchResultDto {
  job: FleetJobDto
  placement: { assigned: boolean; runnerId: string | null; misfits: PlacementMisfit[] }
}

/** POST /projects/:slug/fleet/jobs body; bashMode is left to the server default (raw). */
export interface DispatchBody {
  repoId: string
  command: 'RUN' | 'PLAN'
  feature: string
  maxCostUsd: number
  ref?: string
  planFrom?: string
  profiles?: string[]
  selectorLabels?: string[]
  pinnedRunnerId?: string
}

/** S1b slice 2a wire types (apps/api/src/fleet/budgets/dto). Money is a decimal string. */
export const BUDGET_SCOPE_TYPES = ['global', 'project', 'repo', 'runner'] as const
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number]
export const BUDGET_WINDOW_KINDS = ['calendar_month_utc', 'lifetime'] as const
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number]
export const BUDGET_RUNNING_JOBS = ['finish', 'cancel'] as const
export type BudgetRunningJobs = (typeof BUDGET_RUNNING_JOBS)[number]

export interface BudgetPolicyDto {
  id: string
  scopeType: BudgetScopeType
  scopeId: string | null
  projectId: string | null
  windowKind: BudgetWindowKind
  amountUsd: string
  warnPercent: number | null
  hardStop: boolean
  runningJobs: BudgetRunningJobs
  /** Effectively paused now (S1b section 2.3); the web never recomputes it. */
  paused: boolean
  pausedAt: string | null
  windowStart: string
  spentUsd: string
  warnReached: boolean
  updatedById: string
  createdAt: string
  updatedAt: string
}

export interface NewBudgetPolicyBody {
  scopeType: BudgetScopeType
  scopeId?: string
  windowKind: BudgetWindowKind
  amountUsd: number
  warnPercent: number | null
  hardStop: boolean
  runningJobs: BudgetRunningJobs
}

export interface BudgetPolicyPatchBody {
  amountUsd?: number
  warnPercent?: number | null
  hardStop?: boolean
  runningJobs?: BudgetRunningJobs
}

/** S1b slice 3a wire types (apps/api/src/fleet/schedules/dto). Money is a decimal string. */
export const SCHEDULE_DISABLED_REASONS = ['completed', 'finish_failed', 'no_progress', 'owner_lost_access', 'template_invalid', 'manual'] as const
export type ScheduleDisabledReason = (typeof SCHEDULE_DISABLED_REASONS)[number]

export interface ScheduleDto {
  id: string
  projectId: string
  /** May name a repo deleted since; the schedule is then disabled (template_invalid). */
  repoId: string
  name: string
  cron: string
  timezone: string
  feature: string
  ref: string
  profiles: string[]
  maxCostUsd: string
  selectorLabels: string[]
  pinnedRunnerId: string | null
  enabled: boolean
  /** Null while disabled. */
  nextFireAt: string | null
  lastFiredAt: string | null
  lastJobId: string | null
  lastPassedCount: number
  noProgressTicks: number
  noProgressLimit: number
  disabledReason: ScheduleDisabledReason | null
  totalCostUsd: string
  createdById: string
  updatedById: string
  createdAt: string
  updatedAt: string
}

export interface NewScheduleBody {
  name: string
  repoId: string
  feature: string
  cron: string
  timezone: string
  ref?: string
  profiles?: string[]
  maxCostUsd: number
  selectorLabels?: string[]
  pinnedRunnerId?: string
  noProgressLimit: number
}

/** The repo and the feature are fixed after create (3a D203). */
export interface SchedulePatchBody {
  name: string
  cron: string
  timezone: string
  ref: string
  profiles: string[]
  maxCostUsd: number
  selectorLabels: string[]
  pinnedRunnerId: string | null
  noProgressLimit: number
}

/** S1.5 slice 1a wire types (apps/api/src/fleet/approvals/dto). Money inside payload/outcome is a decimal string. */
export const APPROVAL_TYPES = ['budget_override_required', 'nax_bash_escalate'] as const
export type ApprovalType = (typeof APPROVAL_TYPES)[number]
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export const APPROVAL_DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]
export const APPROVAL_RESOLVED_BY = ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'] as const
export type ApprovalResolvedBy = (typeof APPROVAL_RESOLVED_BY)[number]

export interface RequeueCandidateDto {
  jobId: string
  projectId: string
  feature: string
  queuedAt: string
}

export interface FleetApprovalDto {
  id: string
  type: ApprovalType
  status: ApprovalStatus
  projectId: string | null
  jobId: string | null
  policyId: string | null
  payload: Record<string, unknown>
  outcome: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  decision: ApprovalDecision | null
  decidedById: string | null
  decidedAt: string | null
  resolvedBy: ApprovalResolvedBy | null
  comment: string | null
  /** GET :id of a pending budget approval only (spec §1.5). */
  requeueCandidates?: RequeueCandidateDto[]
  requeueCandidatesTruncated?: boolean
}

export interface ApprovalCountsDto {
  total: number
  unscoped: number
  projects: Array<{ projectId: string; slug: string; pending: number }>
}

export interface DecideApprovalBody {
  decision: ApprovalDecision
  amountUsd?: number
  requeueJobIds?: string[]
  comment?: string
}
