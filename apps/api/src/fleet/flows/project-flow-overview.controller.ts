import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { FleetFlowOverviewDto } from './dto/fleet-flow-overview.dto';
import { FleetFlowOverviewService } from './fleet-flow-overview.service';

/**
 * The flow page's overview read: the repo, the ticket ref, the flow's jobs and the unknown-cost count.
 * It is its own controller so the flow detail route keeps answering the flow DTO alone.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/flows')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectFlowOverviewController {
  constructor(private readonly overviewService: FleetFlowOverviewService) {}

  @Get(':flowId/overview')
  @Requires('fleet.flow.read')
  @ApiOperation({ summary: 'Read the overview of a project flow (fleet.flow.read)' })
  @ApiResponse({ status: 200, type: FleetFlowOverviewDto })
  @ApiResponse({ status: 403, description: 'fleet.flow.read is missing' })
  @ApiResponse({ status: 404, description: 'fleet.flows.notFound' })
  async overview(@Param('flowId') flowId: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.overviewService.overview(ctx.project.id, flowId));
  }
}
