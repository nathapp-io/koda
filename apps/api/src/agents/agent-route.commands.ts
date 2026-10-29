import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { parseBody } from '../approvals/route/parse-body';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { AgentsService } from './agents.service';
import { AgentResponseDto } from './dto/agent-response.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateCapabilitiesDto } from './dto/update-capabilities.dto';

/**
 * The body property a create-shaped route input carries. A non-object input answers `undefined`, and a
 * missing property `{}`: both are refused by `parseBody`, which needs an object to validate.
 */
function routeBody(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  return Object.hasOwn(source, key) ? source[key] : {};
}

export const AGENT_ROUTE_VARIANTS = {
  create: 'rest:agents.create',
  rotateKey: 'rest:agents.rotate-key',
  delete: 'rest:agents.delete',
  update: 'rest:agents.update',
  updateCapabilities: 'rest:agents.update-capabilities',
} as const;

/** What a gated credential route answers: the one-time raw key and the agent it belongs to. */
interface AgentCredentialResult { apiKey: string; agent: AgentResponseDto }

@Injectable()
export class AgentRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: AgentsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    // `gate-secret` (US-006): approving these requests runs nothing, so the raw key only ever reaches
    // the caller that redeems the request. The stored input carries no key — the key is minted when
    // the redemption runs — and the settled row keeps the `toResult` projection (the agent, no key).
    this.commands.register(routeCommand<{ agent: CreateAgentDto }, AgentCredentialResult>({
      key: 'agent.create', variant: AGENT_ROUTE_VARIANTS.create,
      parse: (input) => ({ agent: parseBody(CreateAgentDto, routeBody(input, 'agent')) }),
      redeem: {},
      run: (_principal, input) => this.service.generateApiKey(input.agent),
      toResult: ({ agent }) => ({ agent }),
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; agentId: string }, AgentCredentialResult>({
      key: 'agent.key.rotate', variant: AGENT_ROUTE_VARIANTS.rotateKey,
      parse: (input) => parseRouteInput(input, ['slug', 'agentId']),
      redeem: {},
      run: (_principal, input) => this.service.generateApiKey(input.agentId),
      toResult: ({ agent }) => ({ agent }),
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; agentId: string; patch: UpdateAgentDto }, AgentResponseDto>({
      key: 'agent.update', variant: AGENT_ROUTE_VARIANTS.update,
      parse: (input) => { const parsed = parseRouteInput(input, ['slug', 'agentId']); return { ...parsed, patch: parseBody(UpdateAgentDto, (input as Record<string, unknown>)['patch'] ?? {}) }; },
      run: (_principal, input) => this.service.updateById(input.agentId, input.patch),
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
