import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { MemoryGovernanceService } from './memory-governance.service';
import type { MemoryItem, ProjectMemoryQuery } from './memory-item-repository';
import { ProjectAccessService } from '../projects/project-access.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

interface MemoryPageResult {
  items: MemoryItem[];
  total: number;
}

@ApiTags('memory')
@ApiBearerAuth()
@Controller('projects/:slug/memory')
export class MemoryReadController {
  constructor(
    private readonly governance: MemoryGovernanceService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  private parseIntParam(value: string | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new ValidationAppException({ [field]: `Invalid ${field}` });
    }
    return parsed;
  }

  @Get()
  @ApiOperation({ summary: 'Get project memory items' })
  @ApiResponse({ status: 200, description: 'Project memory items' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getMemory(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
    @Query('kind') kind?: string,
    @Query('subject') subject?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: string,
  ): Promise<JsonResponse<MemoryPageResult>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);
    await this.projectAccess.assertProjectMembership(projectId, principal);

    const query: ProjectMemoryQuery = {
      projectId,
      ...(kind !== undefined && { kind: kind as ProjectMemoryQuery['kind'] }),
      ...(subject !== undefined && { subject }),
      ...(status !== undefined && { status }),
      ...(page !== undefined && { page: this.parseIntParam(page, 'page') }),
      ...(limit !== undefined && { limit: this.parseIntParam(limit, 'limit') }),
      ...(orderBy !== undefined && { orderBy: orderBy as ProjectMemoryQuery['orderBy'] }),
    };

    const MAX_LIMIT = 50;
    const result = await this.governance.getProjectMemory(query);
    const items = result.items.slice(0, MAX_LIMIT);
    return JsonResponse.Ok({ items, total: result.total }) as JsonResponse<MemoryPageResult>;
  }
}
