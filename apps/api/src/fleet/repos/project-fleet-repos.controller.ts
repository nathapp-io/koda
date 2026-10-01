import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { FleetReposService } from './fleet-repos.service';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/repos')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetReposController {
  constructor(private readonly repos: FleetReposService) {}

  @Get()
  @ApiOperation({ summary: "The project's fleet repos (project member)" })
  @ApiResponse({ status: 200, description: 'Page of FleetRepoDto' })
  async list(@Query() rawQuery: ListFleetReposQuery, @CurrentProject() project: ProjectContext) {
    const { current, size } = parseQuery(ListFleetReposQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.repos.list({ projectId: project.project.id }, { current, size })));
  }
}
