import { ProjectNotFoundPrefix } from '../projects/project-not-found-prefix.decorator';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { KbDocumentDeletion } from './kb-document-deletion.service';
import { KB_ROUTE_VARIANTS } from './kb-route.commands';
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
import { Principal } from '@nathapp/nestjs-auth';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { AddDocumentDto } from './dto/add-document.dto';
import { DeleteKbDocumentQuery } from './dto/delete-kb-document.query';
import { SearchKbDto } from './dto/search-kb.dto';
import { ImportGraphifyDto } from './dto/import-graphify.dto';
import { ListKbDocumentsQuery } from './dto/list-kb-documents.query';
import { parseQuery } from '../common/dto/koda-page.query';
import { PrismaRagRepository } from './prisma-rag.repository';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { AuditRecorder } from '../audit/audit-recorder.service';

/**
 * The project knowledge base (permissions P1 US-007).
 *
 * Every route declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`, so the membership guard
 * resolves `request.projectContext` — and refuses a non-member — before the key check. There is no
 * `@ProjectRoles` and no `@RequiredPermission` left: the key decides, so an agent holding `kb.document.add`
 * writes as readily as a Developer.
 *
 * The two write routes carry row ownership on top of their key:
 *  - `add` replaces the rows of one `(source, sourceId)` pair, so it must not overwrite a row someone else —
 *    or the system — created. `kb.document.delete` without a resource answers "may delete any row"; a caller
 *    holding only `kb.document.delete.own` is refused with 403 before anything is written.
 *  - `delete` asks the same key per matching row, with that row's creator as the resource. One refusal leaves
 *    every chosen source intact.
 */
@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly hybridRetrieverService: HybridRetrieverService,
    private readonly ragRepository: PrismaRagRepository,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
    private readonly kbDeletion: KbDocumentDeletion,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  private async resolveProject(slug: string) {
    const project = await this.ragRepository.findProjectBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'rag');
    return project;
  }

  @Post('documents')
  @ApprovalGated()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.document.add')
  @ApiOperation({ summary: 'Add a document to the project knowledge base (kb.document.add)' })
  @ApiResponse({ status: 201, description: 'Document indexed' })
  @ApiResponse({ status: 400, description: 'Source is not doc or manual, or the id is not filter-safe' })
  @ApiResponse({ status: 403, description: 'kb.document.add is missing, or the replaced row is not the caller\'s' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async addDocument(
    @Param('slug') slug: string,
    @Body() dto: AddDocumentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    const outcome = await this.routeGate.run({
      key: 'kb.document.add', variant: KB_ROUTE_VARIANTS.add, projectId: project.id,
      input: { slug, projectId: project.id, document: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Get('documents')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.read')
  @ApiOperation({ summary: 'List indexed documents in the project knowledge base (kb.read)' })
  @ApiResponse({ status: 200, description: 'Documents listed' })
  @ApiResponse({ status: 400, description: 'Invalid limit' })
  @ApiResponse({ status: 403, description: 'kb.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listDocuments(
    @Param('slug') slug: string,
    @Query() rawQuery?: ListKbDocumentsQuery,
  ) {
    const project = await this.resolveProject(slug);
    const { limit } = parseQuery(ListKbDocumentsQuery, rawQuery ?? {});
    const data = await this.ragService.listDocuments(project.id, limit);
    return JsonResponse.Ok(data);
  }

  @Delete('documents/:sourceId')
  @ProjectNotFoundPrefix('rag')
  @ApprovalGated()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.document.delete')
  @ApiOperation({ summary: 'Delete the user rows of a sourceId (kb.document.delete, row ownership)' })
  @ApiResponse({ status: 200, description: 'Delete documents by sourceId' })
  @ApiResponse({ status: 400, description: 'source is not doc or manual, or the id is not filter-safe' })
  @ApiResponse({ status: 403, description: 'kb.document.delete is missing, or a matching row is not the caller\'s' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async deleteDocument(
    @Param('slug') slug: string,
    @Param('sourceId') sourceId: string,
    @Query() query: DeleteKbDocumentQuery,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.kbDeletion.preflight(principal, project.id, sourceId, query.source);
    const outcome = await this.routeGate.run<{ deleted: boolean }>({
      key: 'kb.document.delete', variant: KB_ROUTE_VARIANTS.delete, projectId: project.id,
      input: { projectId: project.id, sourceId, ...(query.source ? { source: query.source } : {}) },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.search')
  @ApiOperation({ summary: 'Hybrid search the project knowledge base (kb.search)' })
  @ApiResponse({ status: 200, description: 'Search results with RRF merge and similarity tiers' })
  @ApiResponse({ status: 403, description: 'kb.search is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async search(
    @Param('slug') slug: string,
    @Body() dto: SearchKbDto,
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
  @ApprovalGated()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.graphify.import')
  @ApiOperation({ summary: 'Import graphify knowledge graph into the project knowledge base (kb.graphify.import)' })
  @ApiResponse({ status: 200, description: 'Import successful' })
  @ApiResponse({ status: 400, description: 'Graphify not enabled for this project or validation error' })
  @ApiResponse({ status: 403, description: 'kb.graphify.import is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async importGraphify(
    @Param('slug') slug: string,
    @Body() dto: ImportGraphifyDto,
  ) {
    const project = await this.resolveProject(slug);
    if (!project.graphifyEnabled) throw new ValidationAppException({}, 'rag.graphifyDisabled');
    if (dto.nodes.length === 0) return JsonResponse.Ok({ imported: 0, cleared: 0 });

    const outcome = await this.routeGate.run<{ imported: number; cleared: number }>({
      key: 'kb.graphify.import', variant: KB_ROUTE_VARIANTS.graphifyImport, projectId: project.id,
      input: { slug, projectId: project.id, graph: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('optimize')
  @ApprovalGated()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.optimize')
  @ApiOperation({ summary: 'Optimize the LanceDB table for a project (kb.optimize)' })
  @ApiResponse({ status: 200, description: 'Table optimized' })
  @ApiResponse({ status: 403, description: 'kb.optimize is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async optimizeTable(@Param('slug') slug: string) {
    const project = await this.resolveProject(slug);
    const outcome = await this.routeGate.run<{ optimized: boolean }>({
      key: 'kb.optimize', variant: KB_ROUTE_VARIANTS.optimize, projectId: project.id,
      input: { slug, projectId: project.id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
