import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { AGENT_ROUTE_VARIANTS } from './agent-route.commands';
import { Controller, Post, Get, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AgentResponseDto } from './dto/agent-response.dto';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateCapabilitiesDto } from './dto/update-capabilities.dto';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { JsonResponse, ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { Throttle } from '@nathapp/nestjs-throttler';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';

// SEC-3: targeted throttle on agent-credential routes (10/min vs 100/min global)
//
// Permissions P1 (US-009): these are global routes with no project slug, so each one states its
// catalog key with `@Requires` and lists `RequiresGuard` alone. The agent-management keys are
// GLOBAL-scope role keys, so a project-admin binding does not satisfy them. Pickup is the one
// service-level check: the key belongs to the *target* agent, not the caller.
//
// Permissions P1 (US-003): an agent's roles are role bindings, not an `AgentRoleEntry` list, so the
// `PATCH /agents/:slug/update-roles` route is gone. `PATCH /role-bindings` grants and `DELETE
// /role-bindings/:id` revokes what the agent acts with.
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class AgentsController {
  constructor(private agentsService: AgentsService, private readonly routeGate: ApprovalRouteGate) {}


  // Public methods for testing (called directly in tests)
  async createAgent(createAgentDto: CreateAgentDto, _principal?: KodaPrincipal) {
    return this.agentsService.generateApiKey(createAgentDto);
  }

  async listAll() {
    return this.agentsService.findAll();
  }

  async getMe(principal: KodaPrincipal) {
    // `agent.self.read` is implicit — every authenticated principal holds it — so the rule that this
    // route is for agents is enforced here, and answers the `agents` refusal the old AgentScope gate
    // stood for.
    if (principal.actorType !== 'agent') {
      throw new ForbiddenAppException({}, 'agents');
    }
    return this.agentsService.findMe(principal.id);
  }

  async getBySlug(slug: string) {
    return this.agentsService.findBySlug(slug);
  }

  async pickupTicket(slug: string, project: string, principal: KodaPrincipal) {
    if (!project) {
      throw new ValidationAppException({}, 'agents');
    }
    return this.agentsService.suggestTicket(slug, project, principal);
  }

  async updateAgent(slug: string, updateDto: UpdateAgentDto, _principal?: KodaPrincipal) {
    return this.agentsService.update(slug, updateDto);
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
  @UseGuards(RequiresGuard)
  @Requires('agent.create')
  @ApiOperation({ summary: 'Create agent and generate API key (agent.create)' })
  @ApiResponse({ status: 201, description: 'Agent created with API key' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'agent.create is missing' })
  async generateApiKey(@Body() createAgentDto: CreateAgentDto, @Principal() principal: KodaPrincipal) {
    const data = await this.createAgent(createAgentDto, principal);
    return JsonResponse.Ok(data);
  }

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('agent.read')
  @ApiOperation({ summary: 'List all agents' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  @ApiResponse({ status: 403, description: 'agent.read is missing' })
  async findAll() {
    const data = await this.listAll();
    return JsonResponse.Ok(data);
  }

  @Get('me')
  @UseGuards(RequiresGuard)
  @Requires('agent.self.read')
  @ApiOperation({ summary: 'Get current agent profile (API key auth)' })
  @ApiResponse({ status: 200, description: 'Agent profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Not an agent principal' })
  async findMe(@Principal() principal: KodaPrincipal) {
    const data = await this.getMe(principal);
    return JsonResponse.Ok(data);
  }

  @Get(':slug')
  @UseGuards(RequiresGuard)
  @Requires('agent.read')
  @ApiOperation({ summary: 'Get agent by slug' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 403, description: 'agent.read is missing' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.getBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Get(':slug/pickup')
  @UseGuards(RequiresGuard)
  // The key belongs to the target agent, and the target is only known to the service, after its
  // lookups: the route records `agent.pickup` and `AgentsService.suggestTicket` checks it.
  @Requires('agent.pickup', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Suggest a ticket for the agent to pick up' })
  @ApiQuery({ name: 'project', required: true, description: 'Project slug' })
  @ApiResponse({ status: 200, description: 'Suggested ticket or null' })
  @ApiResponse({ status: 400, description: 'Missing project query param' })
  @ApiResponse({ status: 403, description: 'Forbidden - agent only, or global ADMIN' })
  @ApiResponse({ status: 404, description: 'Agent or project not found' })
  async suggestTicket(
    @Param('slug') slug: string,
    @Query('project') project: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.pickupTicket(slug, project, principal);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug')
  @UseGuards(RequiresGuard)
  @ApprovalGated()
  @Requires('agent.update')
  @ApiOperation({ summary: 'Update agent (agent.update)' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'agent.update is missing' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async update(@Param('slug') slug: string, @Body() updateDto: UpdateAgentDto, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<AgentResponseDto>({ key: 'agent.update', variant: AGENT_ROUTE_VARIANTS.update, projectId: null, input: { slug, patch: updateDto } });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':slug/update-capabilities')
  @UseGuards(RequiresGuard)
  @ApprovalGated()
  @Requires('agent.capabilities.update')
  @ApiOperation({ summary: 'Update agent capabilities (agent.capabilities.update)' })
  @ApiResponse({ status: 200, description: 'Capabilities updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'agent.capabilities.update is missing' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateCapabilities(@Param('slug') slug: string, @Body() updateCapabilitiesDto: UpdateCapabilitiesDto, @Principal() principal: KodaPrincipal) {
    const target = await this.agentsService.findBySlug(slug);
    const outcome = await this.routeGate.run<AgentResponseDto>({ key: 'agent.capabilities.update', variant: AGENT_ROUTE_VARIANTS.updateCapabilities, projectId: null, input: { slug, agentId: target.id, capabilities: updateCapabilitiesDto } });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RequiresGuard)
  @Requires('agent.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete (soft-delete) an agent' })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'agent.delete is missing' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async remove(@Param('slug') slug: string) {
    const target = await this.agentsService.findBySlug(slug);
    const outcome = await this.routeGate.run<AgentResponseDto>({
      key: 'agent.delete',
      variant: AGENT_ROUTE_VARIANTS.delete,
      projectId: null,
      input: { slug, agentId: target.id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':slug/rotate-key')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RequiresGuard)
  @Requires('agent.key.rotate')
  @ApiOperation({ summary: 'Rotate agent API key (agent.key.rotate)' })
  @ApiResponse({ status: 200, description: 'API key rotated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'agent.key.rotate is missing' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async rotateApiKey(@Param('slug') slug: string, @Principal() principal: KodaPrincipal) {
    const data = await this.rotateKey(slug, principal);
    return JsonResponse.Ok(data);
  }
}
