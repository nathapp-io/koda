import { parseBody } from '../approvals/route/parse-body';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { creatorRef } from './creator-ref';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { TicketLinksService } from './ticket-links.service';

export const TICKET_LINK_ROUTE_VARIANTS = { add: 'rest:ticket-links.add', remove: 'rest:ticket-links.remove' } as const;

@Injectable()
export class TicketLinkRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: TicketLinksService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; ref: string; link: CreateTicketLinkDto }, Awaited<ReturnType<TicketLinksService['create']>>>({
      key: 'ticket.link.add', variant: TICKET_LINK_ROUTE_VARIANTS.add,
      parse: (input) => {
        const { slug, ref } = parseRouteInput(input, ['slug', 'ref']);
        return { slug, ref, link: parseBody(CreateTicketLinkDto, (input as Record<string, unknown>).link ?? {}) };
      },
      run: (principal, input) => this.service.create(input.slug, input.ref, input.link, creatorRef(principal)),
      toResult: (result) => result.link,
    }, this.loader));

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
