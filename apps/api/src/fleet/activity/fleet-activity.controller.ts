import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { FleetActivityService } from './fleet-activity.service';
import { ListFleetActivityQuery } from './dto/list-fleet-activity.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/activity')
export class FleetActivityController {
  constructor(private readonly activity: FleetActivityService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List fleet activity (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of FleetActivityDto: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 403, description: 'Global admin role required' })
  async list(@Query() rawQuery: ListFleetActivityQuery) {
    const { current, size, entityType, entityId, actorId } = parseQuery(ListFleetActivityQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.activity.list({ entityType, entityId, actorId }, { current, size })));
  }
}
