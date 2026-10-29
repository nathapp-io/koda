import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { TICKET_FLEET_JOB_ROUTE_VARIANTS } from './ticket-fleet-job-route.commands';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { TicketFleetJobDto } from './dto/ticket-fleet-job.dto';
import { FleetTicketsService } from './fleet-tickets.service';

/** Fleet C9 §2.2-§2.3: a ticket's fleet jobs. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@ApiParam({ name: 'ref', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/tickets/:ref/fleet-jobs')
// Permissions P1d (US-003): each route declares `ProjectMembershipGuard, RequiresGuard` in one
// `@UseGuards`, so the membership guard resolves `request.projectContext` before the key check.
export class TicketFleetJobsController {
  constructor(
    private readonly service: FleetTicketsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.ticket-job.read')
  @ApiOperation({ summary: 'Fleet jobs linked to a ticket, newest first, at most 50 (fleet.ticket-job.read)' })
  @ApiResponse({ status: 200, type: [TicketFleetJobDto] })
  @ApiResponse({ status: 403, description: 'fleet.ticket-job.read is missing' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async list(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.service.listForTicket(ctx.project.id, ref));
  }

  @Delete(':jobId')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.ticket-job.unlink')
  @ApprovalGated()
  @ApiOperation({ summary: 'Unlink a fleet job from a ticket (fleet.ticket-job.unlink); the PR and history stay' })
  @ApiResponse({ status: 204, description: 'Unlinked' })
  @ApiResponse({ status: 403, description: 'fleet.ticket-job.unlink is missing' })
  @ApiResponse({ status: 404, description: 'Ticket not found, or the job is not linked to it' })
  async unlink(@Param('ref') ref: string, @Param('jobId') jobId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    const outcome = await this.routeGate.run({
      key: 'fleet.ticket-job.unlink', variant: TICKET_FLEET_JOB_ROUTE_VARIANTS.unlink, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, ref, jobId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
  }
}
