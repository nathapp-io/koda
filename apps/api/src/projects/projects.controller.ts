import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalRedeemHeader } from '../approvals/route/approval-redeem-header.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { PROJECT_ROUTE_VARIANTS } from './project-route.commands';
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
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal, isAgentPrincipal } from '../auth/principal/koda-principal.types';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { ProjectAgentListDto } from '../agents/dto/project-agent.dto';
import { UpdateAgentDto } from '../agents/dto/update-agent.dto';
import { PermissionService } from '../permissions/permission.service';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';
import { ProjectMembershipGuard } from './project-membership.guard';
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
    private permissions: PermissionService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('project.create')
  @ApprovalGated()
  @ApiOperation({ summary: 'Create a new project' })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'project.create is missing' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async create(@Body() createProjectDto: CreateProjectDto) {
    const dto = parseBody(CreateProjectDto, createProjectDto);
    const outcome = await this.routeGate.run<ProjectResponseDto>({
      key: 'project.create',
      variant: PROJECT_ROUTE_VARIANTS.create,
      projectId: null,
      input: dto,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('project.read', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'List projects visible to the calling principal (excluding soft-deleted)' })
  @ApiResponse({ status: 200, description: 'List of projects' })
  async findAll(@Principal() principal: KodaPrincipal) {
    // US-007: there is no resolved project on a global listing, so the access-filtered query below is
    // the enforcement — the route records the key instead of asking for it.
    const data = await this.projectsService.findAllForPrincipal(principal);
    return JsonResponse.Ok(ProjectResponseDto.fromMany(data));
  }

  @Get(':slug')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('project.read')
  @ApiOperation({ summary: 'Get a project by slug' })
  @ApiResponse({ status: 200, description: 'Project found' })
  @ApiResponse({ status: 403, description: 'Not a project member, or project.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.projectsService.findBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Get(':slug/ci-webhook-token')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('project.ci-token.read')
  @ApiOperation({ summary: 'Get the CI webhook HMAC secret' })
  @ApiResponse({ status: 200, description: 'Token value' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Not a project member, or project.ci-token.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getCiWebhookToken(@Param('slug') slug: string) {
    const ciWebhookToken = await this.projectsService.findCiWebhookToken(slug);
    return JsonResponse.Ok({ ciWebhookToken });
  }

  @Patch(':slug')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('project.update')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Update a project' })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Not a project member, or project.update is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async update(
    @Param('slug') slug: string,
    @Body() updateProjectDto: UpdateProjectDto,
    @CurrentProject() project: ProjectContext,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    const { slug: parsedSlug } = parseRouteInput({ slug }, ['slug']);
    const patch = parseBody(UpdateProjectDto, updateProjectDto ?? {});
    const secret = patch.ciWebhookToken !== undefined;
    const outcome = await this.routeGate.run<ProjectResponseDto>({
      key: 'project.update',
      variant: secret ? PROJECT_ROUTE_VARIANTS.updateCiToken : PROJECT_ROUTE_VARIANTS.update,
      projectId: project.project.id,
      input: { slug: parsedSlug, patch },
      ...(secret ? { redeem } : {}),
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':slug')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('project.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Soft delete a project' })
  @ApiResponse({ status: 204, description: 'Project soft deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Not a project member, or project.delete is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async remove(@Param('slug') slug: string, @CurrentProject() ctx: ProjectContext): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'project.delete',
      variant: PROJECT_ROUTE_VARIANTS.delete,
      projectId: ctx.project.id,
      input: { projectId: ctx.project.id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
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
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('codeintel.impact.read')
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
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('project.agent.read')
  @ApiOperation({ summary: 'List the project agent roster (any member; un-paged)' })
  @ApiResponse({ status: 200, type: ProjectAgentListDto, description: 'Roster retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Not a project member, or project.agent.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getProjectAgents(@Param('slug') slug: string) {
    const data = await this.agentsService.listProjectRoster(slug);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug/agents/:agentSlug')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  // US-007: whose status this is (self) and what the caller holds are only known here, so the guard
  // records the key and the handler decides.
  // US-001: the key is the global `agent.update` — the project-scoped `project.agent.update` is
  // folded into it, so a Project Admin no longer edits an agent's global record from here.
  @Requires('agent.update', { enforcedBy: 'service' })
  @ApprovalGated()
  @ApiOperation({ summary: 'Update an agent status within a project context (the global agent.update key, or the agent itself)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Not a project member, agent.update is missing and the caller is not the agent' })
  @ApiResponse({ status: 404, description: 'Project or agent not found' })
  async updateProjectAgent(
    @Param('slug') slug: string,
    @Param('agentSlug') agentSlug: string,
    @Body() updateDto: UpdateAgentDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() ctx: ProjectContext,
  ) {
    // US-002: the target agent is resolved through the project roster, not the
    // ticket-derived list. An agent assigned tickets but absent from the roster
    // returns 404 — roster membership is the only thing this route mutates.
    const onRoster = await this.agentsService.isOnProjectRosterBySlug(slug, agentSlug);
    if (!onRoster) {
      // US-002 AC12: an unrostered agent calling with its own API key is
      // refused (the guard would have already 403'd, but unit tests bypass the
      // guard and call the handler directly). A user principal asking for a
      // non-rostered agent gets 404 — there's nothing here for them.
      if (isAgentPrincipal(principal) && principal.slug === agentSlug) {
        throw new ForbiddenAppException({}, 'projectAgents');
      }
      throw new NotFoundAppException({}, 'projectAgents');
    }

    // Self shutdown is unconditional after roster validation and must never wait on approval.
    if (isAgentPrincipal(principal) && principal.slug === agentSlug) {
      return JsonResponse.Ok(await this.agentsService.update(agentSlug, updateDto));
    }

    // The action key is global; check it before entering the gate.
    if (!(await this.permissions.can(principal, 'agent.update')).allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }

    const patch = parseBody(UpdateAgentDto, updateDto ?? {});
    const identity = await this.agentsService.findRosteredAgentIdentity(slug, agentSlug);
    const outcome = await this.routeGate.run({
      key: 'agent.update',
      variant: PROJECT_ROUTE_VARIANTS.updateAgent,
      projectId: null,
      input: { slug, agentSlug, projectId: identity.projectId, agentId: identity.agentId, patch },
      keyCheck: false,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
