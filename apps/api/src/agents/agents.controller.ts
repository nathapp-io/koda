import { Controller, Post, Get, Patch, Body, Param, Req } from '@nestjs/common';
import type { Agent } from '@prisma/client';
import { AgentsService, CreateAgentDto } from './agents.service';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateCapabilitiesDto } from './dto/update-capabilities.dto';
import { IsPublic } from '../auth/decorators/is-public.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateApiKey(@Body() createAgentDto: CreateAgentDto, @Req() req: any): Promise<JsonResponse<{ apiKey: string; agent: Agent }>> {
    // Check if user is admin
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenAppException();
    }

    const data = await this.agentsService.generateApiKey(createAgentDto);
    return JsonResponse.Ok(data) as unknown as JsonResponse<{ apiKey: string; agent: Agent }>;
  }

  @Get()
  @IsPublic()
  @ApiOperation({ summary: 'List all agents' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  async findAll(): Promise<JsonResponse<Agent[]>> {
    const data = await this.agentsService.findAll();
    return JsonResponse.Ok(data) as unknown as JsonResponse<Agent[]>;
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current agent profile (API key auth)' })
  @ApiResponse({ status: 200, description: 'Agent profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findMe(@Req() req: any): Promise<JsonResponse<Agent>> {
    const agentId = req.user?.sub;
    if (!agentId || req.user?.actorType !== 'agent') {
      throw new ForbiddenAppException();
    }
    const data = await this.agentsService.findMe(agentId);
    return JsonResponse.Ok(data) as unknown as JsonResponse<Agent>;
  }

  @Get(':slug')
  @IsPublic()
  @ApiOperation({ summary: 'Get agent by slug' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async findBySlug(@Param('slug') slug: string): Promise<JsonResponse<Agent>> {
    const data = await this.agentsService.findBySlug(slug);
    return JsonResponse.Ok(data) as unknown as JsonResponse<Agent>;
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update agent (admin only)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async update(@Param('slug') slug: string, @Body() updateDto: UpdateAgentDto, @Req() req: any): Promise<JsonResponse<Agent>> {
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenAppException();
    }
    const data = await this.agentsService.update(slug, updateDto);
    return JsonResponse.Ok(data) as unknown as JsonResponse<Agent>;
  }

  @Patch(':slug/update-roles')
  @ApiOperation({ summary: 'Update agent roles (admin only)' })
  @ApiResponse({ status: 200, description: 'Roles updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateRoles(@Param('slug') slug: string, @Body() updateRolesDto: UpdateRolesDto, @Req() req: any): Promise<JsonResponse<Agent>> {
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenAppException();
    }
    const agent = await this.agentsService.findBySlug(slug);
    const data = await this.agentsService.updateRoles(agent.id, updateRolesDto);
    return JsonResponse.Ok(data) as unknown as JsonResponse<Agent>;
  }

  @Patch(':slug/update-capabilities')
  @ApiOperation({ summary: 'Update agent capabilities (admin only)' })
  @ApiResponse({ status: 200, description: 'Capabilities updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateCapabilities(@Param('slug') slug: string, @Body() updateCapabilitiesDto: UpdateCapabilitiesDto, @Req() req: any): Promise<JsonResponse<Agent>> {
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenAppException();
    }
    const agent = await this.agentsService.findBySlug(slug);
    const data = await this.agentsService.updateCapabilities(agent.id, updateCapabilitiesDto);
    return JsonResponse.Ok(data) as unknown as JsonResponse<Agent>;
  }

  @Post(':slug/rotate-key')
  @ApiOperation({ summary: 'Rotate agent API key (admin only)' })
  @ApiResponse({ status: 200, description: 'API key rotated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rotateApiKey(@Param('slug') slug: string, @Req() req: any): Promise<JsonResponse<{ apiKey: string; agent: Agent }>> {
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenAppException();
    }
    const data = await this.agentsService.rotateApiKey(slug);
    return JsonResponse.Ok(data) as unknown as JsonResponse<{ apiKey: string; agent: Agent }>;
  }
}
