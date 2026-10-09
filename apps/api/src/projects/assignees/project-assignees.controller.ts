import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ProjectMembershipGuard } from '../project-membership.guard';
import { CurrentProject } from '../current-project.decorator';
import { ProjectContext } from '../project-context';
import { ProjectAssigneesService } from './project-assignees.service';
import { AssigneeListDto } from './dto/assignee.dto';
import { AssigneeQuery } from './dto/assignee.query';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/assignees')
@UseGuards(ProjectMembershipGuard)
export class ProjectAssigneesController {
  constructor(private readonly assignees: ProjectAssigneesService) {}

  @Get()
  @ApiOperation({ summary: 'Search assignees of a project (any member, or a rostered agent)' })
  @ApiResponse({
    status: 200,
    description: 'Assignees: { items: [{ type, id, name, secondary, status? }] } — users first, then agents',
    type: AssigneeListDto,
  })
  @ApiResponse({ status: 400, description: 'q longer than 100 characters, or limit outside 1..50' })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async search(@Query() rawQuery: AssigneeQuery, @CurrentProject() project: ProjectContext) {
    return JsonResponse.Ok(await this.assignees.search(project.project.id, AssigneeQuery.parse(rawQuery)));
  }
}
