import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { FleetDashboardService } from './dashboard.service';
import { AttentionReasonDto, FleetDashboardDto, RunnerConditionDto } from './dto/fleet-dashboard.dto';

/** The dashboard is for people; agent keys get 403, like the analytics and jobs controllers. */
function assertUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/** Fleet S2b (c) §1.1, §1.5: the project's jobs, every runner without credential or version detail (project member). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(AttentionReasonDto, RunnerConditionDto)
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/dashboard')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetDashboardController {
  constructor(private readonly dashboard: FleetDashboardService) {}

  @Get()
  @ApiOperation({ summary: "The project's fleet health: its jobs, runner health, attention items (project member)" })
  @ApiResponse({ status: 200, type: FleetDashboardDto })
  async get(@CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.dashboard.snapshot({ kind: 'project', projectId: ctx.project.id }, new Date()));
  }
}
