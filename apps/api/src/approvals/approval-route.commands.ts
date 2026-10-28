import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalRequestQueries } from './approval-request.queries';
import { ApprovalPolicyNotFoundError, ApprovalRequestExpiredError, ApprovalRequestNotPendingError, DeferredDecisionRefusedError } from './domain/approval.errors';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalRequestSummaryDto } from './dto/approval-request.dto';
import { CreateApprovalPolicyDto, UpdateApprovalPolicyDto } from './dto/approval-policy.dto';
import { toPolicySubject } from './dto/approval-policy-subject.dto';
import { parseBody } from './route/parse-body';
import { routeCommand } from './route/route-command';

export const APPROVAL_ROUTE_VARIANTS = {
  policyCreate: 'rest:approval-policies.create',
  policyUpdate: 'rest:approval-policies.update',
  policyDelete: 'rest:approval-policies.delete',
  projectPolicyCreate: 'rest:project-approval-policies.create',
  projectPolicyUpdate: 'rest:project-approval-policies.update',
  projectPolicyDelete: 'rest:project-approval-policies.delete',
  decide: 'rest:approvals.decide',
} as const;

const POLICY_KEY = 'approval.policy.manage';

type DecideInput = { requestId: string; decision: 'approve' | 'reject'; comment: string | null; params?: unknown };
type PolicyUpdateInput = { id: string; patch: UpdateApprovalPolicyDto };
type PolicyDeleteInput = { id: string };
type ProjectPolicyCreateInput = { projectId: string; policy: CreateApprovalPolicyDto };
type ProjectPolicyUpdateInput = { projectId: string; id: string; patch: UpdateApprovalPolicyDto };
type ProjectPolicyDeleteInput = { projectId: string; id: string };

@Injectable()
export class ApprovalRouteCommands implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    private readonly policies: ApprovalPolicyService,
    private readonly decisions: ApprovalDecisionService,
    private readonly execution: ApprovalExecutionService,
    _queries: ApprovalRequestQueries,
    private readonly principalLoader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    const decideCommand = routeCommand<DecideInput, ApprovalRequestRecord>({
      key: 'approval.decide',
      variant: APPROVAL_ROUTE_VARIANTS.decide,
      parse: (input) => {
        const envelope = requireObject(input);
        const requestId = requireId(envelope.requestId);
        const { decision, comment, params } = envelope;
        if ((decision !== 'approve' && decision !== 'reject') || (comment !== null && typeof comment !== 'string')) {
          throw new ValidationAppException({}, 'approvals.invalidInput');
        }
        return { requestId, decision, comment: typeof comment === 'string' ? comment : null, ...(params === undefined ? {} : { params }) };
      },
      run: async (_principal, { requestId, decision, comment, params }) => {
        try {
          return await this.decisions.recordDecision(requestId, decision, comment, new Date(), params);
        } catch (error) {
          // The engine treats its own not-pending row as a concurrency refusal. An inner row
          // settling meanwhile must instead fail this outer request, without losing its decision.
          if (error instanceof ApprovalRequestNotPendingError) throw new DeferredDecisionRefusedError('not-pending', error.status);
          if (error instanceof ApprovalRequestExpiredError) throw new DeferredDecisionRefusedError('expired');
          throw error;
        }
      },
      toResult: ApprovalRequestSummaryDto.from,
    }, this.principalLoader);
    // Only engine executions invoke this hook, after the outer transaction has committed.
    // The immediate handler executes the inner request itself to return its final status.
    decideCommand.afterCommit = async (input) => {
      if (input.decision === 'approve') await this.execution.execute(input.requestId);
    };
    this.registry.register(decideCommand);

    this.registry.register(routeCommand({
      key: POLICY_KEY,
      variant: APPROVAL_ROUTE_VARIANTS.policyCreate,
      parse: (input) => parseBody(CreateApprovalPolicyDto, input),
      run: (_principal, input) => this.policies.create({
        ...input,
        appliesTo: toPolicySubject(input.appliesTo),
        projectId: null,
      }),
    }, this.principalLoader));

    this.registry.register(routeCommand({
      key: POLICY_KEY,
      variant: APPROVAL_ROUTE_VARIANTS.policyUpdate,
      parse: (input): PolicyUpdateInput => {
        const envelope = requireObject(input);
        const id = requireId(envelope.id);
        const patch = parseBody(UpdateApprovalPolicyDto, envelope.patch);
        if (!Object.values(patch).some((value) => value !== undefined)) {
          throw new ValidationAppException({}, 'approvals.emptyPolicyPatch');
        }
        return { id, patch };
      },
      run: async (_principal, { id, patch }) => {
        const policy = await this.policies.get(id);
        if (policy.projectId !== null) throw new ApprovalPolicyNotFoundError(id);
        return this.policies.update(id, patch);
      },
    }, this.principalLoader));

    this.registry.register(routeCommand({
      key: POLICY_KEY,
      variant: APPROVAL_ROUTE_VARIANTS.projectPolicyCreate,
      parse: (input): ProjectPolicyCreateInput => {
        const envelope = requireObject(input);
        return { projectId: requireId(envelope.projectId), policy: parseBody(CreateApprovalPolicyDto, envelope.policy) };
      },
      run: (_principal, { projectId, policy }) => this.policies.create({
        ...policy, appliesTo: toPolicySubject(policy.appliesTo), projectId,
      }),
    }, this.principalLoader));

    this.registry.register(routeCommand({
      key: POLICY_KEY,
      variant: APPROVAL_ROUTE_VARIANTS.projectPolicyUpdate,
      parse: (input): ProjectPolicyUpdateInput => {
        const envelope = requireObject(input);
        const projectId = requireId(envelope.projectId);
        const id = requireId(envelope.id);
        const patch = parseBody(UpdateApprovalPolicyDto, envelope.patch);
        if (!Object.values(patch).some((value) => value !== undefined)) {
          throw new ValidationAppException({}, 'approvals.emptyPolicyPatch');
        }
        return { projectId, id, patch };
      },
      run: async (_principal, { projectId, id, patch }) => {
        const policy = await this.policies.get(id);
        if (policy.projectId !== projectId) throw new ApprovalPolicyNotFoundError(id);
        return this.policies.update(id, patch);
      },
    }, this.principalLoader));

    this.registry.register(routeCommand({
      key: POLICY_KEY,
      variant: APPROVAL_ROUTE_VARIANTS.projectPolicyDelete,
      parse: (input): ProjectPolicyDeleteInput => {
        const envelope = requireObject(input);
        return { projectId: requireId(envelope.projectId), id: requireId(envelope.id) };
      },
      run: async (_principal, { projectId, id }) => {
        const policy = await this.policies.get(id);
        if (policy.projectId !== projectId) throw new ApprovalPolicyNotFoundError(id);
        await this.policies.remove(id);
      },
    }, this.principalLoader));

    this.registry.register(routeCommand({
      key: POLICY_KEY,
      variant: APPROVAL_ROUTE_VARIANTS.policyDelete,
      parse: (input): PolicyDeleteInput => ({ id: requireId(requireObject(input).id) }),
      run: async (_principal, { id }) => {
        const policy = await this.policies.get(id);
        if (policy.projectId !== null) throw new ApprovalPolicyNotFoundError(id);
        await this.policies.remove(id);
      },
    }, this.principalLoader));
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationAppException({}, 'approvals.invalidInput');
  }
  return input as Record<string, unknown>;
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationAppException({}, 'approvals.invalidInput');
  }
  return value;
}
