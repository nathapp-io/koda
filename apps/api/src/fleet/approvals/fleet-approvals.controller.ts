import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalRoute, ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { ListApprovalsQuery } from './dto/list-approvals.query';

const ADMIN: ApprovalRoute = { kind: 'admin' };

/** S1.5 §2.3 global-admin routes: every approval, including those with no project. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/approvals')
export class FleetApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Every approval, newest first (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of FleetApprovalDto' })
  async list(@Query() raw: ListApprovalsQuery) {
    const { current, size, status, type, jobId } = parseQuery(ListApprovalsQuery, raw);
    return JsonResponse.Ok(toPageResult(await this.approvals.list(ADMIN, { status, type, jobId }, { current, size })));
  }

  @Get(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'One approval with re-queue candidates when pending (global admin)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  async get(@Param('id') id: string) {
    return JsonResponse.Ok(await this.approvals.get(ADMIN, id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Decide a pending approval (global admin)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 400, description: 'fleet.approvalDecisionInvalid, fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.approvalNotPending, fleet.budgetNotPaused' })
  async decide(@Param('id') id: string, @Body() dto: DecideApprovalDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.approvals.decide({ id: principal.id, globalAdmin: true }, ADMIN, id, dto));
  }
}
