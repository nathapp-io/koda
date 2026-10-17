import { Injectable } from '@nestjs/common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { FleetApprovalRecord } from './domain/approval.domain';
import type { DecideApprovalDto } from './dto/decide-approval.dto';
import type { ApprovalCaller } from './approvals.service';

/** What decides an `assistant_action` approval; the assistant module's handler implements it. */
export interface AssistantActionDecider {
  decide(caller: ApprovalCaller, approval: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalRecord>;
}

/**
 * 2a-D1: `ApprovalsModule` cannot import `AssistantModule` (that would be a cycle), so the decide route reaches the
 * handler through this port. `ApprovalStoreModule` provides it once for both importers; the handler registers
 * itself in `onModuleInit`.
 */
@Injectable()
export class AssistantActionPort {
  private decider: AssistantActionDecider | null = null;

  register(decider: AssistantActionDecider): void {
    this.decider = decider;
  }

  decide(caller: ApprovalCaller, approval: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalRecord> {
    if (!this.decider) throw new ConflictAppException({}, 'threads.disabled');
    return this.decider.decide(caller, approval, dto, now);
  }
}
