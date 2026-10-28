import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetActorType } from '../../../common/enums';
import type { ApprovalRequestStatus } from '../../../approvals/domain/approval.domain';
import type { ApprovalFilters, ApprovalResolvedBy, FleetApprovalRecord, PendingCount, RequeueCandidate } from './approval.domain';

export type FleetAskKind = 'bash' | 'budget';

/** Permissions P3d-1: the fleet's row for one ask on the approval engine. */
export interface FleetApprovalAskRecord {
  requestId: string; kind: FleetAskKind; projectId: string | null; jobId: string | null; leaseEpoch: number | null;
  naxAskId: string | null; budgetPolicyId: string | null; resolvedBy: ApprovalResolvedBy | null;
  outcome: Record<string, unknown> | null;
  /** US-007 (fix rounds 2-3): the complete close a policy action intended for this ask, drained later if it could not settle it. */
  pendingClose: PersistedPolicyClose | null;
  /** US-009: the last engine status whose fleet outputs were recorded; a redelivery of it records nothing. */
  recordedStatus: string | null;
  publishedStatus: string | null;
  createdAt: Date; updatedAt: Date;
}

/**
 * The close a policy action intended, persisted on the link so the durable continuation settles a leftover ask with the
 * same resolution, fleet status, actor and outcome the action chose when it ran.
 */
export interface PersistedPolicyClose {
  resolvedBy: ApprovalResolvedBy;
  status: 'approved' | 'cancelled';
  actor: { type: FleetActorType; id: string; responsibleUserId: string | null };
  outcome?: Record<string, unknown>;
}

/** One policy ask the durable continuation claimed: the close its action intended, and where it belongs. */
export interface PolicyAskClose {
  requestId: string; budgetPolicyId: string | null; projectId: string | null; pendingClose: PersistedPolicyClose;
}

export type NewFleetApprovalAsk = Pick<FleetApprovalAskRecord, 'requestId' | 'kind' | 'projectId'>
  & Partial<Pick<FleetApprovalAskRecord, 'jobId' | 'leaseEpoch' | 'naxAskId' | 'budgetPolicyId'>>;

/** A link joined with its request's status. */
export interface FleetAskWithStatus { ask: FleetApprovalAskRecord; status: ApprovalRequestStatus }

/** One durable scheduling attempt; updatedAt on the link is its least-recently-attempted queue position. */
export interface JobEndAsk { requestId: string; jobId: string; projectId: string | null }

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
  /**
   * US-006 (F1): one page of a job's pending links for a sweep, keyset by `requestId` — pass the last id of the
   * previous page. `requestId` is unique, so a page boundary can neither skip nor repeat a row, which is what lets
   * a job-end sweep advance past a request another transaction holds. Ordered by `requestId`, not by request age:
   * a sweep closes every ask, so it needs a total order on the cursor, not the oldest-first order above.
   */
  findPendingForJobPage(jobId: string, afterRequestId?: string, limit?: number): Promise<FleetApprovalAskRecord[]>;
  /**
   * Claim a bounded, least-recently-attempted batch of pending bash asks on ended jobs. Skips held request/link
   * rows and durably moves selected links to the queue's tail via updatedAt. Call in an audited transaction;
   * commit this scheduling transaction before attempting closes, so failing closes cannot monopolize the queue.
   */
  claimEndedJobAsks(limit: number): Promise<JobEndAsk[]>;
  /**
   * US-007 (fix round 1): one page of a policy's pending links, keyset by `requestId` — the cursor is unique, so a
   * held request is stepped over rather than met again, and a newer pending ask is still settled.
   */
  findPendingForPolicyPage(budgetPolicyId: string, afterRequestId?: string, limit?: number): Promise<FleetApprovalAskRecord[]>;
  /**
   * Stamps the close a policy action intends for every pending ask of the policy that has none yet, and answers how many
   * asks of the policy are still pending. The first intent on a link wins: `closeForPolicy` and `PolicyAskCloseSweeper`
   * both replay it, so a later action can only add work to the queue, never rewrite what an earlier one committed to.
   */
  markPendingPolicyAsks(budgetPolicyId: string, close: PersistedPolicyClose): Promise<number>;
  /**
   * Claim a bounded, least-recently-attempted batch of pending policy asks that have an intended resolution. Skips held
   * request/link rows and durably moves the selected links to the queue's tail via updatedAt, so neither a held ask nor
   * a failing close can hide later work. Call in its own transaction, before attempting the closes.
   */
  claimPendingPolicyAsks(limit: number): Promise<PolicyAskClose[]>;
  setResolvedBy(requestId: string, resolvedBy: ApprovalResolvedBy): Promise<FleetApprovalAskRecord>;
  setPublishedStatus(requestId: string, publishedStatus: string): Promise<FleetApprovalAskRecord>;
  setRecordedStatus(requestId: string, recordedStatus: string): Promise<FleetApprovalAskRecord>;
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
