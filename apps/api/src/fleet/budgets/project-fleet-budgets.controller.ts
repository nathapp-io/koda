import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { BUDGET_ROUTE_VARIANTS } from './budget-route.commands';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { BudgetRoute, BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

const route = (ctx: ProjectContext): BudgetRoute => ({ kind: 'project', projectId: ctx.project.id });

/**
 * S1b §2.4 project routes, migrated onto permission keys by permissions P1d (US-006): a member reads
 * with `fleet.budget.read` (every project role holds `*.read`); create, update, delete and resume need
 * their own keys, which a project ADMIN holds through `*` — the `ctx.role === 'ADMIN'` check those
 * routes used to make is now the `developer` role not holding them.
 *
 * Every route declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`, so the membership
 * guard resolves `request.projectContext` before the key check and runs exactly once per request.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/budgets')
export class ProjectFleetBudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.read')
  @ApiOperation({ summary: "The project's project and repo policies plus the global ones, read-only (fleet.budget.read)" })
  @ApiResponse({ status: 200, type: [BudgetPolicyDto] })
  @ApiResponse({ status: 403, description: 'fleet.budget.read is missing' })
  async list(@CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.budgets.list(route(ctx)));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.create')
  @ApprovalGated()
  @ApiOperation({ summary: 'Create a project or repo budget policy (fleet.budget.create)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 403, description: 'fleet.budget.create is missing' })
  @ApiResponse({ status: 404, description: 'Repo not in this project' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext) {
    const outcome = await this.routeGate.run<BudgetPolicyDto>({
      key: 'fleet.budget.create',
      variant: BUDGET_ROUTE_VARIANTS.projectCreate,
      projectId: ctx.project.id,
      input: { projectId: ctx.project.id, policy: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.update')
  @ApprovalGated()
  @ApiOperation({ summary: 'Change a project or repo policy (fleet.budget.update)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 403, description: 'fleet.budget.update is missing' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such project policy' })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext) {
    const outcome = await this.routeGate.run<BudgetPolicyDto>({
      key: 'fleet.budget.update',
      variant: BUDGET_ROUTE_VARIANTS.projectUpdate,
      projectId: ctx.project.id,
      input: { projectId: ctx.project.id, id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete a project or repo policy; lifts its pause (fleet.budget.delete)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'fleet.budget.delete is missing' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such project policy' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.budget.delete',
      variant: BUDGET_ROUTE_VARIANTS.projectDelete,
      projectId: ctx.project.id,
      input: { projectId: ctx.project.id, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }

  @Post(':id/resume')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.resume')
  @ApprovalGated()
  @ApiOperation({ summary: 'Resume a paused project or repo policy, optionally raising the amount (fleet.budget.resume)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 403, description: 'fleet.budget.resume is missing' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such project policy' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto, @CurrentProject() ctx: ProjectContext) {
    const outcome = await this.routeGate.run<BudgetPolicyDto>({
      key: 'fleet.budget.resume',
      variant: BUDGET_ROUTE_VARIANTS.projectResume,
      projectId: ctx.project.id,
      input: { projectId: ctx.project.id, id, body: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
