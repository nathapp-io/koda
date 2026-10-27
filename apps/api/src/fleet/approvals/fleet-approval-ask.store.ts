import { Inject, Injectable } from '@nestjs/common';
import type { ApprovalResolvedBy } from './domain/approval.domain';
import {
  FLEET_APPROVAL_ASK_REPOSITORY, FleetApprovalAskRecord, FleetAskWithStatus, IFleetApprovalAskRepository, NewFleetApprovalAsk,
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

  findPendingForPolicy(budgetPolicyId: string): Promise<FleetApprovalAskRecord | null> {
    return this.asks.findPendingForPolicy(budgetPolicyId);
  }

  setResolvedBy(requestId: string, resolvedBy: ApprovalResolvedBy): Promise<FleetApprovalAskRecord> {
    return this.asks.setResolvedBy(requestId, resolvedBy);
  }

  setOutcome(requestId: string, outcome: Record<string, unknown>): Promise<FleetApprovalAskRecord> {
    return this.asks.setOutcome(requestId, outcome);
  }
}
