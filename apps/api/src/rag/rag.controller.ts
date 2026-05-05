import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { EvaluationService } from '../retrieval/evaluation.service';
import { AddDocumentDto } from './dto/add-document.dto';
import { SearchKbDto } from './dto/search-kb.dto';
import { ImportGraphifyDto } from './dto/import-graphify.dto';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import type { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { KodaAction } from '../auth/casl/koda-action.enum';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly hybridRetrieverService: HybridRetrieverService,
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly evaluationService: EvaluationService,
  ) {}

  private get db() { return this.prisma.client; }

  private async resolveProject(slug: string) {
    const project = await this.db.project.findUnique({ where: { slug } });
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'rag');
    return project;
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'rag');
    }

    // Agent principals are cross-project (their API key is their credential).
    // Actor shape is normalized in CombinedAuthGuard and read through principal type guards.
    if (isAgentPrincipal(principal)) {
      return;
    }

    if (!isUserPrincipal(principal)) {
      throw new ForbiddenAppException({}, 'rag');
    }

    // ADMIN users have global permissions and do not need project membership.
    if (principal.role === 'ADMIN') {
      return;
    }

    const membership = await this.db.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId: principal.id,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenAppException({}, 'rag');
    }

    const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT', 'VIEWER'];
    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenAppException({}, 'rag');
    }
  }

  @Post('documents')
  @ApiOperation({ summary: 'Add a document to the project knowledge base' })
  @ApiResponse({ status: 201, description: 'Document indexed' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async addDocument(
    @Param('slug') slug: string,
    @Body() dto: AddDocumentDto,
  ) {
    const project = await this.resolveProject(slug);
    await Promise.all([
      this.ragService.indexDocument(project.id, {
        source: dto.source,
        sourceId: dto.sourceId,
        content: dto.content,
        metadata: dto.metadata ?? {},
      }),
      this.hybridRetrieverService.indexDocument(project.id, {
        source: dto.source,
        sourceId: dto.sourceId,
        content: dto.content,
        metadata: dto.metadata ?? {},
      }),
    ]);
    return JsonResponse.Ok({ indexed: true });
  }

  @Get('documents')
  @ApiOperation({ summary: 'List indexed documents in the project knowledge base' })
  @ApiResponse({ status: 200, description: 'Documents listed' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listDocuments(
    @Param('slug') slug: string,
    @Query('limit') limitStr?: string,
  ) {
    const project = await this.resolveProject(slug);
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 500) : 100;
    const data = await this.ragService.listDocuments(project.id, limit);
    return JsonResponse.Ok(data);
  }

  @Delete('documents/:sourceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete documents by sourceId from the knowledge base (admin only)' })
  @ApiResponse({ status: 200, description: 'Delete documents by sourceId' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission('ADMIN')
  async deleteDocument(
    @Param('slug') slug: string,
    @Param('sourceId') sourceId: string,
    @Principal() _principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.ragService.deleteBySource(project.id, sourceId);
    return JsonResponse.Ok({ deleted: true });
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hybrid search the project knowledge base' })
  @ApiResponse({ status: 200, description: 'Search results with RRF merge and similarity tiers' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async search(
    @Param('slug') slug: string,
    @Body() dto: SearchKbDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.checkProjectMembership(project.id, principal);

    const limit = dto.limit ?? 20;
    const result = await this.hybridRetrieverService.search({
      projectId: project.id,
      query: dto.query,
      limit,
      graphifyEnabled: project.graphifyEnabled,
    });

    return JsonResponse.Ok({
      results: result.results,
      scores: result.scores,
      provenance: {
        retrievedAt: result.retrievedAt,
        sources: result.results.map((r) => ({
          sourceType: r.source,
          sourceId: r.sourceId,
        })),
      },
    });
  }

  @Post('import/graphify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Import graphify knowledge graph into the project knowledge base' })
  @ApiResponse({ status: 200, description: 'Import successful' })
  @ApiResponse({ status: 400, description: 'Graphify not enabled for this project or validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission([KodaAction.IMPORT as CaslPermissionAction, 'CodeIntel'])
  async importGraphify(
    @Param('slug') slug: string,
    @Body() dto: ImportGraphifyDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.checkProjectMembership(project.id, principal);
    if (!project.graphifyEnabled) throw new ValidationAppException({}, 'rag.graphifyDisabled');
    if (dto.nodes.length === 0) return JsonResponse.Ok({ imported: 0, cleared: 0 });

    const importResult = await this.ragService.importGraphify(project.id, dto.nodes, dto.links ?? []);

    await this.db.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: { graphifyLastImportedAt: new Date() },
      });
    });

    return JsonResponse.Ok(importResult);
  }

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Optimize the LanceDB table for a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Table optimized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission('ADMIN')
  async optimizeTable(
    @Param('slug') slug: string,
    @Principal() _principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.ragService.optimizeTable(project.id);
    return JsonResponse.Ok({ optimized: true });
  }

  @Post('evaluate/retrieval')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run the retrieval evaluation harness with seeded queries' })
  @ApiResponse({ status: 200, description: 'Evaluation results with precision@5 metrics' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project role' })
  async evaluateRetrieval(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.checkProjectMembership(project.id, principal);
    const { loadEvalQueries } = await import('../retrieval/load-queries');
    const queries = loadEvalQueries();
    const projectQueries = queries.filter((q) => q.projectId === project.id);
    const summary = await this.evaluationService.runQueries(projectQueries);
    return JsonResponse.Ok(summary);
  }
}
