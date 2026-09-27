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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { AddDocumentDto } from './dto/add-document.dto';
import { SearchKbDto } from './dto/search-kb.dto';
import { ImportGraphifyDto } from './dto/import-graphify.dto';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import type { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { PrismaRagRepository } from './prisma-rag.repository';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { ProjectRoles } from '../projects/project-roles.decorator';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
@UseGuards(ProjectMembershipGuard)
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly hybridRetrieverService: HybridRetrieverService,
    private readonly ragRepository: PrismaRagRepository,
  ) {}

  private async resolveProject(slug: string) {
    const project = await this.ragRepository.findProjectBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'rag');
    return project;
  }

  @Post('documents')
  @ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')
  @ApiOperation({ summary: 'Add a document to the project knowledge base' })
  @ApiResponse({ status: 201, description: 'Document indexed' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async addDocument(
    @Param('slug') slug: string,
    @Body() dto: AddDocumentDto,
    @Principal() _principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    // H7: single write path. Previously this ran Promise.all over
    // RagService.indexDocument AND HybridRetrieverService.indexDocument, which
    // double-indexed every document into the shared project table (duplicate
    // search results, cross-service first-write race, deletes that never
    // reached Hybrid's in-memory store). Index once via RagService
    // (VectorStore.indexDocument); HybridRetriever reads the same row through
    // the shared LanceTableManager.
    const id = await this.ragService.indexDocument(project.id, {
      source: dto.source,
      sourceId: dto.sourceId,
      content: dto.content,
      metadata: dto.metadata ?? {},
    });
    if (id === null) return JsonResponse.Ok({ indexed: false, sourceId: dto.sourceId });
    return JsonResponse.Ok({ indexed: true, id, sourceId: dto.sourceId });
  }

  @Get('documents')
  @ApiOperation({ summary: 'List indexed documents in the project knowledge base' })
  @ApiResponse({ status: 200, description: 'Documents listed' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listDocuments(
    @Param('slug') slug: string,
    @Principal() _principal: KodaPrincipal,
    @Query('limit') limitStr?: string,
  ) {
    const project = await this.resolveProject(slug);
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 500) : 100;
    const data = await this.ragService.listDocuments(project.id, limit);
    return JsonResponse.Ok(data);
  }

  @Delete('documents/:sourceId')
  @HttpCode(HttpStatus.OK)
  @ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')
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
    @Principal() _principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);

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
  @ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')
  @ApiOperation({ summary: 'Import graphify knowledge graph into the project knowledge base' })
  @ApiResponse({ status: 200, description: 'Import successful' })
  @ApiResponse({ status: 400, description: 'Graphify not enabled for this project or validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission([KodaAction.IMPORT as CaslPermissionAction, 'CodeIntel'])
  async importGraphify(
    @Param('slug') slug: string,
    @Body() dto: ImportGraphifyDto,
    @Principal() _principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    if (!project.graphifyEnabled) throw new ValidationAppException({}, 'rag.graphifyDisabled');
    if (dto.nodes.length === 0) return JsonResponse.Ok({ imported: 0, cleared: 0 });

    const importResult = await this.ragService.importGraphify(project.id, dto.nodes, dto.links ?? []);

    return JsonResponse.Ok(importResult);
  }

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')
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
}
