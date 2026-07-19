import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { AstIndexService } from './ast-index.service';
import { IndexCommitDto } from './dto/index-commit.dto';
import { SearchSymbolsQueryDto } from './dto/search-symbols.dto';
import { ProjectAccessService } from '../projects/project-access.service';

@ApiTags('code-intel')
@ApiBearerAuth()
@Controller('code-intel')
export class CodeIntelController {
  private readonly logger = new Logger(CodeIntelController.name);

  constructor(
    private readonly astIndexService: AstIndexService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  private async resolveProject(slug: string): Promise<{ id: string }> {
    // findProjectIdBySlug throws NotFoundAppException if missing or soft-deleted
    const id = await this.projectAccess.findProjectIdBySlug(slug);
    return { id };
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    // assertProjectMembership throws ForbiddenAppException when access is denied
    await this.projectAccess.assertProjectMembership(projectId, principal);
  }

  @Post('index')
  @HttpCode(201)
  @ApiOperation({ summary: 'Index a commit for AST symbol extraction' })
  @ApiResponse({ status: 201, description: 'Indexing completed' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @RequiredPermission([CaslPermissionAction.MANAGE, 'AstIndex'])
  async indexCommit(
    @Body() dto: IndexCommitDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(dto.projectSlug);
    await this.checkProjectMembership(project.id, principal);

    const result = await this.astIndexService.indexCommit(
      dto.repoId,
      dto.commitHash,
      dto.files,
      project.id,
    );

    return JsonResponse.Ok(result);
  }

  @Get('symbols')
  @ApiOperation({ summary: 'Search symbols by name or file fragment' })
  @ApiResponse({ status: 200, description: 'Symbol search results' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @RequiredPermission([CaslPermissionAction.READ, 'CodeIntel'])
  async searchSymbols(
    @Query() query: SearchSymbolsQueryDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const { projectSlug, q, file, page = 1, limit: rawLimit = 20 } = query;
    const MAX_LIMIT = 100;
    const limit = Math.min(rawLimit, MAX_LIMIT);

    const project = await this.resolveProject(projectSlug);
    await this.checkProjectMembership(project.id, principal);

    const { items, total } = await this.astIndexService.searchSymbols(project.id, { q, file, page, limit });
    return JsonResponse.Ok({ items, total });
  }

  @Get('symbols/:symbolId')
  @ApiOperation({ summary: 'Get a symbol by ID' })
  @ApiResponse({ status: 200, description: 'Symbol data' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Symbol not found' })
  @ApiQuery({ name: 'projectSlug', required: true })
  @RequiredPermission([CaslPermissionAction.READ, 'CodeIntel'])
  async getSymbol(
    @Param('symbolId') symbolId: string,
    @Query('projectSlug') projectSlug: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(projectSlug);
    await this.checkProjectMembership(project.id, principal);

    const data = await this.astIndexService.getSymbol(project.id, symbolId);
    if (!data) {
      throw new NotFoundAppException({}, 'code-intel');
    }
    return JsonResponse.Ok(data);
  }

  @Get('symbols/:symbolId/callers')
  @ApiOperation({ summary: 'Get callers of a symbol' })
  @ApiResponse({ status: 200, description: 'List of caller symbols' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiQuery({ name: 'projectSlug', required: true })
  @RequiredPermission([CaslPermissionAction.READ, 'CodeIntel'])
  async getCallers(
    @Param('symbolId') symbolId: string,
    @Query('projectSlug') projectSlug: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(projectSlug);
    await this.checkProjectMembership(project.id, principal);

    const data = await this.astIndexService.getCallers(project.id, symbolId);
    return JsonResponse.Ok(data);
  }

  @Get('symbols/:symbolId/callees')
  @ApiOperation({ summary: 'Get callees of a symbol' })
  @ApiResponse({ status: 200, description: 'List of callee symbols' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiQuery({ name: 'projectSlug', required: true })
  @RequiredPermission([CaslPermissionAction.READ, 'CodeIntel'])
  async getCallees(
    @Param('symbolId') symbolId: string,
    @Query('projectSlug') projectSlug: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(projectSlug);
    await this.checkProjectMembership(project.id, principal);

    const data = await this.astIndexService.getCallees(project.id, symbolId);
    return JsonResponse.Ok(data);
  }
}
