import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRedeemHeader } from '../../approvals/route/approval-redeem-header.decorator';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Principal } from '@nathapp/nestjs-auth';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { THREAD_PREAPPROVAL_ROUTE_VARIANTS } from './flow-route.commands';
import type { ThreadPreApproval } from '../threads/domain/chat-thread.domain';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/threads/:id/preapproval')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ThreadPreApprovalController {
  constructor(private readonly routeGate: ApprovalRouteGate) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @Requires('fleet.thread.preapprove')
  @ApprovalGated()
  @ApiOperation({ summary: 'Set the human advance approval and cost cap for a thread flow' })
  @ApiBody({ schema: { type: 'object', required: ['costCapUsd'], properties: { costCapUsd: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 1000, multipleOf: 0.0001 } } } })
  @ApiResponse({ status: 200, description: 'The thread pre-approval' })
  @ApiResponse({ status: 400, description: 'costCapUsd must be greater than 0, at most 1000, and have at most four decimal places' })
  @ApiResponse({ status: 403, description: 'Only a USER may set a pre-approval or the permission is missing' })
  async set(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentProject() project: ProjectContext,
    @Principal() principal: KodaPrincipal,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    assertHuman(principal);
    const outcome = await this.routeGate.run<ThreadPreApproval>({
      key: 'fleet.thread.preapprove', variant: THREAD_PREAPPROVAL_ROUTE_VARIANTS.set,
      projectId: project.project.id, input: { projectId: project.project.id, threadId: id, costCapUsd: readCostCap(body) }, redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @Requires('fleet.thread.preapprove')
  @ApprovalGated()
  @ApiOperation({ summary: 'Clear the human advance approval for a thread flow' })
  @ApiResponse({ status: 200, description: 'Pre-approval cleared, including when it was already empty' })
  @ApiResponse({ status: 403, description: 'Only a USER may clear a pre-approval or the permission is missing' })
  async clear(
    @Param('id') id: string,
    @CurrentProject() project: ProjectContext,
    @Principal() principal: KodaPrincipal,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    assertHuman(principal);
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.thread.preapprove', variant: THREAD_PREAPPROVAL_ROUTE_VARIANTS.clear,
      projectId: project.project.id, input: { projectId: project.project.id, threadId: id }, redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({ cleared: true });
  }
}

function readCostCap(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>).costCapUsd;
}

function assertHuman(principal: KodaPrincipal): void {
  if (principal.actorType !== 'user') throw new ForbiddenAppException({}, 'fleet.flows.humanOnly');
}
