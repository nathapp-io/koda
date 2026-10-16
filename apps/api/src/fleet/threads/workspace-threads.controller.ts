import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { isUserPrincipal, type KodaPrincipal, type UserPrincipal } from '../../auth/principal/koda-principal.types';
import { AnswerQuestionDto, ChatMessageListDto, UpdateThreadDto } from './dto/thread.dto';
import { CreateWorkspaceThreadDto, WorkspaceThreadDetailDto, WorkspaceThreadDto, WorkspaceThreadListDto } from './dto/workspace-thread.dto';
import { WorkspaceThreadsService } from './workspace-threads.service';

/** A query integer (same rules as the project route): only digits, so `Number('1e3')` or `Number('')` never pass. */
function intParam(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/**
 * The personal thread surface (fleet S5b 1d, S5b-R12): top-level `/threads`, creator only — an agent or runner
 * principal answers 403 `threads.principal` and every other caller of a `/threads/:id` route answers 404, global
 * admins included (1d-D2).
 */
@ApiTags('fleet threads')
@ApiBearerAuth()
@Controller('threads')
export class WorkspaceThreadsController {
  constructor(private readonly threads: WorkspaceThreadsService) {}

  private user(principal: KodaPrincipal): UserPrincipal {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'threads.principal');
    return principal;
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a personal workspace chat thread' })
  @ApiResponse({ status: 201, type: WorkspaceThreadDto })
  async create(@Body() dto: CreateWorkspaceThreadDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.threads.create(this.user(principal), dto));
  }

  @Get()
  @ApiOperation({ summary: 'List the caller’s personal workspace chat threads' })
  @ApiResponse({ status: 200, type: WorkspaceThreadListDto })
  async list(@Query() query: Record<string, string | undefined>, @Principal() principal: KodaPrincipal) {
    const user = this.user(principal);
    const status = query.status;
    if (status !== undefined && status !== 'ACTIVE' && status !== 'ARCHIVED') throw new ValidationAppException({ reason: 'status' }, 'threads.input');
    const page = intParam(query.page, 1, Number.MAX_SAFE_INTEGER);
    const size = intParam(query.size, 1, 100);
    if ((query.page !== undefined && page === null) || (query.size !== undefined && size === null)) throw new ValidationAppException({ reason: query.page !== undefined && page === null ? 'page' : 'size' }, 'threads.input');
    const current = page ?? 1;
    const take = size ?? 20;
    return JsonResponse.Ok(await this.threads.list(user.id, status, (current - 1) * take, take));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of the caller’s personal workspace chat threads' })
  @ApiResponse({ status: 200, type: WorkspaceThreadDetailDto })
  async get(@Param('id') id: string, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.threads.get(this.user(principal).id, id));
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'List the messages of one of the caller’s workspace chat threads' })
  @ApiResponse({ status: 200, type: ChatMessageListDto })
  async messages(@Param('id') id: string, @Query() query: Record<string, string | undefined>, @Principal() principal: KodaPrincipal) {
    const user = this.user(principal);
    const after = intParam(query.afterSeq, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(query.limit, 1, 200);
    if ((query.afterSeq !== undefined && after === null) || (query.limit !== undefined && limit === null)) throw new ValidationAppException({ reason: 'messages' }, 'threads.input');
    return JsonResponse.Ok(await this.threads.messages(user.id, id, after ?? 0, limit ?? 100));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update the cost cap of one of the caller’s workspace chat threads' })
  @ApiResponse({ status: 200, type: WorkspaceThreadDto })
  async update(@Param('id') id: string, @Body() dto: UpdateThreadDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.threads.updateCap(this.user(principal).id, id, dto.maxCostUsd));
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the live turn of a workspace chat thread (creator)' })
  async stop(@Param('id') id: string, @Principal() principal: KodaPrincipal) {
    await this.threads.stop(this.user(principal).id, id);
    return JsonResponse.Ok({});
  }

  @Post(':id/end-session')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close the live session of a workspace chat thread (creator)' })
  async endSession(@Param('id') id: string, @Principal() principal: KodaPrincipal) {
    await this.threads.endSession(this.user(principal).id, id);
    return JsonResponse.Ok({});
  }

  @Post(':id/answer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Answer a pending question of a workspace chat thread (creator)' })
  async answer(@Param('id') id: string, @Body() dto: AnswerQuestionDto, @Principal() principal: KodaPrincipal) {
    await this.threads.answer(this.user(principal).id, id, dto);
    return JsonResponse.Ok({});
  }
}
