import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetReposService } from './fleet-repos.service';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';

/** Permissions P1d (US-004): `fleet.repo.read` replaces the bare membership guard. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/repos')
export class ProjectFleetReposController {
  constructor(private readonly repos: FleetReposService) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.repo.read')
  @ApiOperation({ summary: "The project's fleet repos (fleet.repo.read)" })
  @ApiResponse({ status: 200, description: 'Page of FleetRepoDto' })
  @ApiResponse({ status: 403, description: 'fleet.repo.read is missing' })
  async list(@Query() rawQuery: ListFleetReposQuery, @CurrentProject() project: ProjectContext) {
    const { current, size } = parseQuery(ListFleetReposQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.repos.list({ projectId: project.project.id }, { current, size })));
  }
}
