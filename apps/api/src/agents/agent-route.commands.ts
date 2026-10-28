import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { AgentsService } from './agents.service';
import { AgentResponseDto } from './dto/agent-response.dto';

export const AGENT_ROUTE_VARIANTS = { delete: 'rest:agents.delete' } as const;

@Injectable()
export class AgentRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: AgentsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string }, AgentResponseDto>({
      key: 'agent.delete', variant: AGENT_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug']),
      run: (_principal, input) => this.service.remove(input.slug),
      toResult: (result) => result,
    }, this.loader));
  }
}
