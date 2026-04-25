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
import { CurrentActor, CurrentUser } from '../auth/decorators/current-user.decorator';

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
    currentUser: { id?: string; extra?: { role?: string; sub?: string } } | null,
    actorType?: string,
  ): Promise<void> {
    if (!currentUser) {
      throw new ForbiddenAppException({}, 'rag');
    }

    // Agent API key auth: agents are cross-project (their API key is their credential).
    // actorType is set to 'agent' by CombinedAuthGuard when an API key is used.
    // We rely on actorType, not the absence of extra.sub, to keep this explicit
    // and resilient to future actor model changes.
    if (actorType === 'agent') {
      return;
    }

    if (!currentUser.extra?.sub) {
      throw new ForbiddenAppException({}, 'rag');
    }

    const membership = await this.db.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId: currentUser.extra.sub,
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
  async deleteDocument(
    @Param('slug') slug: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() currentUser: { extra?: { role?: string } } | null,
  ) {
    if (currentUser?.extra?.role !== 'ADMIN') throw new ForbiddenAppException({}, 'rag');
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
    @CurrentActor() { currentUser, actorType }: { currentUser: { id?: string; extra?: { role?: string; sub?: string } } | null; actorType?: string },
  ) {
    const project = await this.resolveProject(slug);
    await this.checkProjectMembership(project.id, currentUser, actorType);

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
  @ApiOperation({ summary: 'Import graphify knowledge graph into the project knowledge base (admin only)' })
  @ApiResponse({ status: 200, description: 'Import successful' })
  @ApiResponse({ status: 400, description: 'Graphify not enabled for this project or validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async importGraphify(
    @Param('slug') slug: string,
    @Body() dto: ImportGraphifyDto,
    @CurrentUser() currentUser: { extra?: { role?: string } } | null,
  ) {
    if (currentUser?.extra?.role !== 'ADMIN') throw new ForbiddenAppException({}, 'rag');
    const project = await this.resolveProject(slug);
    if (!project.graphifyEnabled) throw new ValidationAppException({}, 'rag.graphifyDisabled');
    if (dto.nodes.length === 0) return JsonResponse.Ok({ imported: 0, cleared: 0 });
    const result = await this.db.$transaction(async (tx) => {
      const importResult = await this.ragService.importGraphify(project.id, dto.nodes, dto.links ?? []);
      await tx.project.update({
        where: { id: project.id },
        data: { graphifyLastImportedAt: new Date() },
      });
      return importResult;
    });
    return JsonResponse.Ok(result);
  }

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Optimize the LanceDB table for a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Table optimized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async optimizeTable(
    @Param('slug') slug: string,
    @CurrentUser() currentUser: { extra?: { role?: string } } | null,
  ) {
    if (currentUser?.extra?.role !== 'ADMIN') throw new ForbiddenAppException({}, 'rag');
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
    @CurrentActor() { currentUser, actorType }: { currentUser: { id?: string; extra?: { role?: string; sub?: string } } | null; actorType?: string },
  ) {
    const project = await this.resolveProject(slug);
    await this.checkProjectMembership(project.id, currentUser, actorType);
    const { loadEvalQueries } = await import('../retrieval/load-queries');
    const queries = loadEvalQueries();
    const projectQueries = queries.filter((q) => q.projectId === project.id);
    const summary = await this.evaluationService.runQueries(projectQueries);
    return JsonResponse.Ok(summary);
  }
}
