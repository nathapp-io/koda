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

/** #207: nax's verdict on starting the resolved config's interaction plugin (`InteractionCheck`). */
export interface FleetInteractionCheck {
  ok: boolean
  plugin: string | null
  code?: string
}

export interface FleetProfileNeeds {
  protocol: FleetProtocol
  providers: string[]
  sandbox: boolean
  interaction?: FleetInteractionCheck
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
  interaction?: FleetInteractionCheck
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
  | 'provider_unavailable' | 'sandbox' | 'interaction' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity'
  | 'config_jobs'

/** S3 §3: RUN | PLAN, plus the two config kinds that run no nax session. */
export type FleetJobKind = 'RUN' | 'PLAN' | 'CONFIG_EDIT' | 'CONFIG_DRIFT'

/** S3 §1: what a config job was asked to do. */
export type ConfigEditModeDto = 'edit' | 'regenerate' | 'drift'

/** S3 §3: the runner's outcome; ok, no_changes and drift are COMPLETED, the rest FAILED (D471). */
export type ConfigJobOutcomeDto = 'ok' | 'no_changes' | 'drift' | 'conflict' | 'invalid' | 'push_failed' | 'pr_failed' | 'timeout'

export interface ConfigJobResultDto {
  outcome: ConfigJobOutcomeDto
  /** Conflict files, drifted files, or committed files (at most 50). */
  files?: string[]
  /** nax output tail, at most 8 KiB. */
  output?: string
}

/** S3 §4.3: on config jobs only; the edit contents are fetched separately (Reopen edits). */
export interface FleetJobConfigEditDto {
  mode: ConfigEditModeDto
  files: string[]
  prTitle: string | null
  result: ConfigJobResultDto | null
}

export interface FleetJobStoryDto {
  id: string
  title: string
  status: string
  attempts: number
  dependsOn: string[]
}

/** S2b (j): nax post-run stage statuses (`postRun.<stage>.status`), each at most 32 printable ASCII; null when unknown. */
export interface FleetJobPostRunDto {
  acceptance?: string
  regression?: string
  finish?: string
}

/** S1.5 §1.6: gated/escalate relay nax's bash asks to the approvals inbox; RUN jobs only. */
export type BashMode = 'raw' | 'gated' | 'escalate'

/** C9 §2.2: a ticket linked to a fleet job (detail, dispatch, cancel and requeue responses). */
export interface FleetJobTicketDto {
  ref: string
  title: string
  status: string
}

/** C9 §2.2: GET /projects/:slug/tickets/:ref/fleet-jobs, newest first, read live from the job (D460). */
export interface TicketFleetJobDto {
  id: string
  command: 'RUN' | 'PLAN'
  feature: string
  state: FleetJobState
  stateReason: string | null
  escalationReason: string | null
  resultBranch: string | null
  resultSha: string | null
  resultPrUrl: string | null
  /** USD across all attempts, a 4-place decimal string. */
  costUsd: string
  queuedAt: string
  finishedAt: string | null
}

export interface FleetJobDto {
  id: string
  projectId: string
  repoId: string
  ref: string
  command: FleetJobKind
  feature: string
  planFrom: string | null
  profiles: string[]
  maxCostUsd: string
  bashMode: BashMode
  /** S1.5 2a: seconds a bash ask waits; used only when bashMode is not raw. */
  approvalTimeoutSec: number
  /** S1.5 2a: pending bash approvals of this job. */
  pendingApprovals: number
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
  /** S2b (j) D433: null when unknown and on list pages. */
  postRun: FleetJobPostRunDto | null
  /** S1b 3a D205: the schedule that dispatched the job, and fires merged into it while it was QUEUED. */
  scheduleId: string | null
  coalescedCount: number
  /** C9 D460: linked tickets on single-job responses; null on list pages. Optional for hand-built fixtures (plan P8). */
  tickets?: FleetJobTicketDto[] | null
  /** S3 §4.3: present on config jobs (CONFIG_EDIT, CONFIG_DRIFT); absent or null otherwise. */
  configEdit?: FleetJobConfigEditDto | null
}

export interface FleetJobEventDto {
  id: string
  seq: number
  leaseEpoch: number
  runnerSeq: number | null
  /** `approval_request`: a bash ask the runner relayed (S1.5 2a); its payload carries the masked command. */
  type: 'state' | 'snapshot' | 'lifecycle' | 'log' | 'approval_request'
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

/** POST /projects/:slug/fleet/jobs body; a raw job sends neither bash field (server default raw / 600 s). */
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
  bashMode?: BashMode
  approvalTimeoutSec?: number
  /** C9 §2.1: KEY-N refs, at most 20 (D450). */
  ticketRefs?: string[]
  /** C9 follow-up (#231): resend a RUN after confirming the ticket already has an open PR. */
  acknowledgeOpenPr?: boolean
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
  /** S1.5 2a: copied into every job the schedule dispatches. */
  bashMode: BashMode
  approvalTimeoutSec: number
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
  bashMode?: BashMode
  approvalTimeoutSec?: number
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
  bashMode: BashMode
  /** Omitted for raw: the stored value is kept (D300). */
  approvalTimeoutSec?: number
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
