import { Inject, Injectable } from '@nestjs/common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { ApprovalFilters, ApprovalResolvedBy, FleetApprovalRecord, PendingCount, RequeueCandidate } from './domain/approval.domain';
import {
  FLEET_APPROVAL_ASK_REPOSITORY, FleetApprovalAskRecord, FleetAskWithStatus, IFleetApprovalAskRepository, JobEndAsk,
  NewFleetApprovalAsk, PersistedPolicyClose, PolicyAskClose,
} from './domain/fleet-approval-ask.domain';

/**
 * Permissions P3d-1 (US-009): `ApprovalStoreModule`'s public face for the `FleetApprovalAsk` link table.
 * It delegates to the module-private repository, so budgets and jobs import the module without a cycle
 * (plan D226) and never see Prisma.
 */
@Injectable()
export class FleetApprovalAskStore {
  constructor(
    @Inject(FLEET_APPROVAL_ASK_REPOSITORY) private readonly asks: IFleetApprovalAskRepository,
  ) {}

  insert(data: NewFleetApprovalAsk): Promise<FleetApprovalAskRecord> {
    return this.asks.insert(data);
  }

  findByRequest(requestId: string): Promise<FleetApprovalAskRecord | null> {
    return this.asks.findByRequest(requestId);
  }

  findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetAskWithStatus | null> {
    return this.asks.findByAsk(jobId, leaseEpoch, naxAskId);
  }

  lockByRequest(requestId: string): Promise<FleetApprovalAskRecord | null> {
    return this.asks.lockByRequest(requestId);
  }

  findPendingForJob(jobId: string): Promise<FleetApprovalAskRecord[]> {
    return this.asks.findPendingForJob(jobId);
  }

  /** US-006 (F1): one keyset page of a job's pending links, for a sweep that must reach every ask. */
  findPendingForJobPage(jobId: string, afterRequestId?: string, limit?: number): Promise<FleetApprovalAskRecord[]> {
    return this.asks.findPendingForJobPage(jobId, afterRequestId, limit);
  }

  /** An audited, durable scheduling attempt that rotates past failing asks and skips held rows. */
  claimEndedJobAsks(limit: number): Promise<JobEndAsk[]> {
    return this.asks.claimEndedJobAsks(limit);
  }

  /**
   * US-007 (fix round 1): one page of a policy's pending links, keyset by request id, so a held ask cannot hide a
   * newer one. The close reads pages of these, never a single "the pending ask".
   */
  findPendingForPolicyPage(budgetPolicyId: string, afterRequestId?: string, limit?: number): Promise<FleetApprovalAskRecord[]> {
    return this.asks.findPendingForPolicyPage(budgetPolicyId, afterRequestId, limit);
  }

  /** US-007 (fix rounds 2-3): stamp the close a policy action intends on every pending ask of the policy. */
  markPendingPolicyAsks(budgetPolicyId: string, close: PersistedPolicyClose): Promise<number> {
    return this.asks.markPendingPolicyAsks(budgetPolicyId, close);
  }

  /** The durable policy-close queue: one bounded, skip-locked, least-recently-attempted batch. */
  claimPendingPolicyAsks(limit: number): Promise<PolicyAskClose[]> {
    return this.asks.claimPendingPolicyAsks(limit);
  }

  setResolvedBy(requestId: string, resolvedBy: ApprovalResolvedBy): Promise<FleetApprovalAskRecord> {
    return this.asks.setResolvedBy(requestId, resolvedBy);
  }

  /** US-009: the idempotency key of the fleet outputs a settled ask records. */
  setRecordedStatus(requestId: string, recordedStatus: string): Promise<FleetApprovalAskRecord> {
    return this.asks.setRecordedStatus(requestId, recordedStatus);
  }

  setOutcome(requestId: string, outcome: Record<string, unknown>): Promise<FleetApprovalAskRecord> {
    return this.asks.setOutcome(requestId, outcome);
  }

  findApproval(requestId: string): Promise<FleetApprovalRecord | null> {
    return this.asks.findApproval(requestId);
  }

  findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>> {
    return this.asks.findPage(f, page);
  }

  countPending(projectIds: readonly string[]): Promise<PendingCount[]> {
    return this.asks.countPending(projectIds);
  }

  countPendingAllProjects(): Promise<PendingCount[]> {
    return this.asks.countPendingAllProjects();
  }

  countPendingUnscoped(): Promise<number> {
    return this.asks.countPendingUnscoped();
  }

  countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>> {
    return this.asks.countPendingByJob(jobIds);
  }

  findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]> {
    return this.asks.findRequeueCandidates(policyId, since, limit);
  }

  findProjectSlug(projectId: string): Promise<string | null> {
    return this.asks.findProjectSlug(projectId);
  }
}
