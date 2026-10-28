import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalRequestQueries } from './approval-request.queries';
import { ApprovalPolicyNotFoundError } from './domain/approval.errors';
import { CreateApprovalPolicyDto, UpdateApprovalPolicyDto } from './dto/approval-policy.dto';
import { toPolicySubject } from './dto/approval-policy-subject.dto';
import { parseBody } from './route/parse-body';
import { routeCommand } from './route/route-command';

export const APPROVAL_ROUTE_VARIANTS = {
  policyCreate: 'rest:approval-policies.create',
  policyUpdate: 'rest:approval-policies.update',
  policyDelete: 'rest:approval-policies.delete',
} as const;

const POLICY_KEY = 'approval.policy.manage';

type PolicyUpdateInput = { id: string; patch: UpdateApprovalPolicyDto };
type PolicyDeleteInput = { id: string };

@Injectable()
export class ApprovalRouteCommands implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    private readonly policies: ApprovalPolicyService,
    // Kept in the shared constructor for the project-policy and decide variants added subsequently.
    _decisions: ApprovalDecisionService,
    _execution: ApprovalExecutionService,
    _queries: ApprovalRequestQueries,
    private readonly principalLoader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
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
