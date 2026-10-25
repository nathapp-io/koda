import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  Logger,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';
import { AstIndexService } from './ast-index.service';
import { IndexCommitDto } from './dto/index-commit.dto';
import { SearchSymbolsQueryDto } from './dto/search-symbols.dto';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { ProjectSlugFrom } from '../projects/project-slug-from.decorator';
import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectContext } from '../projects/project-context';
import { AuditRecorder } from '../audit/audit-recorder.service';

@ApiTags('code-intel')
@ApiBearerAuth()
@Controller('code-intel')
export class CodeIntelController {
  private readonly logger = new Logger(CodeIntelController.name);

  constructor(
    private readonly astIndexService: AstIndexService,
    private readonly audit: AuditRecorder,
  ) {}

  @Post('index')
  @HttpCode(201)
  @ApiOperation({ summary: 'Index a commit for AST symbol extraction' })
  @ApiResponse({ status: 201, description: 'Indexing completed' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @ProjectSlugFrom('body', 'projectSlug')
  @Requires('codeintel.index.write')
  async indexCommit(
    @Body() dto: IndexCommitDto,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const result = await this.astIndexService.indexCommit(
      dto.repoId,
      dto.commitHash,
      dto.files,
      ctx.project.id,
      (indexed) => this.audit.record({
        key: 'codeintel.index.write',
        resourceType: 'code-repo',
        resourceId: dto.repoId,
        projectId: ctx.project.id,
        summary: `indexed ${indexed.symbolsIndexed} symbols in ${indexed.filesIndexed} files`,
      }),
    );

    return JsonResponse.Ok(result);
  }

  @Get('symbols')
  @ApiOperation({ summary: 'Search symbols by name or file fragment' })
  @ApiResponse({ status: 200, description: 'Symbol search results' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @ProjectSlugFrom('query', 'projectSlug')
  @Requires('codeintel.read')
  async searchSymbols(
    @Query() query: SearchSymbolsQueryDto,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const { q, file, page = 1, limit: rawLimit = 20 } = query;
    const MAX_LIMIT = 100;
    const limit = Math.min(rawLimit, MAX_LIMIT);

    const { items, total } = await this.astIndexService.searchSymbols(ctx.project.id, { q, file, page, limit });
    return JsonResponse.Ok({ items, total });
  }

  @Get('symbols/:symbolId')
  @ApiOperation({ summary: 'Get a symbol by ID' })
  @ApiResponse({ status: 200, description: 'Symbol data' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Symbol not found' })
  @ApiQuery({ name: 'projectSlug', required: true, type: String })
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @ProjectSlugFrom('query', 'projectSlug')
  @Requires('codeintel.read')
  async getSymbol(
    @Param('symbolId') symbolId: string,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const data = await this.astIndexService.getSymbol(ctx.project.id, symbolId);
    if (!data) {
      throw new NotFoundAppException({}, 'code-intel');
    }
    return JsonResponse.Ok(data);
  }

  @Get('symbols/:symbolId/callers')
  @ApiOperation({ summary: 'Get callers of a symbol' })
  @ApiResponse({ status: 200, description: 'List of caller symbols' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiQuery({ name: 'projectSlug', required: true, type: String })
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @ProjectSlugFrom('query', 'projectSlug')
  @Requires('codeintel.read')
  async getCallers(
    @Param('symbolId') symbolId: string,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const data = await this.astIndexService.getCallers(ctx.project.id, symbolId);
    return JsonResponse.Ok(data);
  }

  @Get('symbols/:symbolId/callees')
  @ApiOperation({ summary: 'Get callees of a symbol' })
  @ApiResponse({ status: 200, description: 'List of callee symbols' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiQuery({ name: 'projectSlug', required: true, type: String })
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @ProjectSlugFrom('query', 'projectSlug')
  @Requires('codeintel.read')
  async getCallees(
    @Param('symbolId') symbolId: string,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const data = await this.astIndexService.getCallees(ctx.project.id, symbolId);
    return JsonResponse.Ok(data);
  }
}
