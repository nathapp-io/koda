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
import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';
import type { PrincipalRef } from '../permissions/permissions.types';
import { isAgentPrincipal, isUserPrincipal, type KodaPrincipal } from '../auth/principal/koda-principal.types';

interface Reply {
  statusCode: number;
}

/**
 * The creator recorded on a new link, as `TicketLinksService.create` takes it.
 *
 * A runner never reaches a ticket route (`CombinedAuthGuard` refuses it), and `undefined` makes the
 * service store a creatorless link rather than writing a half-typed reference.
 */
function creatorRef(principal: KodaPrincipal): PrincipalRef | undefined {
  if (isUserPrincipal(principal)) return { type: 'USER', id: principal.id };
  if (isAgentPrincipal(principal)) return { type: 'AGENT', id: principal.id };
  return undefined;
}

@ApiTags('ticket-links')
@ApiBearerAuth()
@Controller('projects/:slug/tickets/:ref/links')
export class TicketLinksController {
  constructor(private readonly ticketLinksService: TicketLinksService) {}

  @Post()
  // US-006: `ProjectMembershipGuard` runs first (403 `projects` for a non-member), then the key.
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.link.add')
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
    @Res({ passthrough: true }) res?: Reply,
  ) {
    const result = await this.ticketLinksService.create(slug, ref, dto, creatorRef(principal));
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
  // US-006: the row's creator is only known after the link lookup, so `TicketLinksService.remove`
  // makes the check — and an unknown link stays a 404 `ticket-links` instead of a 403.
  @Requires('ticket.link.remove', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Delete a ticket link by id' })
  @ApiResponse({ status: 204, description: 'Link deleted' })
  @ApiResponse({ status: 403, description: "Not a project member, or ticket.link.remove is missing (or it is someone else's link and only .own is held)" })
  @ApiResponse({ status: 404, description: 'Link not found' })
  async remove(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Param('linkId') linkId: string,
    @Principal() principal: KodaPrincipal,
  ): Promise<void> {
    await this.ticketLinksService.remove(slug, ref, linkId, principal);
  }
}
