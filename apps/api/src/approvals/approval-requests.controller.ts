import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, remapPage } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import type { PrincipalRef } from '../permissions/permissions.types';
import { ApprovalRequestQueries } from './approval-request.queries';
import { rethrowApprovalError } from './approval-http-errors';
import { ListApprovalRequestsQuery } from './dto/list-approval-requests.query';
import { ApprovalRequestDto, ApprovalRequestSummaryDto } from './dto/approval-request.dto';

const ref = (principal: KodaPrincipal): PrincipalRef => ({ type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id });

@ApiTags('approvals')
@ApiBearerAuth()
@ApiExtraModels(ApprovalRequestSummaryDto, ApprovalRequestDto)
@Controller('approvals')
export class ApprovalRequestsController {
  constructor(private readonly queries: ApprovalRequestQueries) {}

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
}
