import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ConfigJobsService } from './config-jobs.service';
import { ConfigEditPayloadDto } from './dto/config-edit.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class ProjectJobConfigEditController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get(':id/config-edit')
  @ApiOperation({ summary: "A config job's full edit set, for Reopen edits (project member)" })
  @ApiResponse({ status: 200, type: ConfigEditPayloadDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.configJobs.getEditSet(ctx.project.id, id));
  }
}
