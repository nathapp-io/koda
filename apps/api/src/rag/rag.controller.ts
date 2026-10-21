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
import { ForbiddenAppException, JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { isRunnerPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { AddDocumentDto } from './dto/add-document.dto';
import { DeleteKbDocumentQuery, KB_DELETE_SOURCES, type KbDeleteSource } from './dto/delete-kb-document.query';
import { SearchKbDto } from './dto/search-kb.dto';
import { ImportGraphifyDto } from './dto/import-graphify.dto';
import { ListKbDocumentsQuery } from './dto/list-kb-documents.query';
import { parseQuery } from '../common/dto/koda-page.query';
import { PrismaRagRepository } from './prisma-rag.repository';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import type { KbCreator } from './kb-creator';

/** The KB creator an authenticated principal writes: trusted token data, never the request body. */
function kbCreator(principal: KodaPrincipal): KbCreator {
  // A runner never authors a domain record; the auth guard does not let one reach this route either.
  if (isRunnerPrincipal(principal)) throw new ForbiddenAppException({}, 'permissions');
  return { type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id };
}

/** Whether a stored creator is the caller's own. A row with no creator (`null`) belongs to the system. */
function isOwnRow(createdBy: KbCreator | null, caller: KbCreator): boolean {
  return createdBy !== null && createdBy.type === caller.type && createdBy.id === caller.id;
}

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
  ) {}

  private async resolveProject(slug: string) {
    const project = await this.ragRepository.findProjectBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'rag');
    return project;
  }

  /**
   * `kb.document.delete` with no resource: true only for a caller that may delete *any* row of the project.
   * A `.own`-only holder answers `not-owner`, which is exactly the "someone else's row" refusal.
   */
  private async mayDeleteAnyRow(principal: KodaPrincipal, projectId: string): Promise<boolean> {
    return (await this.permissions.can(principal, 'kb.document.delete', { projectId })).allowed;
  }

  private async assertMayDeleteRow(
    principal: KodaPrincipal,
    projectId: string,
    createdBy: KbCreator | null,
  ): Promise<void> {
    const decision = await this.permissions.can(principal, 'kb.document.delete', {
      projectId,
      resource: { createdBy },
    });
    if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
  }

  @Post('documents')
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
    const creator = kbCreator(principal);

    // Replace check: the write deletes the rows of this pair first. A row the caller did not create — including a
    // system row with no creator — needs the any-row delete key, so a `.own` holder cannot overwrite it. Reads an
    // unsafe source or sourceId throw ValidationAppException (400) before anything is written.
    const existingCreators = await this.ragService.findSourceCreators(project.id, dto.source, dto.sourceId);
    const replacesAnotherRow = existingCreators.some((createdBy) => !isOwnRow(createdBy, creator));
    if (replacesAnotherRow && !(await this.mayDeleteAnyRow(principal, project.id))) {
      throw new ForbiddenAppException({}, 'permissions');
    }

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
      createdBy: creator,
    });
    if (id === null) return JsonResponse.Ok({ indexed: false, sourceId: dto.sourceId });
    return JsonResponse.Ok({ indexed: true, id, sourceId: dto.sourceId });
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
    // US-006 keyed the rows by `(source, sourceId)`; this route names the user sources only. An absent `source`
    // keeps its interim meaning — delete both user rows of this id — and never touches the ticket or code rows.
    const sources: KbDeleteSource[] = query.source ? [query.source] : [...KB_DELETE_SOURCES];

    // Preflight every chosen source before deleting either one: a refusal must leave both rows in place. The read
    // also answers ValidationAppException (400) for an id that is not filter-safe, before any write happens.
    const creatorsBySource = await Promise.all(
      sources.map((source) => this.ragService.findSourceCreators(project.id, source, sourceId)),
    );
    await Promise.all(
      creatorsBySource
        .flat()
        .map((createdBy) => this.assertMayDeleteRow(principal, project.id, createdBy)),
    );

    for (const source of sources) {
      await this.ragService.deleteBySource(project.id, source, sourceId);
    }
    return JsonResponse.Ok({ deleted: true });
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

    const importResult = await this.ragService.importGraphify(project.id, dto.nodes, dto.links ?? []);

    return JsonResponse.Ok(importResult);
  }

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('kb.optimize')
  @ApiOperation({ summary: 'Optimize the LanceDB table for a project (kb.optimize)' })
  @ApiResponse({ status: 200, description: 'Table optimized' })
  @ApiResponse({ status: 403, description: 'kb.optimize is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async optimizeTable(@Param('slug') slug: string) {
    const project = await this.resolveProject(slug);
    await this.ragService.optimizeTable(project.id);
    return JsonResponse.Ok({ optimized: true });
  }
}
