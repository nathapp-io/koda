import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { KodaPageQuery, parseQuery, remapPage, toPageResult } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import { FleetFlowDto, FleetFlowPageDto } from './dto/fleet-flow.dto';
import { FleetFlowsService } from './fleet-flows.service';
import { FLOW_ANSWER_VARIANT, FLOW_STOP_VARIANT } from './flow-route.commands';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/flows')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectFlowsController {
  constructor(private readonly flows: FleetFlowsService, private readonly routeGate: ApprovalRouteGate) {}

  @Get()
  @Requires('fleet.flow.read')
  @ApiOperation({ summary: 'List project flows newest first (fleet.flow.read)' })
  @ApiResponse({ status: 200, type: FleetFlowPageDto })
  @ApiResponse({ status: 403, description: 'fleet.flow.read is missing' })
  async list(@Query() rawQuery: KodaPageQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size } = parseQuery(KodaPageQuery, rawQuery);
    const page = await this.flows.list(ctx.project.id, { current, size });
    return JsonResponse.Ok(toPageResult(remapPage(page, (flow) => FleetFlowDto.from(flow, ctx.project.slug))));
  }

  @Get(':flowId')
  @Requires('fleet.flow.read')
  @ApiOperation({ summary: 'Read a project flow (fleet.flow.read)' })
  @ApiResponse({ status: 200, type: FleetFlowDto })
  @ApiResponse({ status: 403, description: 'fleet.flow.read is missing' })
  @ApiResponse({ status: 404, description: 'fleet.flows.notFound' })
  async get(@Param('flowId') flowId: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(FleetFlowDto.from(await this.flows.get(ctx.project.id, flowId), ctx.project.slug));
  }

  @Post(':flowId/stop')
  @HttpCode(200)
  @Requires('fleet.flow.stop')
  @ApprovalGated()
  @ApiOperation({ summary: 'Stop a fleet flow (fleet.flow.stop)' })
  @ApiResponse({ status: 200, type: FleetFlowDto })
  @ApiResponse({ status: 202, description: 'Approval request for fleet.flow.stop' })
  @ApiResponse({ status: 403, description: 'fleet.flow.stop is missing' })
  @ApiResponse({ status: 404, description: 'fleet.flows.notFound' })
  @ApiResponse({ status: 409, description: 'fleet.flows.notStoppable' })
  async stop(@Param('flowId') flowId: string, @CurrentProject() ctx: ProjectContext) {
    // Existence/project fence also applies when a policy asks instead of executing immediately.
    await this.flows.get(ctx.project.id, flowId);
    const outcome = await this.routeGate.run<FleetFlowRecord>({
      key: 'fleet.flow.stop', variant: FLOW_STOP_VARIANT, projectId: ctx.project.id,
      input: { projectId: ctx.project.id, flowId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(FleetFlowDto.from(outcome.result, ctx.project.slug));
  }

  @Post(':flowId/answers')
  @HttpCode(200)
  @Requires('fleet.flow.answer')
  @ApprovalGated()
  @ApiOperation({ summary: 'Answer a fleet flow review (fleet.flow.answer)' })
  @ApiBody({ schema: { type: 'object', required: ['jobId', 'answers'], properties: {
    jobId: { type: 'string', description: 'The review job the questions belong to' },
    answers: { type: 'array', description: 'One answer per question of that review',
      items: { type: 'object', required: ['id', 'answer'], properties: { id: { type: 'string' }, answer: { type: 'string' } } } },
  } } })
  @ApiResponse({ status: 200, type: FleetFlowDto })
  @ApiResponse({ status: 202, description: 'Approval request for fleet.flow.answer' })
  @ApiResponse({ status: 400, description: 'fleet.flows.answersInput' })
  @ApiResponse({ status: 403, description: 'Only a USER may answer, or fleet.flow.answer is missing' })
  @ApiResponse({ status: 404, description: 'fleet.flows.notFound' })
  @ApiResponse({ status: 409, description: 'fleet.flows.notWaiting or fleet.flows.answersStale' })
  async answer(
    @Param('flowId') flowId: string,
    @Body() body: unknown,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ) {
    // The human check runs before the approval gate: an agent never opens an approval request it
    // could not execute, and the route command repeats the check as its backstop.
    assertHuman(principal);
    // Existence/project fence also applies when a policy asks instead of executing immediately.
    await this.flows.get(ctx.project.id, flowId);
    const outcome = await this.routeGate.run<FleetFlowRecord>({
      key: 'fleet.flow.answer', variant: FLOW_ANSWER_VARIANT, projectId: ctx.project.id,
      input: { projectId: ctx.project.id, flowId, body },
      // The answers resume the flow, so a policy that asks for them opens a request even for the
      // human who asked: the policy decides whether the answers may be recorded at all.
      askEvenForHumans: true,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(FleetFlowDto.from(outcome.result, ctx.project.slug));
  }
}

/** Only a user answers a flow's questions; an agent is refused before the gate. */
function assertHuman(principal: KodaPrincipal): void {
  if (principal.actorType !== 'user') throw new ForbiddenAppException({}, 'fleet.flows.answerHumanOnly');
}
