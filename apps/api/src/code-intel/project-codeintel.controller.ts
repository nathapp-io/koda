import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ImpactAnalysisService } from './impact-analysis.service';
import { GetChangeImpactDto } from './dto/get-change-impact.dto';

@ApiTags('code-intel')
@ApiBearerAuth()
@Controller('projects/:slug/codeintel')
export class ProjectCodeIntelController {
  constructor(
    private readonly impactAnalysisService: ImpactAnalysisService,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  @Get('impact')
  @ApiParam({ name: 'slug', description: 'Project slug' })
  @ApiOperation({ summary: 'Get change impact analysis for a commit' })
  @ApiResponse({ status: 200, description: 'Change impact result' })
  @ApiResponse({ status: 400, description: 'Bad request — missing required query parameters' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission([CaslPermissionAction.READ, 'CodeIntel'])
  async getChangeImpact(
    @Param('slug') slug: string,
    @Query() query: GetChangeImpactDto,
    @Principal() _principal: KodaPrincipal,
  ) {
    const project = await this.db.project.findUnique({ where: { slug } });
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'codeintel');
    }

    const changedFiles = query.changedFiles
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    const result = await this.impactAnalysisService.getChangeImpact({
      projectId: project.id,
      repoId: query.repoId,
      commitHash: query.commitHash,
      changedFiles,
      ticketId: query.ticketId,
    });

    return JsonResponse.Ok(result);
  }
}
