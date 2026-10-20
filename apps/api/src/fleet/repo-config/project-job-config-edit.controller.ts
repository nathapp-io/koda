import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ConfigJobsService } from './config-jobs.service';
import { ConfigEditPayloadDto } from './dto/config-edit.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
// Permissions P1d (US-007): the route declares `ProjectMembershipGuard, RequiresGuard` in one
// `@UseGuards`, so the membership guard resolves `request.projectContext` before the key check.
export class ProjectJobConfigEditController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get(':id/config-edit')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.config.read')
  @ApiOperation({ summary: "A config job's full edit set, for Reopen edits (fleet.job.config.read)" })
  @ApiResponse({ status: 200, type: ConfigEditPayloadDto })
  @ApiResponse({ status: 403, description: 'fleet.job.config.read is missing' })
  @ApiResponse({ status: 404, description: 'No config job of this project with that id' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.configJobs.getEditSet(ctx.project.id, id));
  }
}
