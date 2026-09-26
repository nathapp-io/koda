import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { TransitionWithCommentDto } from './dto/transition-with-comment.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { ListTicketsQuery } from './dto/list-tickets.query';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { isAgentPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { ProjectsService } from '../projects/projects.service';
import { TicketListFilterInput } from './tickets.service';

/** `assignedTo=self` means the caller: its user id, or its agent id for an agent. */
export function resolveSelfAssignee(
  filters: TicketListFilterInput,
  principal: KodaPrincipal | undefined,
): TicketListFilterInput {
  if (filters.assignedTo !== 'self' || !principal) return filters;
  const { assignedTo: _self, ...rest } = filters;
  return isAgentPrincipal(principal)
    ? { ...rest, assignedToAgentId: principal.id }
    : { ...rest, assignedTo: principal.id };
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('projects/:slug/tickets')
export class TicketsController {
  constructor(
    private ticketsService: TicketsService,
    private transitionsService: TicketTransitionsService,
    private readonly projectsService: ProjectsService,
  ) {}

  // Public methods for testing (called directly in tests)
  async createTicket(
    slug: string,
    createTicketDto: CreateTicketDto,
    principal: KodaPrincipal,
  ) {
    return this.ticketsService.create(slug, createTicketDto, principal);
  }

  async getTicket(slug: string, ref: string) {
    return this.ticketsService.findByRef(slug, ref);
  }

  async updateTicket(
    slug: string,
    ref: string,
    updateTicketDto: UpdateTicketDto,
    principal: KodaPrincipal,
  ) {
    return this.ticketsService.update(slug, ref, updateTicketDto, principal);
  }

  async deleteTicket(
    slug: string,
    ref: string,
    principal: KodaPrincipal,
  ) {
    return this.ticketsService.softDelete(slug, ref, principal);
  }

  async assignTicket(slug: string, ref: string, assignInput: AssignTicketDto, principal?: KodaPrincipal) {
    return this.ticketsService.assign(slug, ref, assignInput, principal);
  }

  async verifyTicket(
    slug: string,
    ref: string,
    body: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.verify(slug, ref, body, principal);
  }

  async startTicket(
    slug: string,
    ref: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.start(slug, ref, principal);
  }

  async fixTicket(
    slug: string,
    ref: string,
    body: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.fix(slug, ref, body, principal);
  }

  async verifyFixTicket(
    slug: string,
    ref: string,
    body: string,
    approve: boolean,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.verifyFix(slug, ref, body, approve, principal);
  }

  async closeTicket(
    slug: string,
    ref: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.close(slug, ref, principal);
  }

  async rejectTicket(
    slug: string,
    ref: string,
    body: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.reject(slug, ref, body, principal);
  }

  // M1: a declared comment type on verify/fix/verify-fix/reject must not be
  // silently skipped by a missing or whitespace-only body.
  private requireCommentBody(body: string | undefined): string {
    const trimmed = (body ?? '').trim();
    if (!trimmed) {
      throw new ValidationAppException({ body: 'body must not be blank' }, 'tickets');
    }
    return body as string;
  }

  // HTTP route handlers
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new ticket' })
  @ApiResponse({ status: 201, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async create(
    @Param('slug') slug: string,
    @Body() createTicketDto: CreateTicketDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.createTicket(slug, createTicketDto, principal);
    return JsonResponse.Ok(data);
  }

  @Get()
  @ApiOperation({ summary: 'List tickets for a project (paginated)' })
  @ApiResponse({ status: 200, description: 'Page of tickets: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 400, description: 'Invalid filter or paging parameter' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findAll(
    @Param('slug') slug: string,
    @Query() rawQuery: ListTicketsQuery,
    @Principal() principal?: KodaPrincipal,
  ) {
    const { current, size, ...filters } = parseQuery(ListTicketsQuery, rawQuery);
    const page = await this.ticketsService.findAll(slug, resolveSelfAssignee(filters, principal), { current, size });
    return JsonResponse.Ok(toPageResult(page));
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
    const data = await this.getTicket(slug, ref);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Patch(':ref')
  @ApiOperation({ summary: 'Update a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])
  async update(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() updateTicketDto: UpdateTicketDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.updateTicket(slug, ref, updateTicketDto, principal);
    return JsonResponse.Ok(data);
  }

  @Delete(':ref')
  @ApiOperation({ summary: 'Soft delete a ticket (admin only)' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([CaslPermissionAction.DELETE, 'Ticket'])
  async softDelete(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.deleteTicket(slug, ref, principal);
    return JsonResponse.Ok(data);
  }

  @Post(':ref/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign or unassign a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot assign to both user and agent' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])
  async assign(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() assignInput: AssignTicketDto,
    @Principal() principal: KodaPrincipal,
  ) {
    // BUG-2: match getChangeImpact — require project membership on top of CASL.
    const projectId = await this.projectsService.findProjectIdBySlug(slug);
    await this.projectsService.assertProjectMembership(projectId, principal);

    const data = await this.assignTicket(slug, ref, assignInput, principal);
    return JsonResponse.Ok(data);
  }

  @Post(':ref/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a ticket (CREATED → VERIFIED)' })
  @ApiResponse({ status: 200, description: 'Ticket verified', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async verify(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const result = await this.verifyTicket(slug, ref, this.requireCommentBody(dto.body), principal);
    return JsonResponse.Ok(result.ticket);
  }

  @Post(':ref/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start work on a ticket (VERIFIED → IN_PROGRESS)' })
  @ApiResponse({ status: 200, description: 'Ticket started', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async start(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const result = await this.startTicket(slug, ref, principal);
    return JsonResponse.Ok(result.ticket);
  }

  @Post(':ref/fix')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit fix for verification (IN_PROGRESS → VERIFY_FIX)' })
  @ApiResponse({ status: 200, description: 'Fix submitted', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async fix(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const result = await this.fixTicket(slug, ref, this.requireCommentBody(dto.body), principal);
    return JsonResponse.Ok(result.ticket);
  }

  @Post(':ref/verify-fix')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve or reject fix (VERIFY_FIX → CLOSED or IN_PROGRESS)' })
  @ApiResponse({ status: 200, description: 'Fix reviewed', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async verifyFix(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Query('approve') approve: boolean | string,
    @Principal() principal: KodaPrincipal,
  ) {
    // M1: validate the required comment body before any approve/reject branching.
    const commentBody = this.requireCommentBody(dto.body);
    const isApproved = approve === 'true' || approve === true;
    const result = await this.verifyFixTicket(slug, ref, commentBody, isApproved, principal);
    return JsonResponse.Ok(result.ticket);
  }

  @Post(':ref/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a ticket' })
  @ApiResponse({ status: 200, description: 'Ticket closed', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async close(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const result = await this.closeTicket(slug, ref, principal);
    return JsonResponse.Ok(result.ticket);
  }

  @Post(':ref/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a ticket (CREATED or VERIFIED → REJECTED)' })
  @ApiResponse({ status: 200, description: 'Ticket rejected', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @RequiredPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async reject(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const result = await this.rejectTicket(slug, ref, this.requireCommentBody(dto.body), principal);
    return JsonResponse.Ok(result.ticket);
  }
}
