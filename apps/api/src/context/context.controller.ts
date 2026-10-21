import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ContextBuilderService, GetProjectContextQuery } from './context-builder.service';
import { GetContextQueryDto } from './dto/get-context-query.dto';
import { parseQuery } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import type { ProjectContext } from '../projects/project-context';

@ApiTags('context')
@ApiBearerAuth()
@Controller('context')
@ApiParam({ name: 'slug', type: String })
export class ContextController {
  constructor(private readonly contextBuilderService: ContextBuilderService) {}

  private buildQuery(
    projectId: string,
    actorId: string,
    raw: GetContextQueryDto | undefined,
  ): GetProjectContextQuery {
    const dto = parseQuery(GetContextQueryDto, raw ?? {});
    return {
      projectId,
      actorId,
      intent: dto.intent ?? 'answer',
      query: dto.query,
      ticketIds: dto.ticketIds,
      repoRefs: dto.repoRefs,
      includeCodeIntel: dto.includeCodeIntel,
      includeGraph: dto.includeGraph,
      tokenBudget: dto.tokenBudget,
    };
  }

  @Get(':slug')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('context.read')
  @ApiOperation({ summary: 'Get project context for agent use' })
  @ApiResponse({ status: 200, description: 'Project context retrieved' })
  @ApiResponse({ status: 400, description: 'Invalid query' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getContext(
    @Query() queryDto: GetContextQueryDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const actorId = principal.id;
    const result = await this.contextBuilderService.getProjectContext(
      this.buildQuery(ctx.project.id, actorId, queryDto),
    );
    return JsonResponse.Ok(result);
  }

  @Post(':slug/query')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('context.query')
  @HttpCode(200)
  @ApiOperation({ summary: 'Query project context with request body' })
  @ApiResponse({ status: 200, description: 'Project context retrieved' })
  @ApiResponse({ status: 400, description: 'Invalid query' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async queryContext(
    @Body() body: GetContextQueryDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const actorId = principal.id;
    const result = await this.contextBuilderService.getProjectContext(
      this.buildQuery(ctx.project.id, actorId, body),
    );
    return JsonResponse.Ok(result);
  }
}
