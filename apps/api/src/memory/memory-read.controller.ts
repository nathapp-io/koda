import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import type { IPageResult } from '@nathapp/nestjs-data';
import { MemoryGovernanceService } from './memory-governance.service';
import type { MemoryItem } from './memory-item-repository';
import { ListMemoryQuery } from './dto/list-memory.query';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { ProjectAccessService } from '../projects/project-access.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('memory')
@ApiBearerAuth()
@Controller('projects/:slug/memory')
export class MemoryReadController {
  constructor(
    private readonly governance: MemoryGovernanceService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get project memory items (paginated)' })
  @ApiResponse({ status: 200, description: 'Page of memory items: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 400, description: 'Invalid filter or paging parameter' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getMemory(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
    @Query() rawQuery: ListMemoryQuery,
  ): Promise<JsonResponse<IPageResult<MemoryItem>>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);
    await this.projectAccess.assertProjectMembership(projectId, principal);

    const { current, size, ...filters } = parseQuery(ListMemoryQuery, rawQuery);
    const page = await this.governance.getProjectMemory({ projectId, ...filters }, { current, size });
    return JsonResponse.Ok(toPageResult(page)) as JsonResponse<IPageResult<MemoryItem>>;
  }
}
