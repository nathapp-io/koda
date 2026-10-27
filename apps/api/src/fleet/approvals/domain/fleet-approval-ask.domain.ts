import type { ApprovalRequestStatus } from '../../../approvals/domain/approval.domain';
import type { ApprovalResolvedBy } from './approval.domain';

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
}
