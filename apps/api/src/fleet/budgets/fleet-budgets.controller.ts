import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { BudgetRoute, BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

const ADMIN: BudgetRoute = { kind: 'admin' };

/** S1b §2.4 global-admin routes: global and runner policies, and the list of every policy. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/budgets')
export class FleetBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Every budget policy with its current window spend (global admin)' })
  @ApiResponse({ status: 200, type: [BudgetPolicyDto] })
  async list() {
    return JsonResponse.Ok(await this.budgets.list(ADMIN));
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Create a global or runner budget policy (global admin)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetInput: wrong scope for this route' })
  @ApiResponse({ status: 404, description: 'Runner not found' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.create(principal.id, ADMIN, dto));
  }

  @Patch(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Change the amount, warn, hard stop or running-jobs rule of a global or runner policy (global admin)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.update(principal.id, ADMIN, id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Delete a global or runner policy; lifts its pause (global admin)' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.budgets.remove(principal.id, ADMIN, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Resume a paused global or runner policy, optionally raising the amount (global admin)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.resume(principal.id, ADMIN, id, dto.amountUsd));
  }
}
