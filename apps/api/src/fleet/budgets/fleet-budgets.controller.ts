import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { BUDGET_ROUTE_VARIANTS } from './budget-route.commands';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { BudgetRoute, BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

const ADMIN: BudgetRoute = { kind: 'admin' };

/**
 * S1b §2.4 global routes, migrated onto permission keys by permissions P1d (US-006): global and runner
 * policies, for a caller holding the key globally. "Global" is what makes `@RequiredPermission('ADMIN')`
 * refuse a project-only grant: a project binding applies in its project, never in the global scope.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/budgets')
export class FleetBudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.budget.read')
  @ApiOperation({ summary: 'Every budget policy with its current window spend (fleet.budget.read, global)' })
  @ApiResponse({ status: 200, type: [BudgetPolicyDto] })
  @ApiResponse({ status: 403, description: 'fleet.budget.read is missing globally' })
  async list() {
    return JsonResponse.Ok(await this.budgets.list(ADMIN));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('fleet.budget.create')
  @ApprovalGated()
  @ApiOperation({ summary: 'Create a global or runner budget policy (fleet.budget.create, global)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetInput: wrong scope for this route' })
  @ApiResponse({ status: 403, description: 'fleet.budget.create is missing globally' })
  @ApiResponse({ status: 404, description: 'Runner not found' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto) {
    const outcome = await this.routeGate.run<BudgetPolicyDto>({
      key: 'fleet.budget.create',
      variant: BUDGET_ROUTE_VARIANTS.globalCreate,
      projectId: null,
      input: dto,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':id')
  @UseGuards(RequiresGuard)
  @Requires('fleet.budget.update')
  @ApprovalGated()
  @ApiOperation({ summary: 'Change the amount, warn, hard stop or running-jobs rule of a global or runner policy (fleet.budget.update, global)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 403, description: 'fleet.budget.update is missing globally' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such global or runner policy' })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto) {
    const outcome = await this.routeGate.run<BudgetPolicyDto>({
      key: 'fleet.budget.update',
      variant: BUDGET_ROUTE_VARIANTS.globalUpdate,
      projectId: null,
      input: { id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RequiresGuard)
  @Requires('fleet.budget.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete a global or runner policy; lifts its pause (fleet.budget.delete, global)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'fleet.budget.delete is missing globally' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such global or runner policy' })
  async remove(@Param('id') id: string): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.budget.delete',
      variant: BUDGET_ROUTE_VARIANTS.globalDelete,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }

  @Post(':id/resume')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('fleet.budget.resume')
  @ApprovalGated()
  @ApiOperation({ summary: 'Resume a paused global or runner policy, optionally raising the amount (fleet.budget.resume, global)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 403, description: 'fleet.budget.resume is missing globally' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such global or runner policy' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto) {
    const outcome = await this.routeGate.run<BudgetPolicyDto>({
      key: 'fleet.budget.resume',
      variant: BUDGET_ROUTE_VARIANTS.globalResume,
      projectId: null,
      input: { id, body: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
