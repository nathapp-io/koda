import { Module } from '@nestjs/common';
import { WebhookDispatchModule } from '../webhook/webhook-dispatch.module';
import { ApprovalAskService } from './approval-ask.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalGate } from './approval-gate.service';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalPolicyResolver } from './approval-policy.resolver';
import { ApprovalRequestExpirySweeper } from './approval-request-expiry.sweeper';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { ApprovalRequestEvents } from './approval-request-events';
import { ApprovalRequestQueries } from './approval-request.queries';
import { ApprovalMcpTools } from './mcp/approval-mcp-tools';
import { ApprovalRouteGate } from './route/approval-route-gate';

/**
 * P3 approval core. The command registry is one instance per application: an owning module registers
 * its commands in `onModuleInit` and callers resolve the same instance through this module's exports,
 * so `ApprovalGate` (US-008) and the registering module share one map.
 *
 * `ApprovalRequestExpirySweeper` is provided, not exported: its interval is the only caller (US-012).
 *
 * `ApprovalRouteGate` (US-003) is the REST entry point: a gated handler asks it to run a registered
 * route command, after it has refused a non-principal actor and one that does not hold the key.
 */
@Module({
  imports: [WebhookDispatchModule],
  exports: [ApprovalPolicyResolver, ApprovalPolicyService, ApprovalCommandRegistry, ApprovalGate, ApprovalRouteGate, ApprovalAskService, ApprovalDecisionService, ApprovalExecutionService, ApprovalRequestQueries, ApprovalMcpTools],
  providers: [
    ApprovalMcpTools,
    ApprovalRequestQueries,
    ApprovalDecisionService,
    ApprovalExecutionService,
    ApprovalRequestEvents,
    ApprovalGate,
    ApprovalRouteGate,
    ApprovalAskService,
    ApprovalPolicyService,
    ApprovalPolicyResolver,
    ApprovalRequestExpirySweeper,
    ApprovalCommandRegistry,
    PrismaApprovalPolicyRepository,
    { provide: APPROVAL_POLICY_REPOSITORY, useExisting: PrismaApprovalPolicyRepository },
    PrismaApprovalRequestRepository,
    { provide: APPROVAL_REQUEST_REPOSITORY, useExisting: PrismaApprovalRequestRepository },
  ],
})
export class ApprovalEngineModule {}
