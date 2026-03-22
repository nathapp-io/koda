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
import { TicketTransitionsService, TransitionResultWithComment, TransitionResultWithoutComment } from './state-machine/ticket-transitions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { TransitionWithCommentDto } from './dto/transition-with-comment.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import { TicketType, TicketStatus, Priority } from '../common/enums';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestWithUser = any & { user?: any; agent?: any };

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('projects/:slug/tickets')
export class TicketsController {
  constructor(
    private ticketsService: TicketsService,
    private transitionsService: TicketTransitionsService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new ticket' })
  @ApiResponse({ status: 201, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async create(
    @Param('slug') slug: string,
    @Body() createTicketDto: CreateTicketDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';

    const data = await this.ticketsService.create(slug, createTicketDto, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findAll(
    @Param('slug') slug: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const data = await this.ticketsService.findAll(slug, filters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Get(':ref')
  @ApiOperation({ summary: 'Get a ticket by reference (KODA-42 or CUID)' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findByRef(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
  ) {
    const data = await this.ticketsService.findByRef(slug, ref);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Patch(':ref')
  @ApiOperation({ summary: 'Update a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async update(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() updateTicketDto: UpdateTicketDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';

    const data = await this.ticketsService.update(slug, ref, updateTicketDto, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Delete(':ref')
  @ApiOperation({ summary: 'Soft delete a ticket (admin only)' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async softDelete(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';

    const data = await this.ticketsService.softDelete(slug, ref, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign or unassign a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot assign to both user and agent' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async assign(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Body() assignInput: Record<string, any>,
  ) {
    const data = await this.ticketsService.assign(slug, ref, assignInput);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a ticket (CREATED → VERIFIED)' })
  @ApiResponse({ status: 200, description: 'Ticket verified' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async verify(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';
    const data = await this.transitionsService.verify(slug, ref, dto.body ?? '', currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start work on a ticket (VERIFIED → IN_PROGRESS)' })
  @ApiResponse({ status: 200, description: 'Ticket started' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async start(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';
    const data = await this.transitionsService.start(slug, ref, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/fix')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit fix for verification (IN_PROGRESS → VERIFY_FIX)' })
  @ApiResponse({ status: 200, description: 'Fix submitted' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async fix(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';
    const data = await this.transitionsService.fix(slug, ref, dto.body ?? '', currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/verify-fix')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve or reject fix (VERIFY_FIX → CLOSED or IN_PROGRESS)' })
  @ApiResponse({ status: 200, description: 'Fix reviewed' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async verifyFix(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Query('approve') approve: boolean | string,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';
    const isApproved = approve === 'true' || approve === true;
    const data = await this.transitionsService.verifyFix(slug, ref, dto.body ?? '', isApproved, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a ticket' })
  @ApiResponse({ status: 200, description: 'Ticket closed' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async close(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';
    const data = await this.transitionsService.close(slug, ref, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Post(':ref/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a ticket (CREATED or VERIFIED → REJECTED)' })
  @ApiResponse({ status: 200, description: 'Ticket rejected' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async reject(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType: 'user' | 'agent' = req.agent ? 'agent' : 'user';
    const data = await this.transitionsService.reject(slug, ref, dto.body ?? '', currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }
}
