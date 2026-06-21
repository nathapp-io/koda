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
import { JsonResponse, ForbiddenAppException } from '@nathapp/nestjs-common';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { ContextBuilderService, GetProjectContextQuery, ContextIntent } from './context-builder.service';
import { ProjectsService } from '../projects/projects.service';

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
    private readonly projectsService: ProjectsService,
  ) {}

  private async resolveProjectId(slug: string): Promise<string> {
    return this.projectsService.findProjectIdBySlug(slug);
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'context');
    }
    await this.projectsService.assertProjectMembership(projectId, principal);
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
