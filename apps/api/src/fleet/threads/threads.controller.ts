import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { THREAD_ROUTE_VARIANTS } from './thread-route.commands';
import type { ChatThreadRecord, ChatThreadDetail } from './domain/chat-thread.domain';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { ProjectContext } from '../../projects/project-context';
import { ThreadsService } from './threads.service';
import { AnswerQuestionDto, ChatMessageListDto, ChatMessageDto, CreateThreadDto, SendMessageDto, SendMessageResultDto, ThreadDetailDto, ThreadDto, ThreadListDto, UpdateThreadDto } from './dto/thread.dto';
import { PlanThreadDto, RunThreadDto } from './dto/thread-handoff.dto';
import { DispatchResultDto } from '../jobs/dto/fleet-job.dto';

/**
 * The project thread routes, migrated onto permission keys by permissions P1 US-002.
 *
 * Every route declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`, so the membership
 * guard resolves `request.projectContext` before the key check. There is no principal-type refusal and
 * no CASL check left: an agent may create and drive a thread, and the key decides.
 *
 * The thread write keys are ownable, so `RequiresGuard` passes a caller holding only `X.own`
 * (`not-owner`) on purpose — the row is not loaded yet. The handler then asks for the same key
 * *without* a resource: `canOperate` is true only for an any-row holder, and a `.own` holder keeps the
 * creator compare in the service and repository. `plan` and `run` also need `fleet.job.dispatch`,
 * because both dispatch a job.
 */
@ApiTags('fleet threads')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/threads')
export class ThreadsController {
  constructor(private readonly threads: ThreadsService, private readonly permissions: PermissionService, private readonly routeGate: ApprovalRouteGate) {}

