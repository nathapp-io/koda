import { Controller, Post, Get, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { AgentsService, CreateAgentDto } from './agents.service';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateCapabilitiesDto } from './dto/update-capabilities.dto';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private agentsService: AgentsService) {}


  // Public methods for testing (called directly in tests)
  async createAgent(createAgentDto: CreateAgentDto, _principal?: KodaPrincipal) {
    return this.agentsService.generateApiKey(createAgentDto);
  }

  async listAll() {
    return this.agentsService.findAll();
  }

  async getMe(principal: KodaPrincipal) {
    if (principal.actorType !== 'agent') {
      throw new ForbiddenAppException({}, 'agents');
    }
    return this.agentsService.findMe(principal.id);
  }

  async getBySlug(slug: string) {
    return this.agentsService.findBySlug(slug);
  }

  async pickupTicket(slug: string, project: string) {
    if (!project) {
      throw new ValidationAppException({}, 'agents');
    }
    return this.agentsService.suggestTicket(slug, project);
  }

  async updateAgent(slug: string, updateDto: UpdateAgentDto, _principal?: KodaPrincipal) {
    return this.agentsService.update(slug, updateDto);
  }

  async updateAgentRoles(slug: string, updateRolesDto: UpdateRolesDto, _principal?: KodaPrincipal) {
    const agent = await this.agentsService.findBySlug(slug);
    return this.agentsService.updateRoles(agent.id, updateRolesDto);
  }

  async updateAgentCapabilities(slug: string, updateCapabilitiesDto: UpdateCapabilitiesDto, _principal?: KodaPrincipal) {
    const agent = await this.agentsService.findBySlug(slug);
    return this.agentsService.updateCapabilities(agent.id, updateCapabilitiesDto);
  }

  async deleteAgent(slug: string, _principal?: KodaPrincipal) {
    return this.agentsService.remove(slug);
  }

  async rotateKey(slug: string, _principal?: KodaPrincipal) {
    return this.agentsService.rotateApiKey(slug);
  }

  // HTTP route handlers
  @Post()
  @ApiOperation({ summary: 'Create agent and generate API key (admin only)' })
  @ApiResponse({ status: 201, description: 'Agent created with API key' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @RequiredPermission('ADMIN')
  async generateApiKey(@Body() createAgentDto: CreateAgentDto, @Principal() principal: KodaPrincipal) {
    const data = await this.createAgent(createAgentDto, principal);
    return JsonResponse.Ok(data);
  }

  @Get()
  @ApiOperation({ summary: 'List all agents' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  async findAll() {
    const data = await this.listAll();
    return JsonResponse.Ok(data);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current agent profile (API key auth)' })
  @ApiResponse({ status: 200, description: 'Agent profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async findMe(@Principal() principal: KodaPrincipal) {
    const data = await this.getMe(principal);
    return JsonResponse.Ok(data);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get agent by slug' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.getBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Get(':slug/pickup')
  @ApiOperation({ summary: 'Suggest a ticket for the agent to pick up' })
  @ApiQuery({ name: 'project', required: true, description: 'Project slug' })
  @ApiResponse({ status: 200, description: 'Suggested ticket or null' })
  @ApiResponse({ status: 400, description: 'Missing project query param' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async suggestTicket(@Param('slug') slug: string, @Query('project') project: string) {
    const data = await this.pickupTicket(slug, project);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update agent (admin only)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @RequiredPermission('ADMIN')
  async update(@Param('slug') slug: string, @Body() updateDto: UpdateAgentDto, @Principal() principal: KodaPrincipal) {
    const data = await this.updateAgent(slug, updateDto, principal);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug/update-roles')
  @ApiOperation({ summary: 'Update agent roles (admin only)' })
  @ApiResponse({ status: 200, description: 'Roles updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @RequiredPermission('ADMIN')
  async updateRoles(@Param('slug') slug: string, @Body() updateRolesDto: UpdateRolesDto, @Principal() principal: KodaPrincipal) {
    const data = await this.updateAgentRoles(slug, updateRolesDto, principal);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug/update-capabilities')
  @ApiOperation({ summary: 'Update agent capabilities (admin only)' })
  @ApiResponse({ status: 200, description: 'Capabilities updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @RequiredPermission('ADMIN')
  async updateCapabilities(@Param('slug') slug: string, @Body() updateCapabilitiesDto: UpdateCapabilitiesDto, @Principal() principal: KodaPrincipal) {
    const data = await this.updateAgentCapabilities(slug, updateCapabilitiesDto, principal);
    return JsonResponse.Ok(data);
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete (soft-delete) an agent' })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @RequiredPermission('ADMIN')
  async remove(@Param('slug') slug: string, @Principal() principal: KodaPrincipal) {
    const data = await this.deleteAgent(slug, principal);
    return JsonResponse.Ok(data);
  }

  @Post(':slug/rotate-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate agent API key (admin only)' })
  @ApiResponse({ status: 200, description: 'API key rotated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @RequiredPermission('ADMIN')
  async rotateApiKey(@Param('slug') slug: string, @Principal() principal: KodaPrincipal) {
    const data = await this.rotateKey(slug, principal);
    return JsonResponse.Ok(data);
  }
}
