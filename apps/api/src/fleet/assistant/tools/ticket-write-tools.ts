import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TicketsService } from '../../../tickets/tickets.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { createTicketsTool } from './create-tickets-tool';

/**
 * Fleet S5b 2b1 US-003 (2b1-D8): the ticket write tool group — the tools that propose a change to the thread's
 * project tickets and run it on approval. It registers with the registry at bootstrap, like the other groups;
 * `koda_update_ticket` (US-004) and `koda_link_tickets` (US-005) join it here.
 */
@Injectable()
export class TicketWriteTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly tickets: TicketsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(createTicketsTool({ tickets: this.tickets }));
  }
}
