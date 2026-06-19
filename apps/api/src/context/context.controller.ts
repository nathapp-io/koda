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
import { PrismaService } from '@nathapp/nestjs-prisma';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ActorRole } from '../common/enums';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { ContextBuilderService, GetProjectContextQuery, ContextIntent } from './context-builder.service';

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
    private readonly prisma: PrismaService,
  ) {}

  private async resolveProjectId(slug: string): Promise<string> {
    const projectDelegate = (this.prisma.client as unknown as Record<string, unknown>)['project'] as {
      findFirst(options: unknown): Promise<{ id: string; deletedAt: Date | null } | null>;
    };
    const project = await projectDelegate.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true, deletedAt: true },
    });
    if (!project) {
      throw new NotFoundAppException({}, 'context');
    }
    return project.id;
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'context');
    }

    if (!isUserPrincipal(principal)) {
      return;
    }

    if (principal.role === 'ADMIN') {
      return;
    }

    const projectMemberDelegate = (this.prisma.client as unknown as Record<string, unknown>)['projectMember'] as {
      findUnique(options: unknown): Promise<unknown>;
    };
    const membership = await projectMemberDelegate.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId: principal.id,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenAppException({}, 'context');
    }

    const allowedRoles = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT, ActorRole.VIEWER] as const;
    const membershipRole = (membership as { role?: string }).role;
    if (!membershipRole || !allowedRoles.includes(membershipRole as typeof allowedRoles[number])) {
      throw new ForbiddenAppException({}, 'context');
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