  @Post()
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.create')
  @ApiOperation({ summary: 'Create a chat thread (thread.create)' })
  @ApiResponse({ status: 201, type: ThreadDto })
  @ApiResponse({ status: 403, description: 'thread.create is missing' })
  @ApprovalGated()
  async create(@Body() dto: CreateThreadDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<ChatThreadRecord>({
      key: 'thread.create', variant: THREAD_ROUTE_VARIANTS.create, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, thread: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.read')
  @ApiOperation({ summary: 'List project chat threads (thread.read)' })
  @ApiResponse({ status: 200, type: ThreadListDto })
  @ApiResponse({ status: 403, description: 'thread.read is missing' })
  async list(@Query() query: Record<string, string | undefined>, @CurrentProject() ctx: ProjectContext) {
    const status = query.status;
    if (status !== undefined && status !== 'ACTIVE' && status !== 'ARCHIVED') throw new ValidationAppException({ reason: 'status' }, 'threads.input');
    // A query string is only digits here, so `Number('1e3')` or `Number('')` never become a page.
    const intParam = (raw: string | undefined, min: number, max: number): number | null => {
      if (raw === undefined || !/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return value >= min && value <= max ? value : null;
    };
    const page = intParam(query.page, 1, Number.MAX_SAFE_INTEGER);
    const size = intParam(query.size, 1, 100);
    if ((query.page !== undefined && page === null) || (query.size !== undefined && size === null)) throw new ValidationAppException({ reason: query.page !== undefined && page === null ? 'page' : 'size' }, 'threads.input');
    const current = page ?? 1;
    const take = size ?? 20;
    return JsonResponse.Ok(await this.threads.list(ctx.project.id, status, (current - 1) * take, take));
  }

  @Get(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.read')
  @ApiOperation({ summary: 'Get a chat thread (thread.read)' })
  @ApiResponse({ status: 200, type: ThreadDetailDto })
  @ApiResponse({ status: 403, description: 'thread.read is missing' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.threads.get(ctx.project.id, id));
  }

  @Patch(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.cap.update')
  @ApiOperation({ summary: 'Update a chat thread cost cap (thread.cap.update: the creator, or the any-row key)' })
  @ApiResponse({ status: 200, type: ThreadDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.cap.update nor created the thread' })
  @ApprovalGated()
  async update(@Param('id') id: string, @Body() dto: UpdateThreadDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<ChatThreadRecord>({
      key: 'thread.cap.update', variant: THREAD_ROUTE_VARIANTS.update, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/plan')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires(['thread.plan', 'fleet.job.dispatch'])
  @ApiOperation({ summary: 'Plan a published thread spec (thread.plan and fleet.job.dispatch: the creator, or the any-row key)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'thread.plan or fleet.job.dispatch is missing, or the caller did not create the thread' })
  @ApprovalGated()
  async plan(@Param('id') id: string, @Body() dto: PlanThreadDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<Awaited<ReturnType<ThreadsService['plan']>>>({
      key: 'thread.plan', variant: THREAD_ROUTE_VARIANTS.plan, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id, plan: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/run')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires(['thread.run', 'fleet.job.dispatch'])
  @ApiOperation({ summary: 'Run a thread after its latest plan completed (thread.run and fleet.job.dispatch: the creator, or the any-row key)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'thread.run or fleet.job.dispatch is missing, or the caller did not create the thread' })
  @ApprovalGated()
  async run(@Param('id') id: string, @Body() dto: RunThreadDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<Awaited<ReturnType<ThreadsService['run']>>>({
      key: 'thread.run', variant: THREAD_ROUTE_VARIANTS.run, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id, run: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.stop')
  @ApiOperation({ summary: 'Stop the live turn of a chat thread (thread.stop: the creator, or the any-row key)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.stop nor created the thread' })
  @ApprovalGated()
  async stop(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<void>({
      key: 'thread.stop', variant: THREAD_ROUTE_VARIANTS.stop, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/end-session')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.end-session')
  @ApiOperation({ summary: 'Close the live session of a chat thread (thread.end-session: the creator, or the any-row key)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.end-session nor created the thread' })
  @ApprovalGated()
  async endSession(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<void>({
      key: 'thread.end-session', variant: THREAD_ROUTE_VARIANTS.endSession, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/answer')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.answer')
  @ApiOperation({ summary: 'Answer a pending question of a chat thread (thread.answer: the creator, or the any-row key)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.answer nor created the thread' })
  @ApiResponse({ status: 409, description: 'threads.noQuestion, threads.noSession, or threads.sessionOtherPrincipal' })
  @ApprovalGated()
  async answer(@Param('id') id: string, @Body() dto: AnswerQuestionDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<void>({
      key: 'thread.answer', variant: THREAD_ROUTE_VARIANTS.answer, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id, answer: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.archive')
  @ApiOperation({ summary: 'Archive a chat thread (thread.archive: the creator, or the any-row key)' })
  @ApiResponse({ status: 200, type: ThreadDetailDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.archive nor created the thread' })
  @ApprovalGated()
  async archive(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<ChatThreadDetail>({
      key: 'thread.archive', variant: THREAD_ROUTE_VARIANTS.archive, projectId: ctx.project.id,
      input: { slug: ctx.project.slug, projectId: ctx.project.id, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.publish')
  @ApiOperation({ summary: 'Publish thread documents (thread.publish: the creator, or the any-row key)' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { jobId: { type: 'string', nullable: true } } } })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.publish nor created the thread' })
  @ApiResponse({ status: 409, description: 'threads.sessionOtherPrincipal when another principal started the live session' })
  async publish(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const canOperate = await this.canOperate(principal, 'thread.publish', ctx);
    return JsonResponse.Ok(await this.threads.publish(ctx.project.id, id, principal.id, canOperate));
  }

  @Post(':id/discard')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.discard')
  @ApiOperation({ summary: 'Discard the thread worktree changes (thread.discard: the creator, or the any-row key)' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { jobId: { type: 'string' } } } })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.discard nor created the thread' })
  async discard(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const canOperate = await this.canOperate(principal, 'thread.discard', ctx);
    return JsonResponse.Ok(await this.threads.discard(ctx.project.id, id, principal.id, canOperate));
  }

  @Post(':id/messages')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.message.send')
  @ApiOperation({ summary: 'Send a message to a chat thread (thread.message.send: the creator, or the any-row key)' })
  @ApiResponse({ status: 201, type: SendMessageResultDto })
  @ApiResponse({ status: 200, type: SendMessageResultDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds thread.message.send nor created the thread' })
  @ApiResponse({ status: 409, description: 'threads.sessionOtherPrincipal when another principal started the live session' })
  async sendMessage(    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
    @Res({ passthrough: true }) response: { status: (code: number) => unknown },
  ) {
    const canOperate = await this.canOperate(principal, 'thread.message.send', ctx);
    const result = await this.threads.sendMessage(ctx.project.id, id, principal.id, dto, canOperate);
    if (result.deduplicated) response.status(200);
    return JsonResponse.Ok({ message: result.message, jobId: result.jobId });
  }

  @Get(':id/messages')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('thread.read')
  @ApiOperation({ summary: 'List chat thread messages (thread.read)' })
  @ApiResponse({ status: 200, type: ChatMessageListDto })
  @ApiResponse({ status: 403, description: 'thread.read is missing' })
  async messages(@Param('id') id: string, @Query() query: Record<string, string | undefined>, @CurrentProject() ctx: ProjectContext) {
    const intParam = (raw: string | undefined, min: number, max: number): number | null => {
      if (raw === undefined || !/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return value >= min && value <= max ? value : null;
    };
    const after = intParam(query.afterSeq, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(query.limit, 1, 200);
    if ((query.afterSeq !== undefined && after === null) || (query.limit !== undefined && limit === null)) throw new ValidationAppException({ reason: 'messages' }, 'threads.input');
    return JsonResponse.Ok(await this.threads.messages(ctx.project.id, id, after ?? 0, limit ?? 100));
  }

  /**
   * The any-row half of "creator or any-row key holder": a caller holding the plain key operates on every
   * thread of the project; one holding only `X.own` is answered `not-owner` here (no resource is passed),
   * so the service and repository keep the `createdById === caller` compare.
   */
  private async canOperate(principal: KodaPrincipal, key: string, ctx: ProjectContext): Promise<boolean> {
    return (await this.permissions.can(principal, key, { projectId: ctx.project.id })).allowed;
  }
}
