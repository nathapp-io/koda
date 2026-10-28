import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { TicketsService } from './tickets.service';
import { TicketResponseDto } from './dto/ticket-response.dto';

export const TICKET_ROUTE_VARIANTS = { delete: 'rest:tickets.delete' } as const;

@Injectable()
export class TicketRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: TicketsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; ref: string }, TicketResponseDto>({
      key: 'ticket.delete', variant: TICKET_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug', 'ref']),
      run: (principal, input) => this.service.softDelete(input.slug, input.ref, principal),
      toResult: (result) => result,
    }, this.loader));
  }
}
