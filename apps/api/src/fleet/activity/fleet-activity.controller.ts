import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetActivityService } from './fleet-activity.service';
import { ListFleetActivityQuery } from './dto/list-fleet-activity.query';

/**
 * S1 slice 2 activity feed, migrated onto permission keys by permissions P1d (US-008): the feed is
 * filtered by the key instead of by membership. `projectIdsWithKey` answers `{ all: true }` for a
 * global `fleet.activity.read` grant (the global admin view, project-less rows included) and
 * otherwise exactly the projects where the caller holds it, so an agent rostered in a project reads
 * that project's rows and a runner reads nothing.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/activity')
export class FleetActivityController {
  constructor(
    private readonly activity: FleetActivityService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  // `projectIdsWithKey` answers the key (it filters the rows), so the guard only records it.
  @Requires('fleet.activity.read', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Fleet activity rows of the projects where the caller holds fleet.activity.read' })
  @ApiResponse({ status: 200, description: 'Page of FleetActivityDto; every project when the key is held globally' })
  async list(@Query() rawQuery: ListFleetActivityQuery, @Principal() principal: KodaPrincipal) {
    const { current, size, entityType, entityId, actorId, jobId } = parseQuery(ListFleetActivityQuery, rawQuery);
    const scope = await this.permissions.projectIdsWithKey(principal, 'fleet.activity.read');
    // `undefined` is the unscoped listing. An empty array must reach the repository as `[]` — which
    // matches no row — so a caller with no grant never picks up the project-less rows. (`in`, not
    // `scope.all ? ...`: this app compiles with `strictNullChecks: false`, which does not narrow the
    // union on its boolean discriminant.)
    const projectIds = 'projectIds' in scope ? scope.projectIds : undefined;
    return JsonResponse.Ok(toPageResult(await this.activity.list({ entityType, entityId, actorId, jobId, projectIds }, { current, size })));
  }
}
