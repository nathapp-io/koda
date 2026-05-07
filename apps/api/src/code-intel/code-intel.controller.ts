import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { AstIndexService } from './ast-index.service';
import { IndexCommitDto } from './dto/index-commit.dto';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { Logger, NotFoundException } from '@nestjs/common';

@ApiTags('code-intel')
@ApiBearerAuth()
@Controller('code-intel')
export class CodeIntelController {
  private readonly logger = new Logger(CodeIntelController.name);

  constructor(
    private readonly astIndexService: AstIndexService,
    @Optional() private readonly prisma?: PrismaService<PrismaClient>,
  ) {}

  private get db() {
    if (!this.prisma) {
      throw new Error('PrismaService is not available');
    }
    return this.prisma.client;
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'code-intel');
    }

    if (isAgentPrincipal(principal)) {
      return;
    }

    if (!isUserPrincipal(principal)) {
      throw new ForbiddenAppException({}, 'code-intel');
    }

    if (principal.role === 'ADMIN') {
      return;
    }

    const membership = await this.db.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId: principal.id,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenAppException({}, 'code-intel');
    }
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
    const project = await this.db.project.findUnique({
      where: { slug: dto.projectSlug },
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${dto.projectSlug}`);
    }
    await this.checkProjectMembership(project.id, principal);

    const result = await this.astIndexService.indexCommit(
      dto.repoId,
      dto.commitHash,
      dto.files,
      project.id,
    );

    return JsonResponse.Ok(result);
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
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectSlug}`);
    }
    await this.checkProjectMembership(project.id, principal);

    const data = await this.astIndexService.getSymbol(project.id, symbolId);
    if (!data) {
      throw new NotFoundException(`Symbol not found: ${symbolId}`);
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
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectSlug}`);
    }
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
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectSlug}`);
    }
    await this.checkProjectMembership(project.id, principal);

    const data = await this.astIndexService.getCallees(project.id, symbolId);
    return JsonResponse.Ok(data);
  }
}
