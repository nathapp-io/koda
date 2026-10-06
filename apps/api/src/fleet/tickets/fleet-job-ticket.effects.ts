import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus } from '../../common/enums';
import { TicketTransitionsService } from '../../tickets/state-machine/ticket-transitions.service';
import type { DispatchTicket, TicketActor } from './fleet-tickets.service';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

export type { TicketActor } from './fleet-tickets.service';

const STARTABLE: ReadonlySet<string> = new Set([TicketStatus.CREATED, TicketStatus.VERIFIED]);

/** Fleet C9 §3: ticket-side effects of fleet jobs. After commit, best-effort per ticket, never throws (D451). */
@Injectable()
export class FleetJobTicketEffects {
  private readonly logger = new Logger(FleetJobTicketEffects.name);

  constructor(
    private readonly transitions: TicketTransitionsService,
    private readonly repo: PrismaFleetTicketsRepository,
    private readonly events: FleetTicketEventRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** D452: a RUN dispatch starts each CREATED/VERIFIED ticket as the requester; PLAN callers never call this. */
  async onRunDispatched(actor: TicketActor, tickets: readonly DispatchTicket[]): Promise<void> {
    for (const ticket of tickets.filter((t) => STARTABLE.has(t.status))) {
      try {
        await this.transitions.start(actor.projectSlug, ticket.ref, actor.principal);
      } catch (error) {
        this.logger.warn(`Fleet ticket ${ticket.ref}: start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
