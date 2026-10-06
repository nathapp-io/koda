import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
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
@UseGuards(ProjectMembershipGuard)
export class TicketFleetJobsController {
  constructor(private readonly service: FleetTicketsService) {}

  @Get()
  @ApiOperation({ summary: 'Fleet jobs linked to a ticket, newest first, at most 50 (project member)' })
  @ApiResponse({ status: 200, type: [TicketFleetJobDto] })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async list(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.service.listForTicket(ctx.project.id, ref));
  }

  @Delete(':jobId')
  @HttpCode(204)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Unlink a fleet job from a ticket (project DEVELOPER+); the PR and history stay' })
  @ApiResponse({ status: 204, description: 'Unlinked' })
  @ApiResponse({ status: 404, description: 'Ticket not found, or the job is not linked to it' })
  async unlink(@Param('ref') ref: string, @Param('jobId') jobId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    await this.service.unlink(ctx.project.id, ref, jobId, principal.id);
  }
}
