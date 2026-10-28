import { TICKET_ROUTE_VARIANTS } from './ticket-route.commands';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { parseBody } from '../approvals/route/parse-body';
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
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { TicketDetailResponseDto } from './dto/ticket-detail-response.dto';
import { TransitionWithCommentDto } from './dto/transition-with-comment.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { ListTicketsQuery } from './dto/list-tickets.query';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { isAgentPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';
import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectContext } from '../projects/project-context';
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
// Permissions P1 (US-004): every route declares `ProjectMembershipGuard, RequiresGuard` in one
// `@UseGuards`, so the membership guard resolves `request.projectContext` before the key check and
// runs exactly once per request. A class-level membership guard would run it a second time.
export class TicketsController {
  constructor(
    private ticketsService: TicketsService,
    private transitionsService: TicketTransitionsService,
    private readonly routeGate: ApprovalRouteGate,
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
    reason: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.close(slug, ref, reason, principal);
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
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.create')
  @ApprovalGated()
  @ApiOperation({ summary: 'Create a new ticket' })
  @ApiResponse({ status: 201, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'ticket.create is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async create(
    @Param('slug') slug: string,
    @Body() createTicketDto: CreateTicketDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.create', variant: TICKET_ROUTE_VARIANTS.create,
      projectId: project.project.id, input: { slug, ticket: parseBody(CreateTicketDto, createTicketDto ?? {}) },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.read')
  @ApiOperation({ summary: 'List tickets for a project (paginated)' })
  @ApiResponse({ status: 200, description: 'Page of tickets: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 400, description: 'Invalid filter or paging parameter' })
  @ApiResponse({ status: 403, description: 'ticket.read is missing' })
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
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.read')
  @ApiOperation({ summary: 'Get a ticket by reference (KODA-42 or CUID), with the caller\'s allowedActions' })
  @ApiResponse({ status: 200, type: TicketDetailResponseDto })
  @ApiResponse({ status: 403, description: 'ticket.read is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async findByRef(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const data = await this.ticketsService.findByRefWithActions(slug, ref, principal);
    return JsonResponse.Ok(data);
  }

  @Patch(':ref')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.update')
  @ApprovalGated()
  @ApiOperation({ summary: 'Update a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'The caller holds neither ticket.update nor the edge key of the requested status' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async update(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() updateTicketDto: UpdateTicketDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.update', variant: TICKET_ROUTE_VARIANTS.update,
      projectId: project.project.id, input: { slug, ref, patch: parseBody(UpdateTicketDto, updateTicketDto ?? {}) },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':ref')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Soft delete a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 403, description: 'ticket.delete is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async softDelete(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.delete', variant: TICKET_ROUTE_VARIANTS.delete,
      projectId: project.project.id, input: { slug, ref },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/assign')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.assign')
  @ApprovalGated()
  @ApiOperation({ summary: 'Assign or unassign a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot assign to both user and agent' })
  @ApiResponse({ status: 403, description: 'ticket.assign is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async assign(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() assignInput: AssignTicketDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.assign', variant: TICKET_ROUTE_VARIANTS.assign,
      projectId: project.project.id, input: { slug, ref, assignee: parseBody(AssignTicketDto, assignInput ?? {}) },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/verify')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.transition.verify')
  @ApprovalGated()
  @ApiOperation({ summary: 'Verify a ticket (CREATED → VERIFIED)' })
  @ApiResponse({ status: 200, description: 'Ticket verified', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 403, description: 'ticket.transition.verify, or the edge key of the ticket\'s status, is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async verify(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto = new TransitionWithCommentDto(),
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const body = this.requireCommentBody(dto.body);
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.transition.verify', variant: TICKET_ROUTE_VARIANTS.verify,
      projectId: project.project.id, input: { slug, ref, body },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/start')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.transition.start')
  @ApprovalGated()
  @ApiOperation({ summary: 'Start work on a ticket (VERIFIED → IN_PROGRESS)' })
  @ApiResponse({ status: 200, description: 'Ticket started', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 403, description: 'ticket.transition.start, or the edge key of the ticket\'s status, is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async start(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.transition.start', variant: TICKET_ROUTE_VARIANTS.start,
      projectId: project.project.id, input: { slug, ref },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/fix')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.transition.fix')
  @ApprovalGated()
  @ApiOperation({ summary: 'Submit fix for verification (IN_PROGRESS → VERIFY_FIX)' })
  @ApiResponse({ status: 200, description: 'Fix submitted', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 403, description: 'ticket.transition.fix, or the edge key of the ticket\'s status, is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async fix(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto = new TransitionWithCommentDto(),
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const body = this.requireCommentBody(dto.body);
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.transition.fix', variant: TICKET_ROUTE_VARIANTS.fix,
      projectId: project.project.id, input: { slug, ref, body },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/verify-fix')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires(['ticket.transition.verify-fix.approve', 'ticket.transition.verify-fix.return'], { mode: 'any' })
  @ApprovalGated()
  @ApiOperation({ summary: 'Approve or reject fix (VERIFY_FIX → CLOSED or IN_PROGRESS)' })
  @ApiQuery({ name: 'approve', type: Boolean, required: false, description: 'true closes the ticket; false (default) returns it to IN_PROGRESS' })
  @ApiResponse({ status: 200, description: 'Fix reviewed', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 403, description: 'Neither ticket.transition.verify-fix key, or the edge key, is held' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async verifyFix(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto = new TransitionWithCommentDto(),
    @Query('approve') approve: boolean | string,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    // M1: validate the required comment body before any approve/reject branching.
    const commentBody = this.requireCommentBody(dto.body);
    const isApproved = approve === 'true' || approve === true;
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: isApproved ? 'ticket.transition.verify-fix.approve' : 'ticket.transition.verify-fix.return',
      variant: TICKET_ROUTE_VARIANTS.verifyFix,
      projectId: project.project.id, input: { slug, ref, body: commentBody },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/close')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.transition.close')
  @ApprovalGated()
  @ApiOperation({ summary: 'Close a ticket (reason required, written as a GENERAL comment)' })
  @ApiResponse({ status: 200, description: 'Ticket closed', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition or blank reason' })
  @ApiResponse({ status: 403, description: 'ticket.transition.close is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async close(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto = new TransitionWithCommentDto(),
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const body = this.requireCommentBody(dto.body);
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.transition.close', variant: TICKET_ROUTE_VARIANTS.close,
      projectId: project.project.id, input: { slug, ref, body },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':ref/reject')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.transition.reject')
  @ApprovalGated()
  @ApiOperation({ summary: 'Reject a ticket (CREATED or VERIFIED → REJECTED)' })
  @ApiResponse({ status: 200, description: 'Ticket rejected', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 403, description: 'ticket.transition.reject, or the edge key of the ticket\'s status, is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async reject(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto = new TransitionWithCommentDto(),
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const body = this.requireCommentBody(dto.body);
    const outcome = await this.routeGate.run<TicketResponseDto>({
      key: 'ticket.transition.reject', variant: TICKET_ROUTE_VARIANTS.reject,
      projectId: project.project.id, input: { slug, ref, body },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
