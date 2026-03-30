import { Controller, Post, Get, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { AgentsService, CreateAgentDto } from './agents.service';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateCapabilitiesDto } from './dto/update-capabilities.dto';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { CurrentUser, CurrentActor } from '../auth/decorators/current-user.decorator';

@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private agentsService: AgentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create agent and generate API key (admin only)' })
  @ApiResponse({ status: 201, description: 'Agent created with API key' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  async generateApiKey(@Body() createAgentDto: CreateAgentDto, @CurrentUser() currentUser: { extra?: { role?: string } } | null) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'agents');
    }

    const data = await this.agentsService.generateApiKey(createAgentDto);
    return JsonResponse.Ok(data);
  }

  @Get()
  @ApiOperation({ summary: 'List all agents' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  async findAll() {
    const data = await this.agentsService.findAll();
    return JsonResponse.Ok(data);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current agent profile (API key auth)' })
  @ApiResponse({ status: 200, description: 'Agent profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async findMe(@CurrentActor() actor: { currentUser: { id?: string } | null; actorType: 'user' | 'agent' | undefined }) {
    const id = actor.currentUser?.id;
    if (!id || (actor.actorType !== 'agent' && actor.actorType !== 'user')) {
      throw new ForbiddenAppException({}, 'agents');
    }
    const data = await this.agentsService.findMe(id);
    return JsonResponse.Ok(data);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get agent by slug' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.agentsService.findBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Get(':slug/pickup')
  @ApiOperation({ summary: 'Suggest a ticket for the agent to pick up' })
  @ApiQuery({ name: 'project', required: true, description: 'Project slug' })
  @ApiResponse({ status: 200, description: 'Suggested ticket or null' })
  @ApiResponse({ status: 400, description: 'Missing project query param' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async suggestTicket(@Param('slug') slug: string, @Query('project') project: string) {
    if (!project) {
      throw new ValidationAppException({}, 'agents');
    }
    const data = await this.agentsService.suggestTicket(slug, project);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update agent (admin only)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async update(@Param('slug') slug: string, @Body() updateDto: UpdateAgentDto, @CurrentUser() currentUser: { extra?: { role?: string } } | null) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'agents');
    }
    const data = await this.agentsService.update(slug, updateDto);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug/update-roles')
  @ApiOperation({ summary: 'Update agent roles (admin only)' })
  @ApiResponse({ status: 200, description: 'Roles updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateRoles(@Param('slug') slug: string, @Body() updateRolesDto: UpdateRolesDto, @CurrentUser() currentUser: { extra?: { role?: string } } | null) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'agents');
    }
    const agent = await this.agentsService.findBySlug(slug);
    const data = await this.agentsService.updateRoles(agent.id, updateRolesDto);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug/update-capabilities')
  @ApiOperation({ summary: 'Update agent capabilities (admin only)' })
  @ApiResponse({ status: 200, description: 'Capabilities updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateCapabilities(@Param('slug') slug: string, @Body() updateCapabilitiesDto: UpdateCapabilitiesDto, @CurrentUser() currentUser: { extra?: { role?: string } } | null) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'agents');
    }
    const agent = await this.agentsService.findBySlug(slug);
    const data = await this.agentsService.updateCapabilities(agent.id, updateCapabilitiesDto);
    return JsonResponse.Ok(data);
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete (soft-delete) an agent' })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async remove(@Param('slug') slug: string, @CurrentUser() currentUser: { extra?: { role?: string } } | null) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'agents');
    }
    const data = await this.agentsService.remove(slug);
    return JsonResponse.Ok(data);
  }

  @Post(':slug/rotate-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate agent API key (admin only)' })
  @ApiResponse({ status: 200, description: 'API key rotated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async rotateApiKey(@Param('slug') slug: string, @CurrentUser() currentUser: { extra?: { role?: string } } | null) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'agents');
    }
    const data = await this.agentsService.rotateApiKey(slug);
    return JsonResponse.Ok(data);
  }
}
