import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, remapPage } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import type { PrincipalRef } from '../permissions/permissions.types';
import { ApprovalRequestQueries } from './approval-request.queries';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalRouteGate } from './route/approval-route-gate';
import { ApprovalPending } from './route/approval-pending';
import { ApprovalGated } from './route/approval-gated.decorator';
import { APPROVAL_ROUTE_VARIANTS } from './approval-route.commands';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { DecideApprovalRequestDto } from './dto/decide-approval-request.dto';
import { rethrowApprovalError } from './approval-http-errors';
import { ListApprovalRequestsQuery } from './dto/list-approval-requests.query';
import { ApprovalRequestDto, ApprovalRequestSummaryDto } from './dto/approval-request.dto';
import { ApprovalRequestCountsDto } from './dto/approval-request-counts.dto';

const ref = (principal: KodaPrincipal): PrincipalRef => ({ type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id });

@ApiTags('approvals')
@ApiBearerAuth()
@ApiExtraModels(ApprovalRequestSummaryDto, ApprovalRequestDto, ApprovalRequestCountsDto)
@Controller('approvals')
export class ApprovalRequestsController {
  constructor(
    private readonly queries: ApprovalRequestQueries,
    private readonly decisions: ApprovalDecisionService,
    private readonly routeGate: ApprovalRouteGate,
    private readonly execution: ApprovalExecutionService,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('approval.decide', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'List visible approval requests' })
  @ApiResponse({ status: 200, description: 'Page of approval request summaries', schema: {
    type: 'object', required: ['ret', 'data'], properties: {
      ret: { type: 'number' },
      data: {
        type: 'object', required: ['total', 'current', 'size', 'hasNext', 'hasPrev', 'records'], properties: {
          total: { type: 'number' }, current: { type: 'number' }, size: { type: 'number' },
          hasNext: { type: 'boolean' }, hasPrev: { type: 'boolean' },
          records: { type: 'array', items: { $ref: getSchemaPath(ApprovalRequestSummaryDto) } },
        },
      },
    },
  } })
  @ApiResponse({ status: 400, description: 'Invalid list query' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  async list(@Principal() principal: KodaPrincipal, @Query() rawQuery: ListApprovalRequestsQuery) {
    try {
      const { current, size, ...filter } = parseQuery(ListApprovalRequestsQuery, rawQuery);
      return JsonResponse.Ok(remapPage(await this.queries.list(ref(principal), filter, { current, size }), ApprovalRequestSummaryDto.from));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Get('counts')
  @UseGuards(RequiresGuard)
  @Requires('approval.decide', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Count visible pending approval requests' })
  @ApiResponse({ status: 200, description: 'Pending counts by project and unscoped', schema: {
    type: 'object', required: ['ret', 'data'], properties: {
      ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalRequestCountsDto) },
    },
  } })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  async counts(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok<ApprovalRequestCountsDto>(await this.queries.counts(ref(principal)));
  }

  @Get(':id')
  @UseGuards(RequiresGuard)
  @Requires('approval.decide', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Read a visible approval request and its decisions' })
  @ApiResponse({ status: 200, description: 'Approval request with frozen input, result and decisions', schema: {
    type: 'object', required: ['ret', 'data'], properties: {
      ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalRequestDto) },
    },
  } })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 404, description: 'Approval request missing or invisible' })
  async get(@Principal() principal: KodaPrincipal, @Param('id') id: string) {
    try { return JsonResponse.Ok(ApprovalRequestDto.from(await this.queries.get(ref(principal), id))); }
    catch (error) { rethrowApprovalError(error); }
  }

  @Post(':id/decisions')
  @ApprovalGated()
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('approval.decide', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Decide a visible approval request' })
  @ApiResponse({ status: 200, description: 'Approval request with its current decisions', schema: {
    type: 'object', required: ['ret', 'data'], properties: {
      ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalRequestDto) },
    },
  } })
  @ApiResponse({ status: 400, description: 'Invalid decision body' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'The principal cannot decide this request' })
  @ApiResponse({ status: 404, description: 'Approval request missing or invisible' })
  @ApiResponse({ status: 409, description: 'Request is not pending or has expired' })
  async decide(@Principal() principal: KodaPrincipal, @Param('id') id: string, @Body() dto: DecideApprovalRequestDto) {
    try {
      const visible = await this.queries.get(ref(principal), id);
      await this.decisions.assertMayDecide(id);
      const outcome = await this.routeGate.run<ApprovalRequestRecord>({
        key: 'approval.decide', variant: APPROVAL_ROUTE_VARIANTS.decide, projectId: visible.request.projectId,
        input: { requestId: id, decision: dto.decision, comment: dto.comment ?? null, params: dto.params }, keyCheck: false,
      });
      if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
      const request = dto.decision === 'approve' ? await this.execution.execute(id) : outcome.result;
      return JsonResponse.Ok(ApprovalRequestDto.from({ request, decisions: await this.queries.decisionsFor(request.id) }));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('approval.request.cancel')
  @ApiOperation({ summary: 'Cancel your own pending approval request' })
  @ApiResponse({ status: 200, description: 'Cancelled approval request with its decisions', schema: {
    type: 'object', required: ['ret', 'data'], properties: {
      ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalRequestDto) },
    },
  } })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Only the requester may cancel' })
  @ApiResponse({ status: 404, description: 'Approval request missing or invisible' })
  @ApiResponse({ status: 409, description: 'Request is not pending' })
  async cancel(@Principal() principal: KodaPrincipal, @Param('id') id: string) {
    try {
      await this.queries.get(ref(principal), id);
      const request = await this.decisions.cancel(id);
      return JsonResponse.Ok(ApprovalRequestDto.from({ request, decisions: await this.queries.decisionsFor(request.id) }));
    } catch (error) { rethrowApprovalError(error); }
  }
}
