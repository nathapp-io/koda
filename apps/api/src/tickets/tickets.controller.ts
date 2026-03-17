import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { TicketType, TicketStatus, Priority } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestWithUser = any & { user?: any; agent?: any };

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('projects/:slug/tickets')
export class TicketsController {
  constructor(private ticketsService: TicketsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new ticket' })
  @ApiResponse({ status: 201, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async create(
    @Param('slug') slug: string,
    @Body() createTicketDto: CreateTicketDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType = req.user ? 'user' : 'agent';

    return this.ticketsService.create(slug, createTicketDto, currentUser, actorType);
  }

  @Get()
  @ApiOperation({ summary: 'List all tickets for a project' })
  @ApiResponse({ status: 200, description: 'List of tickets' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiQuery({ name: 'status', enum: TicketStatus, required: false })
  @ApiQuery({ name: 'type', enum: TicketType, required: false })
  @ApiQuery({ name: 'priority', enum: Priority, required: false })
  @ApiQuery({ name: 'assignedTo', required: false, description: 'User ID to filter by' })
  @ApiQuery({ name: 'unassigned', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  async findAll(
    @Param('slug') slug: string,
    @Query() query: Record<string, any>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = {};

    if (query.status !== undefined) filters.status = query.status;
    if (query.type !== undefined) filters.type = query.type;
    if (query.priority !== undefined) filters.priority = query.priority;
    if (query.assignedTo !== undefined) filters.assignedTo = query.assignedTo;
    if (query.unassigned !== undefined) filters.unassigned = query.unassigned === 'true' || query.unassigned === true;
    if (query.limit !== undefined) filters.limit = parseInt(query.limit, 10);
    if (query.page !== undefined) filters.page = parseInt(query.page, 10);

    return this.ticketsService.findAll(slug, filters);
  }

  @Get(':ref')
  @ApiOperation({ summary: 'Get a ticket by reference (KODA-42 or CUID)' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async findByRef(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
  ) {
    return this.ticketsService.findByRef(slug, ref);
  }

  @Patch(':ref')
  @ApiOperation({ summary: 'Update a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async update(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() updateTicketDto: UpdateTicketDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType = req.user ? 'user' : 'agent';

    return this.ticketsService.update(slug, ref, updateTicketDto, currentUser, actorType);
  }

  @Delete(':ref')
  @ApiOperation({ summary: 'Soft delete a ticket (admin only)' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async softDelete(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType = req.user ? 'user' : 'agent';

    return this.ticketsService.softDelete(slug, ref, currentUser, actorType);
  }

  @Post(':ref/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign or unassign a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot assign to both user and agent' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async assign(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() assignInput: Record<string, any>,
  ) {
    return this.ticketsService.assign(slug, ref, assignInput);
  }
}
