import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { parseBody } from '../approvals/route/parse-body';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { AgentsService } from './agents.service';
import { AgentResponseDto } from './dto/agent-response.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateCapabilitiesDto } from './dto/update-capabilities.dto';

export const AGENT_ROUTE_VARIANTS = { delete: 'rest:agents.delete', update: 'rest:agents.update', updateCapabilities: 'rest:agents.update-capabilities' } as const;

@Injectable()
export class AgentRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: AgentsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; patch: UpdateAgentDto }, AgentResponseDto>({
      key: 'agent.update', variant: AGENT_ROUTE_VARIANTS.update,
      parse: (input) => { const parsed = parseRouteInput(input, ['slug']); return { ...parsed, patch: parseBody(UpdateAgentDto, (input as Record<string, unknown>)['patch'] ?? {}) }; },
      run: (_principal, input) => this.service.update(input.slug, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; agentId: string; capabilities: UpdateCapabilitiesDto }, AgentResponseDto>({
      key: 'agent.capabilities.update', variant: AGENT_ROUTE_VARIANTS.updateCapabilities,
      parse: (input) => { const parsed = parseRouteInput(input, ['slug', 'agentId']); return { ...parsed, capabilities: parseBody(UpdateCapabilitiesDto, (input as Record<string, unknown>)['capabilities'] ?? {}) }; },
      run: (_principal, input) => this.service.updateCapabilities(input.agentId, input.capabilities),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; agentId: string }, AgentResponseDto>({
      key: 'agent.delete', variant: AGENT_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug', 'agentId']),
      run: (_principal, input) => this.service.removeById(input.agentId),
      toResult: (result) => result,
    }, this.loader));
  }
}
