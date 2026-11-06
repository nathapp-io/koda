import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { FleetFlowDto } from './dto/fleet-flow.dto';
import { THREAD_FLOW_CREATE_VARIANT } from './flow-route.commands';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/threads/:id/flows')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ThreadFlowsController {
  constructor(private readonly routeGate: ApprovalRouteGate) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Requires('fleet.flow.create')
  @ApprovalGated()
  @ApiOperation({ summary: 'Create a fleet flow from a published repository thread (fleet.flow.create)' })
  @ApiBody({ schema: { type: 'object', required: ['features', 'roles', 'costCapUsd'], properties: { features: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['feature', 'specPath'], properties: { feature: { type: 'string' }, specPath: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } } } } }, roles: { type: 'object', required: ['reviewer', 'supervisor'], properties: { reviewer: { type: 'string' }, supervisor: { type: 'string' } } }, costCapUsd: { oneOf: [{ type: 'number' }, { type: 'string' }] } } } })
  @ApiResponse({ status: 201, type: FleetFlowDto })
  @ApiResponse({ status: 202, description: 'Approval request for fleet.flow.create' })
  @ApiResponse({ status: 400, description: 'Invalid flow input' })
  @ApiResponse({ status: 403, description: 'fleet.flow.create is missing' })
  @ApiResponse({ status: 404, description: 'threads.notFound' })
  @ApiResponse({ status: 409, description: 'Thread is not eligible for a flow' })
  async create(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<Awaited<ReturnType<import('./fleet-flows.service').FleetFlowsService['create']>>>({
      key: 'fleet.flow.create', variant: THREAD_FLOW_CREATE_VARIANT, projectId: project.project.id,
      input: { projectId: project.project.id, threadId: id, body },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(FleetFlowDto.from(outcome.result.flow, project.project.slug));
  }
}
