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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { RagService } from './rag.service';
import { AddDocumentDto } from './dto/add-document.dto';
import { SearchKbDto } from './dto/search-kb.dto';

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
    if (!project || project.deletedAt) throw new NotFoundAppException();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Req() req: any,
  ) {
    if (req.user?.extra?.role !== 'ADMIN') throw new ForbiddenAppException();
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

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Optimize the LanceDB table for a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Table optimized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async optimizeTable(
    @Param('slug') slug: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Req() req: any,
  ) {
    if (req.user?.extra?.role !== 'ADMIN') throw new ForbiddenAppException();
    const project = await this.resolveProject(slug);
    await this.ragService.optimizeTable(project.id);
    return JsonResponse.Ok({ optimized: true });
  }
}
