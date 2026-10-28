import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectContext } from '../projects/project-context';
import { TICKET_LINK_ROUTE_VARIANTS } from './ticket-link-route.commands';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { CreateTicketLinkResult } from './ticket-links.service';
import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

interface Reply {
  statusCode: number;
}

@ApiTags('ticket-links')
@ApiBearerAuth()
@Controller('projects/:slug/tickets/:ref/links')
export class TicketLinksController {
  constructor(private readonly ticketLinksService: TicketLinksService, private readonly routeGate: ApprovalRouteGate) {}

  @Post()
  // US-006: `ProjectMembershipGuard` runs first (403 `projects` for a non-member), then the key.
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.link.add')
  @ApprovalGated()
  @ApiOperation({ summary: 'Create or return existing link for a ticket' })
  @ApiResponse({ status: 201, type: TicketLinkResponseDto })
  @ApiResponse({ status: 200, type: TicketLinkResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid URL' })
  @ApiResponse({ status: 403, description: 'Not a project member, or ticket.link.add is missing' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async create(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: CreateTicketLinkDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
    @Res({ passthrough: true }) res?: Reply,
  ) {
    const outcome = await this.routeGate.run<CreateTicketLinkResult>({
      key: 'ticket.link.add', variant: TICKET_LINK_ROUTE_VARIANTS.add,
      projectId: project.project.id, input: { slug, ref, link: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    const result = outcome.result;
    if (res && result.status === 200) {
      res.statusCode = result.status;
    }
    return JsonResponse.Ok(result.link);
  }

  @Get()
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.link.read')
  @ApiOperation({ summary: 'List all links for a ticket' })
  @ApiResponse({ status: 200, type: [TicketLinkResponseDto] })
  @ApiResponse({ status: 403, description: 'Not a project member, or ticket.link.read is missing' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async findAll(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
  ) {
    const links = await this.ticketLinksService.findByTicket(slug, ref);
    return JsonResponse.Ok(links);
  }

  @Delete(':linkId')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  // The gate checks key possession first; row ownership is checked at command execution.
  @Requires('ticket.link.remove', { enforcedBy: 'service' })
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete a ticket link by id' })
  @ApiResponse({ status: 204, description: 'Link deleted' })
  @ApiResponse({ status: 403, description: "Not a project member, or ticket.link.remove is missing (or it is someone else's link and only .own is held)" })
  @ApiResponse({ status: 404, description: 'Link not found' })
  async remove(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Param('linkId') linkId: string,
    @CurrentProject() project: ProjectContext,
  ): Promise<void> {
    const outcome = await this.routeGate.run({
      key: 'ticket.link.remove', variant: TICKET_LINK_ROUTE_VARIANTS.remove,
      projectId: project.project.id, input: { slug, ref, linkId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
