import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { MemoryGovernanceService } from './memory-governance.service';
import type { MemoryItem } from './memory-item-repository';
import { ListMemoryQuery } from './dto/list-memory.query';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';

/**
 * The project memory listing (permissions P1 US-008).
 *
 * `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards` resolves `request.projectContext` — and refuses a
 * non-member — before `memory.read` is checked, so the handler no longer asserts membership itself and needs no
 * principal of its own. The handler still resolves the slug, which is what answers 404 for an unknown or
 * soft-deleted project.
 */
@ApiTags('memory')
@ApiBearerAuth()
@Controller('projects/:slug/memory')
export class MemoryReadController {
  constructor(
    private readonly governance: MemoryGovernanceService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

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
  ): Promise<JsonResponse<IPageResult<MemoryItem>>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);

    const { current, size, ...filters } = parseQuery(ListMemoryQuery, rawQuery);
    const page = await this.governance.getProjectMemory({ projectId, ...filters }, { current, size });
    return JsonResponse.Ok(toPageResult(page)) as JsonResponse<IPageResult<MemoryItem>>;
  }
}
