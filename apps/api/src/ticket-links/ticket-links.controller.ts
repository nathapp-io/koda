import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
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
    @Param('slug') _slug: string,
    @Param('ref') _ref: string,
    @Body() _dto: CreateTicketLinkDto,
  ): Promise<JsonResponse<TicketLinkResponseDto>> {
    throw new Error('Not implemented');
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List all links for a ticket' })
  @ApiResponse({ status: 200, type: [TicketLinkResponseDto] })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async findAll(
    @Param('slug') _slug: string,
    @Param('ref') _ref: string,
  ): Promise<JsonResponse<TicketLinkResponseDto[]>> {
    throw new Error('Not implemented');
  }

  @Delete(':linkId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a ticket link by id' })
  @ApiResponse({ status: 204, description: 'Link deleted' })
  @ApiResponse({ status: 404, description: 'Link not found' })
  async remove(
    @Param('slug') _slug: string,
    @Param('ref') _ref: string,
    @Param('linkId') _linkId: string,
  ): Promise<void> {
    throw new Error('Not implemented');
  }
}
