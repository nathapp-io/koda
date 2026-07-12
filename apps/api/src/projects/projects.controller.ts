import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { AgentsService } from '../agents/agents.service';
import { UpdateAgentDto } from '../agents/dto/update-agent.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private projectsService: ProjectsService,
    private impactAnalysisService: ImpactAnalysisService,
    private agentsService: AgentsService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Create a new project (admin only)' })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async create(@Body() createProjectDto: CreateProjectDto) {
    const data = await this.projectsService.create(createProjectDto);
    return JsonResponse.Ok(data);
  }

  @Get()
  @ApiOperation({ summary: 'List all projects (excluding soft-deleted)' })
  @ApiResponse({ status: 200, description: 'List of projects' })
  async findAll() {
    const data = await this.projectsService.findAll();
    return JsonResponse.Ok(data);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a project by slug' })
  @ApiResponse({ status: 200, description: 'Project found' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.projectsService.findBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async update(
    @Param('slug') slug: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    const data = await this.projectsService.update(slug, updateProjectDto);
    return JsonResponse.Ok(data);
  }

  @Delete(':slug')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Soft delete a project (admin only)' })
  @ApiResponse({ status: 204, description: 'Project soft deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async remove(@Param('slug') slug: string): Promise<void> {
    await this.projectsService.softDelete(slug);
  }

  @Get(':slug/codeintel/impact')
  @ApiOperation({ summary: 'Get change impact analysis for a commit' })
  @ApiResponse({
    status: 200,
    description: 'Change impact analysis result',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiQuery({ name: 'repoId', required: true })
  @ApiQuery({ name: 'commitHash', required: true })
  @ApiQuery({ name: 'changedFiles', required: true })
  @ApiQuery({ name: 'ticketId', required: false })
  @RequiredPermission([KodaAction.READ as CaslPermissionAction, 'CodeIntel'])
  async getChangeImpact(
    @Param('slug') slug: string,
    @Query('repoId') repoId: string,
    @Query('commitHash') commitHash: string,
    @Query('changedFiles') changedFilesStr: string,
    @Principal() principal: KodaPrincipal,
    @Query('ticketId') ticketId?: string,
  ) {
    if (!repoId || !commitHash || !changedFilesStr) {
      throw new BadRequestException('Missing required query parameters: repoId, commitHash, changedFiles');
    }

    const project = await this.projectsService.findBySlug(slug);
    await this.projectsService.assertProjectMembership(project.id, principal);

    const changedFiles = changedFilesStr.split(',').map((f) => f.trim());

    const result = await this.impactAnalysisService.getChangeImpact({
      projectId: project.id,
      repoId,
      commitHash,
      changedFiles,
      ticketId,
    });

    return JsonResponse.Ok(result);
  }

  @Get(':slug/agents')
  @ApiOperation({ summary: 'List agents active in a project (derived from assigned tickets)' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project access' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getProjectAgents(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.projectsService.findBySlug(slug);
    await this.projectsService.assertProjectMembership(project.id, principal);
    const data = await this.agentsService.findByProject(slug);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug/agents/:agentSlug')
  @ApiOperation({ summary: 'Update an agent status within a project context (admin or project member)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project access' })
  @ApiResponse({ status: 404, description: 'Project or agent not found' })
  async updateProjectAgent(
    @Param('slug') slug: string,
    @Param('agentSlug') agentSlug: string,
    @Body() updateDto: UpdateAgentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.projectsService.findBySlug(slug);
    await this.projectsService.assertProjectMembership(project.id, principal);
    const projectAgents = await this.agentsService.findByProject(slug);
    if (!projectAgents.some((a) => a.slug === agentSlug)) {
      throw new NotFoundAppException({}, 'agents');
    }
    const data = await this.agentsService.update(agentSlug, updateDto);
    return JsonResponse.Ok(data);
  }
}
