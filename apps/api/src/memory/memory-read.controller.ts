import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import type { IPageResult } from '@nathapp/nestjs-data';
import { MemoryGovernanceService } from './memory-governance.service';
import type { MemoryExportPage } from './memory-governance.service';
import type { MemoryItem } from './memory-item-repository';
import { ListMemoryQuery } from './dto/list-memory.query';
import { ExportMemoryQuery } from './dto/export-memory.query';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ownerTypeFor } from './memory-write.guard';
import { MemoryWriteModeService, type MemoryWriteMode } from './memory-write-mode.service';

/**
 * The project memory listing (permissions P1 US-008) and the incremental export of it (memory-notes
 * US-006).
 *
 * `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards` resolves `request.projectContext` — and refuses a
 * non-member — before `memory.read` is checked. The handler still resolves the slug, which is what answers 404 for an
 * unknown or soft-deleted project, and reads the caller (memory-notes US-005) so the page can include the caller's
 * own user-scoped notes next to the project's rows. The owner is built from `@Principal()` here and nowhere else, so
 * a query parameter can never name who is read.
 */
@ApiTags('memory')
@ApiBearerAuth()
@Controller('projects/:slug/memory')
export class MemoryReadController {
  constructor(
    private readonly governance: MemoryGovernanceService,
    private readonly projectAccess: ProjectAccessService,
    private readonly writeModeService: MemoryWriteModeService,
  ) {}

  @Get('write-mode')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('memory.read')
  @ApiOperation({ summary: 'Get the caller\'s effective memory.create write mode (memory.read)' })
  @ApiResponse({ status: 200, description: "Returns { mode: 'direct' | 'proposal', policyId: string | null, source: 'policy' | 'default' | 'not-approvable', agentPolicy: { id, mode } | null }" })
  @ApiResponse({ status: 403, description: 'memory.read is missing, or the caller is not a member' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async writeMode(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
  ): Promise<JsonResponse<MemoryWriteMode>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);
    return JsonResponse.Ok(await this.writeModeService.resolve(projectId, principal)) as JsonResponse<MemoryWriteMode>;
  }

  @Get('export')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('memory.read')
  @ApiOperation({ summary: 'Export memory changed after a cursor (memory.read)' })
  @ApiQuery({ name: 'since', required: false, description: 'Cursor of the last row already held' })
  @ApiQuery({ name: 'take', required: false, description: 'Rows to answer (1..500, default 100)' })
  @ApiResponse({
    status: 200,
    description: 'One page of changed rows: { items, nextCursor, hasMore }, every status and soft-deleted row included',
  })
  @ApiResponse({ status: 400, description: 'An unreadable since cursor, or a take outside 1..500' })
  @ApiResponse({ status: 403, description: 'memory.read is missing, or the caller is not a member' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async exportMemory(
    @Param('slug') slug: string,
    @Query() rawQuery: ExportMemoryQuery,
    @Principal() principal: KodaPrincipal,
  ): Promise<JsonResponse<MemoryExportPage>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);

    const { since, take } = parseQuery(ExportMemoryQuery, rawQuery);
    const owner = { ownerType: ownerTypeFor(principal), ownerId: principal.id };
    const page = await this.governance.exportProjectMemory(projectId, owner, since, take);
    return JsonResponse.Ok(page) as JsonResponse<MemoryExportPage>;
  }

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('memory.read')
  @ApiOperation({ summary: 'Get project memory items (paginated) (memory.read)' })
  @ApiResponse({ status: 200, description: 'Page of memory items: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 400, description: 'Invalid filter or paging parameter' })
  @ApiResponse({ status: 403, description: 'memory.read is missing, or the caller is not a member' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getMemory(
    @Param('slug') slug: string,
    @Query() rawQuery: ListMemoryQuery,
    @Principal() principal: KodaPrincipal,
  ): Promise<JsonResponse<IPageResult<MemoryItem>>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);

    const { current, size, ...filters } = parseQuery(ListMemoryQuery, rawQuery);
    const owner = { ownerType: ownerTypeFor(principal), ownerId: principal.id };
    const page = await this.governance.getProjectMemory({ projectId, ...filters, owner }, { current, size });
    return JsonResponse.Ok(toPageResult(page)) as JsonResponse<IPageResult<MemoryItem>>;
  }
}
