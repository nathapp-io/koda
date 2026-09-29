import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetActivityService } from './fleet-activity.service';
import { ListFleetActivityQuery } from './dto/list-fleet-activity.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/activity')
export class FleetActivityController {
  constructor(private readonly activity: FleetActivityService) {}

  @Get()
  @ApiOperation({ summary: 'List fleet activity: global admin sees all, members see their projects\' job rows' })
  @ApiResponse({ status: 200, description: 'Page of FleetActivityDto' })
  @ApiResponse({ status: 403, description: 'Not a user' })
  async list(@Query() rawQuery: ListFleetActivityQuery, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    const { current, size, entityType, entityId, actorId, jobId } = parseQuery(ListFleetActivityQuery, rawQuery);
    const projectIds = principal.role === 'ADMIN' ? undefined : await this.activity.memberProjectIds(principal.id);
    return JsonResponse.Ok(toPageResult(await this.activity.list({ entityType, entityId, actorId, jobId, projectIds }, { current, size })));
  }
}
