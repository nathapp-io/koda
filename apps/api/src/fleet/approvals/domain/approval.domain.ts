import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const APPROVAL_TYPES = ['budget_override_required', 'nax_bash_escalate'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_RESOLVED_BY = ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'] as const;
export type ApprovalResolvedBy = (typeof APPROVAL_RESOLVED_BY)[number];

/** Ceiling on how many cancelled jobs one approval may offer for re-queue. */
export const MAX_REQUEUE_CANDIDATES = 200;

/** S1.5 §1.1. Money inside `payload` and `outcome` stays a decimal string. */
export interface FleetApprovalRecord {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  projectId: string | null;
  jobId: string | null;
  leaseEpoch: number | null;
  naxAskId: string | null;
  policyId: string | null;
  payload: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  requestedAt: Date;
  expiresAt: Date | null;
  decision: ApprovalDecision | null;
  decidedById: string | null;
  decidedAt: Date | null;
  resolvedBy: ApprovalResolvedBy | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFleetApproval {
  type: ApprovalType;
  projectId: string | null;
  policyId: string | null;
  payload: Record<string, unknown>;
  requestedAt: Date;
  jobId?: string | null;
  leaseEpoch?: number | null;
  naxAskId?: string | null;
  expiresAt?: Date | null;
}

export interface ApprovalResolution {
  status: Exclude<ApprovalStatus, 'pending'>;
  resolvedBy: ApprovalResolvedBy;
  decidedAt: Date;
  decision?: ApprovalDecision | null;
  decidedById?: string | null;
  comment?: string | null;
  outcome?: Record<string, unknown> | null;
}

export interface ApprovalFilters {
  projectId?: string;
  status?: ApprovalStatus;
  type?: ApprovalType;
  jobId?: string;
}

/** A cancelled-before-start job a policy may offer back for re-queue. */
export interface RequeueCandidate {
  jobId: string;
  projectId: string;
  feature: string;
  queuedAt: Date;
}

export interface PendingCount {
  projectId: string;
  slug: string;
  pending: number;
}

export const APPROVAL_REPOSITORY = Symbol('APPROVAL_REPOSITORY');

/** S1.5 §1.1. Lock order (§1.4): a caller that also locks a BudgetPolicy locks it first. */
export interface IApprovalRepository {
  create(data: NewFleetApproval): Promise<FleetApprovalRecord>;
  findById(id: string): Promise<FleetApprovalRecord | null>;
  /** SELECT ... FOR UPDATE (inside txManager.run); null when the approval is gone. */
  lockById(id: string): Promise<FleetApprovalRecord | null>;
  findPendingForPolicy(policyId: string): Promise<FleetApprovalRecord | null>;
  resolve(id: string, r: ApprovalResolution): Promise<FleetApprovalRecord>;
  setOutcome(id: string, outcome: Record<string, unknown>): Promise<FleetApprovalRecord>;
  /** Newest first. */
  findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>>;
  /** Only projects with a pending approval, in slug order. */
  countPending(projectIds: readonly string[]): Promise<PendingCount[]>;
  countPendingUnscoped(): Promise<number>;
  findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]>;
  findProjectSlug(projectId: string): Promise<string | null>;
}