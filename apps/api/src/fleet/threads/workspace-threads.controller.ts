import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { AnswerQuestionDto, ChatMessageListDto, SendMessageDto, SendMessageResultDto, UpdateThreadDto } from './dto/thread.dto';
import { CreateWorkspaceThreadDto, WorkspaceThreadDetailDto, WorkspaceThreadDto, WorkspaceThreadListDto } from './dto/workspace-thread.dto';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { WORKSPACE_THREAD_ROUTE_VARIANTS } from './workspace-thread-route.commands';
import type { ChatThreadRecord, ChatThreadDetail } from './domain/chat-thread.domain';

/** A query integer (same rules as the project route): only digits, so `Number('1e3')` or `Number('')` never pass. */
function intParam(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/**
 * The personal thread surface (fleet S5b 1d, S5b-R12), migrated onto permission keys by permissions P1
 * US-003: top-level `/threads`, so there is no project to resolve and `RequiresGuard` runs alone.
 *
 * There is no principal-type refusal left — an agent may hold the workspace keys — and no CASL check. The
 * workspace keys are decided at the guard, on the caller's global keys; the four routes that act on one
 * thread's own rows (`PATCH`, `stop`, `end-session`, `answer`) declare their project key
 * `enforcedBy: 'service'` because only the loaded row names the project and the creator, and
 * `WorkspaceThreadsService` asks for it there. The workspace scope still answers 404 to anyone but the
 * creator (1d-D2), global admins included.
 */
@ApiTags('fleet threads')
@ApiBearerAuth()
@Controller('threads')
export class WorkspaceThreadsController {
  constructor(private readonly threads: WorkspaceThreadsService, private readonly routeGate: ApprovalRouteGate) {}

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('thread.workspace.create')
  @ApiOperation({ summary: 'Create a personal workspace chat thread (thread.workspace.create, hosted by the home project’s thread.create)' })
  @ApiResponse({ status: 201, type: WorkspaceThreadDto })
  @ApiResponse({ status: 403, description: 'thread.workspace.create is missing, or thread.create is refused in the home project' })
  @ApprovalGated()
  async create(@Body() dto: CreateWorkspaceThreadDto, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const outcome = await this.routeGate.run<ChatThreadRecord>({
      key: 'thread.workspace.create', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.create, projectId: null,
      input: { thread: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('thread.workspace.read')
  @ApiOperation({ summary: 'List the caller’s personal workspace chat threads (thread.workspace.read)' })
  @ApiResponse({ status: 200, type: WorkspaceThreadListDto })
  @ApiResponse({ status: 403, description: 'thread.workspace.read is missing' })
  async list(@Query() query: Record<string, string | undefined>, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const status = query.status;
    if (status !== undefined && status !== 'ACTIVE' && status !== 'ARCHIVED') throw new ValidationAppException({ reason: 'status' }, 'threads.input');
    const page = intParam(query.page, 1, Number.MAX_SAFE_INTEGER);
    const size = intParam(query.size, 1, 100);
    if ((query.page !== undefined && page === null) || (query.size !== undefined && size === null)) throw new ValidationAppException({ reason: query.page !== undefined && page === null ? 'page' : 'size' }, 'threads.input');
    const current = page ?? 1;
    const take = size ?? 20;
    return JsonResponse.Ok(await this.threads.list(principal.id, status, (current - 1) * take, take));
  }

  @Get(':id')
  @UseGuards(RequiresGuard)
  @Requires('thread.workspace.read')
  @ApiOperation({ summary: 'Get one of the caller’s personal workspace chat threads (thread.workspace.read)' })
  @ApiResponse({ status: 200, type: WorkspaceThreadDetailDto })
  @ApiResponse({ status: 403, description: 'thread.workspace.read is missing' })
  @ApiResponse({ status: 404, description: 'threads.notFound when the thread is not the caller’s WORKSPACE thread' })
  async get(@Param('id') id: string, @Principal() principal: UserPrincipal | AgentPrincipal) {
    return JsonResponse.Ok(await this.threads.get(principal.id, id));
  }

  @Get(':id/messages')
  @UseGuards(RequiresGuard)
  @Requires('thread.workspace.read')
  @ApiOperation({ summary: 'List the messages of one of the caller’s workspace chat threads (thread.workspace.read)' })
  @ApiResponse({ status: 200, type: ChatMessageListDto })
  @ApiResponse({ status: 403, description: 'thread.workspace.read is missing' })
  @ApiResponse({ status: 404, description: 'threads.notFound when the thread is not the caller’s WORKSPACE thread' })
  async messages(@Param('id') id: string, @Query() query: Record<string, string | undefined>, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const after = intParam(query.afterSeq, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(query.limit, 1, 200);
    if ((query.afterSeq !== undefined && after === null) || (query.limit !== undefined && limit === null)) throw new ValidationAppException({ reason: 'messages' }, 'threads.input');
    return JsonResponse.Ok(await this.threads.messages(principal.id, id, after ?? 0, limit ?? 100));
  }

  @Post(':id/messages')
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('thread.workspace.message.send')
  @ApiOperation({ summary: 'Send a message to a personal workspace chat thread (thread.workspace.message.send)' })
  @ApiResponse({ status: 201, type: SendMessageResultDto })
  @ApiResponse({ status: 200, type: SendMessageResultDto })
  @ApiResponse({ status: 403, description: 'thread.workspace.message.send is missing, or thread.create is refused in the home project' })
  async send(@Param('id') id: string, @Body() dto: SendMessageDto, @Principal() principal: UserPrincipal | AgentPrincipal, @Res({ passthrough: true }) response: { status: (code: number) => unknown }) {
    const result = await this.threads.sendMessage(principal, id, dto);
    if (result.deduplicated) response.status(200);
    return JsonResponse.Ok({ message: result.message, jobId: result.jobId });
  }

  @Post(':id/archive')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('thread.workspace.archive')
  @ApiOperation({ summary: 'Archive a personal workspace chat thread (thread.workspace.archive)' })
  @ApiResponse({ status: 200, type: WorkspaceThreadDetailDto })
  @ApiResponse({ status: 403, description: 'thread.workspace.archive is missing' })
  @ApprovalGated()
  async archive(@Param('id') id: string, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const outcome = await this.routeGate.run<ChatThreadDetail>({
      key: 'thread.workspace.archive', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.archive, projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':id')
  @UseGuards(RequiresGuard)
  @Requires('thread.cap.update', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Update the cost cap of one of the caller’s workspace chat threads (thread.cap.update: the creator, or the any-row key)' })
  @ApiResponse({ status: 200, type: WorkspaceThreadDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.cap.update nor created the thread' })
  @ApprovalGated()
  async update(@Param('id') id: string, @Body() dto: UpdateThreadDto, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const thread = await this.threads.requireOwnedThread(principal.id, id);
    const outcome = await this.routeGate.run<Awaited<ReturnType<WorkspaceThreadsService['updateCap']>>>({
      key: 'thread.cap.update', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.update, projectId: thread.projectId,
      input: { id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('thread.stop', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Stop the live turn of a workspace chat thread (thread.stop: the creator, or the any-row key)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.stop nor created the thread' })
  @ApprovalGated()
  async stop(@Param('id') id: string, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const thread = await this.threads.requireOwnedThread(principal.id, id);
    const outcome = await this.routeGate.run<Record<string, never>>({
      key: 'thread.stop', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.stop, projectId: thread.projectId, input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({});
  }

  @Post(':id/end-session')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('thread.end-session', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Close the live session of a workspace chat thread (thread.end-session: the creator, or the any-row key)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.end-session nor created the thread' })
  @ApprovalGated()
  async endSession(@Param('id') id: string, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const thread = await this.threads.requireOwnedThread(principal.id, id);
    const outcome = await this.routeGate.run<Record<string, never>>({
      key: 'thread.end-session', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.endSession, projectId: thread.projectId, input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({});
  }

  @Post(':id/answer')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('thread.answer', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Answer a pending question of a workspace chat thread (thread.answer: the creator, or the any-row key)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.answer nor created the thread' })
  @ApprovalGated()
  async answer(@Param('id') id: string, @Body() dto: AnswerQuestionDto, @Principal() principal: UserPrincipal | AgentPrincipal) {
    const thread = await this.threads.requireOwnedThread(principal.id, id);
    const outcome = await this.routeGate.run<Record<string, never>>({
      key: 'thread.answer', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.answer, projectId: thread.projectId,
      input: { id, answer: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({});
  }
}
