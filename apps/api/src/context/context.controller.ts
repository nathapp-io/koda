import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { JsonResponse, ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { ContextBuilderService, GetProjectContextQuery, ContextIntent } from './context-builder.service';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';
import { ActorRole } from '../common/enums';

class GetContextQueryDto {
  intent!: ContextIntent;
  query?: string;
  ticketIds?: string[];
  repoRefs?: string[];
  includeCodeIntel?: boolean;
  includeGraph?: boolean;
  tokenBudget?: number;
}

@ApiTags('context')
@ApiBearerAuth()
@Controller('context')
export class ContextController {
  constructor(
    private readonly contextBuilderService: ContextBuilderService,
    private readonly projectRepo: PrismaProjectRepository,
  ) {}

  private async resolveProjectId(slug: string): Promise<string> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');
    return project.id;
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'context');
    }
    if (!isUserPrincipal(principal)) return;
    if (principal.role === 'ADMIN') return;
    const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
    const allowed = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT, ActorRole.VIEWER] as const;
    if (!role || !allowed.includes(role as typeof allowed[number])) {
      throw new ForbiddenAppException({}, 'projects');
    }
  }

  private buildQuery(
    projectId: string,
    actorId: string,
    dto: GetContextQueryDto,
  ): GetProjectContextQuery {
    return {
      projectId,
      actorId,
      intent: dto.intent ?? 'answer',
      query: dto.query,
      ticketIds: dto.ticketIds,
      repoRefs: dto.repoRefs,
      includeCodeIntel: dto.includeCodeIntel,
      includeGraph: dto.includeGraph,
      tokenBudget: dto.tokenBudget ? Number(dto.tokenBudget) : undefined,
    };
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get project context for agent use' })
  @ApiResponse({ status: 200, description: 'Project context retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission([KodaAction.READ as CaslPermissionAction, 'ProjectContext'])
  async getContext(
    @Param('slug') slug: string,
    @Query() queryDto: GetContextQueryDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const projectId = await this.resolveProjectId(slug);
    await this.checkProjectMembership(projectId, principal);
    const actorId = principal.id;
    const result = await this.contextBuilderService.getProjectContext(
      this.buildQuery(projectId, actorId, queryDto),
    );
    return JsonResponse.Ok(result);
  }

  @Post(':slug/query')
  @HttpCode(200)
  @ApiOperation({ summary: 'Query project context with request body' })
  @ApiResponse({ status: 200, description: 'Project context retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission([KodaAction.READ as CaslPermissionAction, 'ProjectContext'])
  async queryContext(
    @Param('slug') slug: string,
    @Body() body: GetContextQueryDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const projectId = await this.resolveProjectId(slug);
    await this.checkProjectMembership(projectId, principal);
    const actorId = principal.id;
    const result = await this.contextBuilderService.getProjectContext(
      this.buildQuery(projectId, actorId, body),
    );
    return JsonResponse.Ok(result);
  }
}
