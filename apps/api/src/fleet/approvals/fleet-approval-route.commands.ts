import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { ApprovalExecutionService } from '../../approvals/approval-execution.service';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import { ApprovalRequestSummaryDto } from '../../approvals/dto/approval-request.dto';
import { routeCommand } from '../../approvals/route/route-command';
import { ApprovalsService, type FleetDecideInput } from './approvals.service';

export const FLEET_APPROVAL_ROUTE_VARIANTS = { decide: 'rest:project-fleet-approvals.decide' } as const;

@Injectable()
export class FleetApprovalRouteCommands implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    private readonly approvals: ApprovalsService,
    private readonly execution: ApprovalExecutionService,
    private readonly principalLoader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    for (const key of ['fleet.approval.decide.bash', 'fleet.approval.decide.budget']) {
      const command = routeCommand<FleetDecideInput, ApprovalRequestRecord>({
        key,
        variant: FLEET_APPROVAL_ROUTE_VARIANTS.decide,
        parse: parseDecide,
        run: (principal, input) => this.approvals.recordDecide(principal, input),
        toResult: ApprovalRequestSummaryDto.from,
        // The engine's inner eligibility check, not the metadata type key, is authoritative.
        skipKeyRecheck: true,
      }, this.principalLoader);
      // Only deferred execution calls this hook; the immediate handler executes and reloads itself.
      command.afterCommit = async (input) => {
        if (input.decision === 'approve') await this.execution.execute(input.requestId);
      };
      this.registry.register(command);
    }
  }
}

/** The shipped decision command's translated input contract, without a slug/body envelope. */
function parseDecide(input: unknown): FleetDecideInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ValidationAppException({}, 'approvals.invalidInput');
  const { requestId, decision, comment, params } = input as Record<string, unknown>;
  if (typeof requestId !== 'string' || requestId.length === 0 ||
      (decision !== 'approve' && decision !== 'reject') || (comment !== null && typeof comment !== 'string')) {
    throw new ValidationAppException({}, 'approvals.invalidInput');
  }
  return { requestId, decision, comment: typeof comment === 'string' ? comment : null, ...(params === undefined ? {} : { params }) };
}
