import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
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
  constructor(private readonly budgets: BudgetsService) {}

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
  @ApiOperation({ summary: 'Create a project or repo budget policy (fleet.budget.create)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 403, description: 'fleet.budget.create is missing' })
  @ApiResponse({ status: 404, description: 'Repo not in this project' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.create(principal.id, route(ctx), dto));
  }

  @Patch(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.update')
  @ApiOperation({ summary: 'Change a project or repo policy (fleet.budget.update)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 403, description: 'fleet.budget.update is missing' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such project policy' })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.update(principal.id, route(ctx), id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.delete')
  @ApiOperation({ summary: 'Delete a project or repo policy; lifts its pause (fleet.budget.delete)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'fleet.budget.delete is missing' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such project policy' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.budgets.remove(principal.id, route(ctx), id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.budget.resume')
  @ApiOperation({ summary: 'Resume a paused project or repo policy, optionally raising the amount (fleet.budget.resume)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 403, description: 'fleet.budget.resume is missing' })
  @ApiResponse({ status: 404, description: 'fleet.budgets: no such project policy' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.resume(principal.id, route(ctx), id, dto.amountUsd));
  }
}
