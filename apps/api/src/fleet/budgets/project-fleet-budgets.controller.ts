import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { BudgetRoute, BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

const route = (ctx: ProjectContext): BudgetRoute => ({ kind: 'project', projectId: ctx.project.id });

/** B3: project ADMIN of this project, or a global ADMIN (whose project role resolves to ADMIN). */
function requireProjectAdmin(ctx: ProjectContext, principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal) || ctx.role !== 'ADMIN') throw new ForbiddenAppException({}, 'projects');
}

/** S1b §2.4 project routes: members read; project ADMIN manages project and repo policies. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/budgets')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @ApiOperation({ summary: "The project's project and repo policies plus the global ones, read-only (project member)" })
  @ApiResponse({ status: 200, type: [BudgetPolicyDto] })
  async list(@CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.budgets.list(route(ctx)));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a project or repo budget policy (project ADMIN)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 404, description: 'Repo not in this project' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireProjectAdmin(ctx, principal);
    return JsonResponse.Ok(await this.budgets.create(principal.id, route(ctx), dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a project or repo policy (project ADMIN)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireProjectAdmin(ctx, principal);
    return JsonResponse.Ok(await this.budgets.update(principal.id, route(ctx), id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a project or repo policy; lifts its pause (project ADMIN)' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    requireProjectAdmin(ctx, principal);
    await this.budgets.remove(principal.id, route(ctx), id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resume a paused project or repo policy, optionally raising the amount (project ADMIN)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireProjectAdmin(ctx, principal);
    return JsonResponse.Ok(await this.budgets.resume(principal.id, route(ctx), id, dto.amountUsd));
  }
}
