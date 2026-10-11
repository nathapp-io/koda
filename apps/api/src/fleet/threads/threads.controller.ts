import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { ProjectContext } from '../../projects/project-context';
import { withProjectRole } from '../../projects/project-context';
import { ThreadsService } from './threads.service';
import { AnswerQuestionDto, ChatMessageListDto, ChatMessageDto, CreateThreadDto, SendMessageDto, SendMessageResultDto, ThreadDto, ThreadListDto, UpdateThreadDto } from './dto/thread.dto';

@ApiTags('fleet threads')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/threads')
@UseGuards(ProjectMembershipGuard)
export class ThreadsController {
  constructor(private readonly threads: ThreadsService, private readonly casl: KodaCaslAbilityFactory) {}

  private assertUser(principal: KodaPrincipal): void {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'threads.principal');
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a chat thread (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: ThreadDto })
  async create(@Body() dto: CreateThreadDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    const ability = await this.casl.createForUser(withProjectRole(principal, ctx.role));
    if (!ability.can(CaslPermissionAction.CREATE, 'FleetJob')) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.threads.create(ctx.project.id, principal.id, dto));
  }

  @Get()
  @ApiOperation({ summary: 'List project chat threads' })
  @ApiResponse({ status: 200, type: ThreadListDto })
  async list(@Query() query: Record<string, string | undefined>, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
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
  @ApiOperation({ summary: 'Get a chat thread' })
  @ApiResponse({ status: 200, type: ThreadDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    return JsonResponse.Ok(await this.threads.get(ctx.project.id, id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a chat thread cost cap' })
  @ApiResponse({ status: 200, type: ThreadDto })
  async update(@Param('id') id: string, @Body() dto: UpdateThreadDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    return JsonResponse.Ok(await this.threads.updateCap(ctx.project.id, id, principal.id, dto.maxCostUsd));
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the live turn of a chat thread (creator)' })
  async stop(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    await this.threads.stop(ctx.project.id, id, principal.id);
    return JsonResponse.Ok({});
  }

  @Post(':id/end-session')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close the live session of a chat thread (creator)' })
  async endSession(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    await this.threads.endSession(ctx.project.id, id, principal.id);
    return JsonResponse.Ok({});
  }

  @Post(':id/answer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Answer a pending question of a chat thread (creator)' })
  async answer(@Param('id') id: string, @Body() dto: AnswerQuestionDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    await this.threads.answer(ctx.project.id, id, principal.id, dto);
    return JsonResponse.Ok({});
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a chat thread (creator or project admin)' })
  async archive(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
    await this.threads.archive(ctx.project.id, id, principal.id, ctx.role === 'ADMIN');
    return JsonResponse.Ok(await this.threads.get(ctx.project.id, id));
  }

  @Post(':id/messages')
  @HttpCode(201)
  @ApiOperation({ summary: 'Send a message to a chat thread' })
  @ApiResponse({ status: 201, type: SendMessageResultDto })
  @ApiResponse({ status: 200, type: SendMessageResultDto })
  async sendMessage(    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
    @Res({ passthrough: true }) response: { status: (code: number) => unknown },
  ) {
    this.assertUser(principal);
    const result = await this.threads.sendMessage(ctx.project.id, id, principal.id, dto);
    if (result.deduplicated) response.status(200);
    return JsonResponse.Ok({ message: result.message, jobId: result.jobId });
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'List chat thread messages' })
  @ApiResponse({ status: 200, type: ChatMessageListDto })
  async messages(@Param('id') id: string, @Query() query: Record<string, string | undefined>, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    this.assertUser(principal);
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
}
