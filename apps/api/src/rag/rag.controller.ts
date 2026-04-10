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
import { AddDocumentDto } from './dto/add-document.dto';
import { SearchKbDto } from './dto/search-kb.dto';
import { ImportGraphifyDto } from './dto/import-graphify.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  private get db() { return this.prisma.client; }

  private async resolveProject(slug: string) {
    const project = await this.db.project.findUnique({ where: { slug } });
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'rag');
    return project;
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
    await this.ragService.indexDocument(project.id, {
      source: dto.source,
      sourceId: dto.sourceId,
      content: dto.content,
      metadata: dto.metadata ?? {},
    });
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
  @ApiResponse({ status: 404, description: 'Project not found' })
  async search(
    @Param('slug') slug: string,
    @Body() dto: SearchKbDto,
  ) {
    const project = await this.resolveProject(slug);
    const data = await this.ragService.search(project.id, dto.query, dto.limit ?? 5);
    return JsonResponse.Ok(data);
  }

  @Post('import/graphify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Import graphify knowledge base nodes and links (admin only)' })
  @ApiResponse({ status: 200, description: 'Import result with imported and cleared counts' })
  @ApiResponse({ status: 400, description: 'Graphify is disabled for this project' })
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
    const result = await this.ragService.importGraphify(project.id, dto.nodes, dto.links ?? []);
    await this.db.project.update({
      where: { id: project.id },
      data: { graphifyLastImportedAt: new Date() },
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
}
