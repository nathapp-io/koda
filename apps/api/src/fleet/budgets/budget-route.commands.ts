import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';

export const BUDGET_ROUTE_VARIANTS = {
  globalCreate: 'rest:fleet-budgets.create',
  globalUpdate: 'rest:fleet-budgets.update',
  globalDelete: 'rest:fleet-budgets.delete',
  globalResume: 'rest:fleet-budgets.resume',
  projectCreate: 'rest:project-fleet-budgets.create',
  projectUpdate: 'rest:project-fleet-budgets.update',
  projectDelete: 'rest:project-fleet-budgets.delete',
  projectResume: 'rest:project-fleet-budgets.resume',
} as const;

type IdInput = { id: string };
type UpdateInput = IdInput & { patch: UpdateBudgetPolicyDto };
type ResumeInput = IdInput & { body: ResumeBudgetPolicyDto };
type ProjectInput<T> = T & { projectId: string };

/** REST budget writes: validation now, domain checks only when the command executes. */
@Injectable()
export class BudgetRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly budgets: BudgetsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CreateBudgetPolicyDto, BudgetPolicyDto>({
      key: 'fleet.budget.create',
      variant: BUDGET_ROUTE_VARIANTS.globalCreate,
      parse: (input) => parseBody(CreateBudgetPolicyDto, input),
      run: (principal, input) => this.budgets.create(principal.id, { kind: 'admin' }, input),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<UpdateInput, BudgetPolicyDto>({
      key: 'fleet.budget.update',
      variant: BUDGET_ROUTE_VARIANTS.globalUpdate,
      parse: (input) => {
        const ids = parseRouteInput(input, ['id']);
        const { patch = {} } = input as { patch?: unknown };
        return { ...ids, patch: parseBody(UpdateBudgetPolicyDto, patch) };
      },
      run: (principal, input) => this.budgets.update(principal.id, { kind: 'admin' }, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<IdInput, null>({
      key: 'fleet.budget.delete',
      variant: BUDGET_ROUTE_VARIANTS.globalDelete,
      parse: (input) => {
        const ids = parseRouteInput(input, ['id']);
        return ids;
      },
      run: async (principal, input) => {
        await this.budgets.remove(principal.id, { kind: 'admin' }, input.id);
        return null;
      },
    }, this.loader));

    this.commands.register(routeCommand<ResumeInput, BudgetPolicyDto>({
      key: 'fleet.budget.resume',
      variant: BUDGET_ROUTE_VARIANTS.globalResume,
      parse: (input) => {
        const ids = parseRouteInput(input, ['id']);
        const { body = {} } = input as { body?: unknown };
        return { ...ids, body: parseBody(ResumeBudgetPolicyDto, body) };
      },
      run: (principal, input) => this.budgets.resume(principal.id, { kind: 'admin' }, input.id, input.body.amountUsd),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<ProjectInput<{ policy: CreateBudgetPolicyDto }>, BudgetPolicyDto>({
      key: 'fleet.budget.create',
      variant: BUDGET_ROUTE_VARIANTS.projectCreate,
      parse: (input) => {
        const ids = parseRouteInput(input, ['projectId']);
        const { policy = {} } = input as { policy?: unknown };
        return { ...ids, policy: parseBody(CreateBudgetPolicyDto, policy) };
      },
      run: (principal, input) => this.budgets.create(principal.id, { kind: 'project', projectId: input.projectId }, input.policy),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<ProjectInput<UpdateInput>, BudgetPolicyDto>({
      key: 'fleet.budget.update',
      variant: BUDGET_ROUTE_VARIANTS.projectUpdate,
      parse: (input) => {
        const ids = parseRouteInput(input, ['projectId', 'id']);
        const { patch = {} } = input as { patch?: unknown };
        return { ...ids, patch: parseBody(UpdateBudgetPolicyDto, patch) };
      },
      run: (principal, input) => this.budgets.update(principal.id, { kind: 'project', projectId: input.projectId }, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<ProjectInput<IdInput>, null>({
      key: 'fleet.budget.delete',
      variant: BUDGET_ROUTE_VARIANTS.projectDelete,
      parse: (input) => {
        const ids = parseRouteInput(input, ['projectId', 'id']);
        return ids;
      },
      run: async (principal, input) => {
        await this.budgets.remove(principal.id, { kind: 'project', projectId: input.projectId }, input.id);
        return null;
      },
    }, this.loader));

    this.commands.register(routeCommand<ProjectInput<ResumeInput>, BudgetPolicyDto>({
      key: 'fleet.budget.resume',
      variant: BUDGET_ROUTE_VARIANTS.projectResume,
      parse: (input) => {
        const ids = parseRouteInput(input, ['projectId', 'id']);
        const { body = {} } = input as { body?: unknown };
        return { ...ids, body: parseBody(ResumeBudgetPolicyDto, body) };
      },
      run: (principal, input) => this.budgets.resume(principal.id, { kind: 'project', projectId: input.projectId }, input.id, input.body.amountUsd),
      toResult: (result) => result,
    }, this.loader));
  }
}
