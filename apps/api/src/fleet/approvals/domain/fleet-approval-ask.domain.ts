import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { ApprovalRequestStatus } from '../../../approvals/domain/approval.domain';
import type { ApprovalFilters, ApprovalResolvedBy, FleetApprovalRecord, PendingCount, RequeueCandidate } from './approval.domain';

export type FleetAskKind = 'bash' | 'budget';

/** Permissions P3d-1: the fleet's row for one ask on the approval engine. */
export interface FleetApprovalAskRecord {
  requestId: string; kind: FleetAskKind; projectId: string | null; jobId: string | null; leaseEpoch: number | null;
  naxAskId: string | null; budgetPolicyId: string | null; resolvedBy: ApprovalResolvedBy | null;
  outcome: Record<string, unknown> | null; createdAt: Date; updatedAt: Date;
}

export type NewFleetApprovalAsk = Pick<FleetApprovalAskRecord, 'requestId' | 'kind' | 'projectId'>
  & Partial<Pick<FleetApprovalAskRecord, 'jobId' | 'leaseEpoch' | 'naxAskId' | 'budgetPolicyId'>>;

/** A link joined with its request's status. */
export interface FleetAskWithStatus { ask: FleetApprovalAskRecord; status: ApprovalRequestStatus }

export const FLEET_APPROVAL_ASK_REPOSITORY = Symbol('FLEET_APPROVAL_ASK_REPOSITORY');

/** The `take` bound of `findPendingForJob` (`.nax/rules/api-data.md`: every findMany is bounded). */
export const MAX_PENDING_ASKS_PER_JOB = 100;

/**
 * The most projects one all-project pending count answers (US-002). A global badge read must not group
 * and hydrate an unbounded installation: past this many projects with a pending ask the tail is left
 * out and the read is logged as truncated, so callers see a bounded list rather than an OOM.
 */
export const MAX_COUNTED_PROJECTS = 500;

/**
 * Permissions P3d-1. The link table's storage contract: `ApprovalStoreModule` provides it behind the
 * module-private token and publishes it as `FleetApprovalAskStore`, never as this interface.
 */
export interface IFleetApprovalAskRepository {
  insert(data: NewFleetApprovalAsk): Promise<FleetApprovalAskRecord>;
  findByRequest(requestId: string): Promise<FleetApprovalAskRecord | null>;
  /** S1.5 2a: a re-reported ask is the same ask. */
  findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetAskWithStatus | null>;
  /** SELECT ... FOR UPDATE on the link row, inside txManager.run. */
  lockByRequest(requestId: string): Promise<FleetApprovalAskRecord | null>;
  /** Links whose request is pending, oldest request first, at most MAX_PENDING_ASKS_PER_JOB (100). */
  findPendingForJob(jobId: string): Promise<FleetApprovalAskRecord[]>;
  findPendingForPolicy(budgetPolicyId: string): Promise<FleetApprovalAskRecord | null>;
  setResolvedBy(requestId: string, resolvedBy: ApprovalResolvedBy): Promise<FleetApprovalAskRecord>;
  /** Replaces the outcome. */
  setOutcome(requestId: string, outcome: Record<string, unknown>): Promise<FleetApprovalAskRecord>;

  /** US-002: the fleet view of one ask; null when the request is not a fleet ask or has no link. */
  findApproval(requestId: string): Promise<FleetApprovalRecord | null>;
  /** Fleet-key requests that have a link; newest createdAt first, then id. */
  findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>>;
  countPending(projectIds: readonly string[]): Promise<PendingCount[]>;
  /** Every live project's pending asks, bounded by MAX_COUNTED_PROJECTS (truncation is logged). */
  countPendingAllProjects(): Promise<PendingCount[]>;
  countPendingUnscoped(): Promise<number>;
  /** Pending ask count per job id; jobs with none are absent. */
  countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>>;
  findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]>;
  findProjectSlug(projectId: string): Promise<string | null>;
}
