import type { FleetJobKind, FleetJobState } from '../../common/enums';
import type { BashMode, RunnerCapabilities } from '../common/protocol';
import type { FleetJobStory } from '../jobs/domain/fleet-job.domain';
import type { MisfitReason } from '../jobs/placement-rules';

/** S2b (c) spec §1.1. */
export type DashboardScope = { kind: 'global' } | { kind: 'project'; projectId: string };

/** Spec §2 thresholds, all in seconds (from IFleetConfig). */
export interface AttentionThresholds {
  runnerOfflineSec: number;
  jobSilentSec: number;
  jobSilentErrorSec: number;
  jobStartSec: number;
  jobQueuedWarnSec: number;
  /** S3 §4.4 (D473): OAuth expiry window (days) for the `expiring` credential condition. */
  credentialExpiryWarnDays: number;
}

/** Spec §1.2 caps and windows. */
export const DASHBOARD_LIMITS = {
  activeJobs: 200,
  recentJobs: 20,
  recentWindowMs: 24 * 60 * 60 * 1000,
  reasonsShown: 20,
} as const;

/** A runner as the dashboard reads it; `capabilities` is null when the stored blob does not parse (spec §1.4). */
export interface DashboardRunnerRow {
  id: string;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  enabled: boolean;
  lastSeenAt: Date;
  capacity: number;
  daemonVersion: string;
  capabilities: RunnerCapabilities | null;
}

/** An active (or dry-run QUEUED) job with what the rules and the DTO need. */
export interface DashboardJobRow {
  id: string;
  projectId: string;
  projectSlug: string;
  projectDeleted: boolean;
  repoId: string;
  repoOwner: string;
  repoName: string;
  provider: 'github' | 'gitlab';
  feature: string;
  command: FleetJobKind;
  state: FleetJobState;
  runnerId: string | null;
  currentStoryId: string | null;
  currentPhase: string | null;
  stories: FleetJobStory[] | null;
  storiesTruncated: boolean;
  /** Decimal as string. */
  costSpentUsd: string;
  /** Decimal as string. */
  maxCostUsd: string;
  queuedAt: Date;
  assignedAt: Date | null;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  profiles: string[];
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  bashMode: BashMode;
}

/** A terminal job finished inside the recent window (spec §1.2). */
export interface DashboardRecentRow {
  id: string;
  projectSlug: string;
  repoOwner: string;
  repoName: string;
  feature: string;
  command: FleetJobKind;
  state: FleetJobState;
  stateReason: string | null;
  runnerName: string | null;
  /** Decimal as string. */
  costSpentUsd: string;
  startedAt: Date | null;
  finishedAt: Date;
  resultPrUrl: string | null;
}

export interface PendingSummary {
  jobId: string;
  count: number;
  oldestRequestedAt: Date;
}

export const ATTENTION_KINDS = ['job_silent', 'job_waiting_approval', 'job_unplaceable', 'runner_unhealthy'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export const SEVERITIES = ['error', 'warning'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const UNPLACEABLE_VERDICTS = ['never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed'] as const;
export type UnplaceableVerdict = (typeof UNPLACEABLE_VERDICTS)[number];
export const CONDITION_TYPES = ['offline', 'credential', 'interaction', 'stale_nax', 'configuration'] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];
export const CREDENTIAL_WHY = ['missing', 'unavailable', 'expired', 'expiring'] as const;
export type CredentialWhy = (typeof CREDENTIAL_WHY)[number];
/** Every MisfitReason, for the DTO enum (same list as PlacementMisfitDto). */
export const MISFIT_REASONS: readonly MisfitReason[] = [
  'disabled', 'offline', 'budget_paused', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox',
  'interaction', 'tools', 'approvals_relay', 'busy_repo', 'capacity', 'thread_capacity', 'thread_backend', 'threads_disabled',
];

export interface AttentionReason {
  runnerName: string;
  reason: MisfitReason;
}

export interface RunnerCondition {
  type: ConditionType;
  jobsHeld?: number;
  providerId?: string;
  why?: CredentialWhy;
  version?: string;
  latest?: string;
  /** #207 interaction: the plugin nax could not start. */
  plugin?: string;
  /** #207 interaction: nax's error code. */
  code?: string;
  /** #207 interaction: the profile; absent means the base config. */
  profile?: string;
}

/** Spec §2: one flat shape; the per-kind fields are optional. No prose (repo i18n rule). */
export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  severity: Severity;
  subjectType: 'job' | 'runner';
  subjectId: string;
  subjectName: string;
  projectSlug: string | null;
  since: string | null;
  stage?: 'starting' | 'running';
  silentSec?: number;
  runnerName?: string | null;
  pending?: number;
  oldestSec?: number;
  verdict?: UnplaceableVerdict;
  reasons?: AttentionReason[];
  reasonsTotal?: number;
  conditions?: RunnerCondition[];
}

/** Whole seconds from `at` to `now`, never negative. */
export const secondsSince = (now: Date, at: Date): number => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
