import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  Res,
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
import { ProjectsService } from '../projects/projects.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

interface Reply {
  statusCode: number;
}

@ApiTags('ticket-links')
@ApiBearerAuth()
@Controller('projects/:slug/tickets/:ref/links')
export class TicketLinksController {
  constructor(
    private readonly ticketLinksService: TicketLinksService,
    private readonly projectsService: ProjectsService,
  ) {}

  private async assertMembership(slug: string, principal: KodaPrincipal): Promise<string> {
    const projectId = await this.projectsService.findProjectIdBySlug(slug);
    await this.projectsService.assertProjectMembership(projectId, principal);
    return projectId;
  }

  @Post()
  @ApiOperation({ summary: 'Create or return existing link for a ticket' })
  @ApiResponse({ status: 201, type: TicketLinkResponseDto })
  @ApiResponse({ status: 200, type: TicketLinkResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid URL' })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async create(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: CreateTicketLinkDto,
    @Principal() principal: KodaPrincipal,
    @Res({ passthrough: true }) res?: Reply,
  ) {
    await this.assertMembership(slug, principal);
    const result = await this.ticketLinksService.create(slug, ref, dto);
    if (res && result.status === 200) {
      res.statusCode = result.status;
    }
    return JsonResponse.Ok(result.link);
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List all links for a ticket' })
  @ApiResponse({ status: 200, type: [TicketLinkResponseDto] })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async findAll(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
  ) {
    await this.assertMembership(slug, principal);
    const links = await this.ticketLinksService.findByTicket(slug, ref);
    return JsonResponse.Ok(links);
  }

  @Delete(':linkId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a ticket link by id' })
  @ApiResponse({ status: 204, description: 'Link deleted' })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  @ApiResponse({ status: 404, description: 'Link not found' })
  async remove(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Param('linkId') linkId: string,
    @Principal() principal: KodaPrincipal,
  ): Promise<void> {
    await this.assertMembership(slug, principal);
    await this.ticketLinksService.remove(slug, ref, linkId);
  }
}
