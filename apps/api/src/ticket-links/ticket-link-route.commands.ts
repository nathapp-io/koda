import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { TicketLinksService } from './ticket-links.service';

export const TICKET_LINK_ROUTE_VARIANTS = { remove: 'rest:ticket-links.remove' } as const;

@Injectable()
export class TicketLinkRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: TicketLinksService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; ref: string; linkId: string }, null>({
      key: 'ticket.link.remove', variant: TICKET_LINK_ROUTE_VARIANTS.remove,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'linkId']),
      run: async (principal, input) => {
        await this.service.remove(input.slug, input.ref, input.linkId, principal);
        return null;
      },
    }, this.loader));
  }
}
