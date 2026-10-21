import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ApprovalRoute, ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { ListApprovalsQuery } from './dto/list-approvals.query';

const ADMIN: ApprovalRoute = { kind: 'admin' };

/**
 * S1.5 §2.3 global routes, migrated onto permission keys by permissions P1d (US-006): every approval,
 * including those with no project, for a caller with a global `fleet.approval.read` grant — which is
 * what `@RequiredPermission('ADMIN')` meant here. The decide route guards that read key and then lets
 * `ApprovalsService.decide` check its approval type's key, so only a global grant reaches the handler
 * and the type still decides the rest.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/approvals')
export class FleetApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.approval.read')
  @ApiOperation({ summary: 'Every approval, newest first (fleet.approval.read, global)' })
  @ApiResponse({ status: 200, description: 'Page of FleetApprovalDto' })
  @ApiResponse({ status: 403, description: 'fleet.approval.read is missing globally' })
  async list(@Query() raw: ListApprovalsQuery) {
    const { current, size, status, type, jobId } = parseQuery(ListApprovalsQuery, raw);
    return JsonResponse.Ok(toPageResult(await this.approvals.list(ADMIN, { status, type, jobId }, { current, size })));
  }

  @Get(':id')
  @UseGuards(RequiresGuard)
  @Requires('fleet.approval.read')
  @ApiOperation({ summary: 'One approval with re-queue candidates when pending (fleet.approval.read, global)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 403, description: 'fleet.approval.read is missing globally' })
  @ApiResponse({ status: 404, description: 'fleet.approvals: no such approval' })
  async get(@Param('id') id: string) {
    return JsonResponse.Ok(await this.approvals.get(ADMIN, id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('fleet.approval.read')
  @ApiOperation({ summary: 'Decide a pending approval (fleet.approval.read globally, then the key of its type)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 400, description: 'fleet.approvalDecisionInvalid, fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 403, description: "fleet.approval.read globally, the type's decide key, or threads.notCreator" })
  @ApiResponse({ status: 404, description: 'fleet.approvals: no such approval' })
  @ApiResponse({ status: 409, description: 'fleet.approvalNotPending, fleet.budgetNotPaused' })
  async decide(@Param('id') id: string, @Body() dto: DecideApprovalDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.approvals.decide({ id: principal.id, principal }, ADMIN, id, dto));
  }
}
