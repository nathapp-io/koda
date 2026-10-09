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
  UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectResponseDto } from './dto/project-response.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import {
  KodaPrincipal,
  isAgentPrincipal,
  isUserPrincipal,
} from '../auth/principal/koda-principal.types';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { AddProjectAgentDto } from '../agents/dto/add-project-agent.dto';
import { ProjectAgentDto } from '../agents/dto/agent-response.dto';
import { UpdateAgentDto } from '../agents/dto/update-agent.dto';
import { ActorRole } from '../common/enums';
import { ProjectMembershipGuard } from './project-membership.guard';
import { ProjectPermission } from './project-permission.decorator';
import { CurrentProject } from './current-project.decorator';
import { ProjectContext } from './project-context';

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
  @ApiOperation({ summary: 'List projects visible to the calling principal (excluding soft-deleted)' })
  @ApiResponse({ status: 200, description: 'List of projects' })
  async findAll(@Principal() principal: KodaPrincipal) {
    const data = await this.projectsService.findAllForPrincipal(principal);
    return JsonResponse.Ok(ProjectResponseDto.fromMany(data));
  }

  @Get(':slug')
  @UseGuards(ProjectMembershipGuard)
  @ApiOperation({ summary: 'Get a project by slug' })
  @ApiResponse({ status: 200, description: 'Project found' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.projectsService.findBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Get(':slug/ci-webhook-token')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Get the CI webhook HMAC secret (admin only)' })
  @ApiResponse({ status: 200, description: 'Token value' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getCiWebhookToken(@Param('slug') slug: string) {
    const ciWebhookToken = await this.projectsService.findCiWebhookToken(slug);
    return JsonResponse.Ok({ ciWebhookToken });
  }

  @Patch(':slug')
  @RequiredPermission('ADMIN')
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
  @ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
  @ApiQuery({ name: 'repoId', required: true })
  @ApiQuery({ name: 'commitHash', required: true })
  @ApiQuery({ name: 'changedFiles', required: true })
  @ApiQuery({ name: 'ticketId', required: false })
  @UseGuards(ProjectMembershipGuard)
  @ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])
  async getChangeImpact(
    @Query('repoId') repoId: string,
    @Query('commitHash') commitHash: string,
    @Query('changedFiles') changedFilesStr: string,
    @CurrentProject() ctx: ProjectContext,
    @Query('ticketId') ticketId?: string,
  ) {
    if (!repoId || !commitHash || !changedFilesStr) {
      throw new BadRequestException('Missing required query parameters: repoId, commitHash, changedFiles');
    }

    const changedFiles = changedFilesStr.split(',').map((f) => f.trim());

    const result = await this.impactAnalysisService.getChangeImpact({
      projectId: ctx.project.id,
      repoId,
      commitHash,
      changedFiles,
      ticketId,
    });

    return JsonResponse.Ok(result);
  }

  @Get(':slug/agents')
  @ApiOperation({ summary: 'List the project agent roster (admin or member; un-paged)' })
  @ApiResponse({ status: 200, description: 'Roster retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project access' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getProjectAgents(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.projectsService.findBySlug(slug);
    await this.projectsService.assertProjectMembership(project.id, principal);
    // Rostered agents may read their own roster without a ProjectMember row
    // (their project reach comes from the AgentProject table). assertProjectMembership
    // already admits them; we fall through to the list call either way.
    const data = await this.agentsService.listProjectRoster(slug);
    return JsonResponse.Ok(data);
  }

  @Post(':slug/agents')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard)
  @ApiOperation({ summary: 'Add an agent to the project roster (project or global admin)' })
  @ApiResponse({ status: 201, type: ProjectAgentDto, description: 'Agent added to the roster' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project admin role or global admin required' })
  @ApiResponse({ status: 404, description: 'Project or agent not found' })
  @ApiResponse({ status: 409, description: 'Agent is already on the roster, or is OFFLINE' })
  async addProjectAgent(
    @Param('slug') slug: string,
    @Body() addAgentDto: AddProjectAgentDto,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ) {
    await this.projectsService.assertProjectAdmin(ctx.project.id, principal);
    const data = await this.agentsService.addToProject(slug, addAgentDto.agentSlug, principal.id);
    return JsonResponse.Ok(data);
  }

  @Delete(':slug/agents/:agentSlug')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard)
  @ApiOperation({ summary: 'Remove an agent from the project roster (project or global admin)' })
  @ApiResponse({ status: 204, description: 'Agent removed from the roster' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project admin role or global admin required' })
  @ApiResponse({ status: 404, description: 'Project, agent or roster entry not found' })
  @ApiResponse({ status: 409, description: 'The agent still holds open tickets in this project' })
  async removeProjectAgent(
    @Param('slug') slug: string,
    @Param('agentSlug') agentSlug: string,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ): Promise<void> {
    await this.projectsService.assertProjectAdmin(ctx.project.id, principal);
    await this.agentsService.removeFromProject(slug, agentSlug);
  }

  @Patch(':slug/agents/:agentSlug')
  @UseGuards(ProjectMembershipGuard)
  @ApiOperation({ summary: 'Update an agent status within a project context (admin or the agent itself)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin or self only' })
  @ApiResponse({ status: 404, description: 'Project or agent not found' })
  async updateProjectAgent(
    @Param('slug') slug: string,
    @Param('agentSlug') agentSlug: string,
    @Body() updateDto: UpdateAgentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.projectsService.findBySlug(slug);
    // US-002: the target agent is resolved through the project roster, not the
    // ticket-derived list. An agent assigned tickets but absent from the roster
    // returns 404 — roster membership is the only thing this route mutates.
    const roster = await this.agentsService.listProjectRoster(slug);
    const target = roster.items.find((a) => a.slug === agentSlug);
    if (!target) {
      // US-002 AC12: an unrostered agent calling with its own API key is
      // refused (the guard would have already 403'd, but unit tests bypass the
      // guard and call the handler directly). A user principal asking for a
      // non-rostered agent gets 404 — there's nothing here for them.
      if (isAgentPrincipal(principal) && principal.slug === agentSlug) {
        throw new ForbiddenAppException({}, 'projectAgents');
      }
      throw new NotFoundAppException({}, 'projectAgents');
    }

    // H4: only global or project ADMINs may change agent state; an agent may
    // update only itself (graceful OFFLINE shutdown).
    const isAdmin =
      isUserPrincipal(principal) &&
      (principal.role === 'ADMIN' ||
        (await this.projectsService.findMembershipRole(project.id, principal.id)) === ActorRole.ADMIN);
    const isSelf = isAgentPrincipal(principal) && principal.slug === agentSlug;
    if (!isAdmin && !isSelf) {
      throw new ForbiddenAppException({}, 'projects');
    }

    const data = await this.agentsService.update(agentSlug, updateDto);
    return JsonResponse.Ok(data);
  }
}
