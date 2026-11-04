import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { CreateRulingDto } from './dto/create-ruling.dto';
import { FleetPrRulingDto } from './dto/fleet-pr-ruling.dto';
import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import { FLEET_RULING_ROUTE_VARIANTS } from './fleet-ruling-route.commands';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs/:id/rulings')
export class FleetRulingsController {
  constructor(private readonly rulings: FleetPrRulingsService, private readonly gate: ApprovalRouteGate) {}

  @Post()
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.rule')
  @ApprovalGated()
  @ApiOperation({ summary: 'Rule on an open draft RUN item (fleet.job.rule)' })
  @ApiResponse({ status: 201, type: FleetPrRulingDto })
  @ApiResponse({ status: 202, description: 'Awaiting approval' })
  @ApiResponse({ status: 400, description: 'Invalid ruling text or item id' })
  @ApiResponse({ status: 403, description: 'fleet.job.rule is missing' })
  @ApiResponse({ status: 404, description: 'Job or item not found' })
  @ApiResponse({ status: 409, description: 'Not a latest draft RUN, or item already applied' })
  async create(@Param('id') jobId: string, @CurrentProject() ctx: ProjectContext, @Body() ruling: CreateRulingDto) {
    const { id: projectId, slug } = ctx.project;
    await this.rulings.ruleTarget(projectId, jobId, ruling);
    const outcome = await this.gate.run<FleetPrRulingDto>({ key: 'fleet.job.rule', variant: FLEET_RULING_ROUTE_VARIANTS.create, projectId, input: { slug, projectId, jobId, ruling } });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.read')
  @ApiOperation({ summary: 'List all rulings of a RUN, newest first (fleet.job.read)' })
  @ApiResponse({ status: 200, type: [FleetPrRulingDto] })
  @ApiResponse({ status: 403, description: 'fleet.job.read is missing' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async list(@Param('id') jobId: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok((await this.rulings.list(ctx.project.id, jobId)).map(FleetPrRulingDto.from));
  }
}
