import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetDashboardService } from './dashboard.service';
import { AttentionReasonDto, FleetDashboardDto, RunnerConditionDto } from './dto/fleet-dashboard.dto';

/**
 * Fleet S2b (c) §1.1, §1.5: the project's jobs, every runner without credential or version detail.
 *
 * Permissions P1d (US-004): the route declares `fleet.dashboard.read`, which replaced the user-only
 * refusal — a rostered agent reads the dashboard like a user.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(AttentionReasonDto, RunnerConditionDto)
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/dashboard')
export class ProjectFleetDashboardController {
  constructor(private readonly dashboard: FleetDashboardService) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.dashboard.read')
  @ApiOperation({ summary: "The project's fleet health: its jobs, runner health, attention items (fleet.dashboard.read)" })
  @ApiResponse({ status: 200, type: FleetDashboardDto })
  @ApiResponse({ status: 403, description: 'fleet.dashboard.read is missing' })
  async get(@CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.dashboard.snapshot({ kind: 'project', projectId: ctx.project.id }, new Date()));
  }
}
