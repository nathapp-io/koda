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
import { JsonResponse } from '@nathapp/nestjs-common';
import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';

interface Reply {
  statusCode: number;
}

@ApiTags('ticket-links')
@ApiBearerAuth()
@Controller('projects/:slug/tickets/:ref/links')
export class TicketLinksController {
  constructor(private readonly ticketLinksService: TicketLinksService) {}

  @Post()
  @ApiOperation({ summary: 'Create or return existing link for a ticket' })
  @ApiResponse({ status: 201, type: TicketLinkResponseDto })
  @ApiResponse({ status: 200, type: TicketLinkResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid URL' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async create(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: CreateTicketLinkDto,
    @Res({ passthrough: true }) res?: Reply,
  ) {
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
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async findAll(@Param('slug') slug: string, @Param('ref') ref: string) {
    const links = await this.ticketLinksService.findByTicket(slug, ref);
    return JsonResponse.Ok(links);
  }

  @Delete(':linkId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a ticket link by id' })
  @ApiResponse({ status: 204, description: 'Link deleted' })
  @ApiResponse({ status: 404, description: 'Link not found' })
  async remove(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    await this.ticketLinksService.remove(slug, ref, linkId);
  }
}
