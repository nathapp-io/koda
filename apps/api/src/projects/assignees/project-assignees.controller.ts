import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ProjectMembershipGuard } from '../project-membership.guard';
import { RequiresGuard } from '../../permissions/requires.guard';
import { Requires } from '../../permissions/requires.decorator';
import { CurrentProject } from '../current-project.decorator';
import { ProjectContext } from '../project-context';
import { ProjectAssigneesService } from './project-assignees.service';
import { AssigneeListDto } from './dto/assignee.dto';
import { AssigneeQuery } from './dto/assignee.query';

@ApiTags('projects')
@ApiBearerAuth()
// The path template's `slug` is resolved by the guard, not a `@Param`, so it is documented explicitly:
// without it the exported operation carried no `slug` parameter and could not be called by a client.
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' }, description: 'Project slug' })
@Controller('projects/:slug/assignees')
export class ProjectAssigneesController {
  constructor(private readonly assignees: ProjectAssigneesService) {}

  @Get()
  // US-007: `ProjectMembershipGuard` resolves the project and the caller's access first (403
  // `projects`, 404 for an unknown slug), then the key.
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('project.assignee.read')
  @ApiOperation({ summary: 'Search assignees of a project (any member, or a rostered agent)' })
  @ApiResponse({
    status: 200,
    description: 'Assignees: { items: [{ type, id, name, secondary, status? }] } — users first, then agents',
    type: AssigneeListDto,
  })
  @ApiResponse({ status: 400, description: 'q longer than 100 characters, or limit outside 1..50' })
  @ApiResponse({ status: 403, description: 'Not a project member, or project.assignee.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async search(@Query() rawQuery: AssigneeQuery, @CurrentProject() project: ProjectContext) {
    return JsonResponse.Ok(await this.assignees.search(project.project.id, AssigneeQuery.parse(rawQuery)));
  }
}
