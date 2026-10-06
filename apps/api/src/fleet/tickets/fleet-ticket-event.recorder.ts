import { Injectable } from '@nestjs/common';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../../events/outbox-envelope.util';

/**
 * Fleet C9: TicketEvent + outbox rows for ticket writes the fleet makes (live `commented` / `updated`).
 * Attributed to the job's requester as a user (TicketEvent.actorType is user | agent). Call inside txManager.run.
 */
@Injectable()
export class FleetTicketEventRecorder {
  constructor(
    private readonly ticketEvents: TicketEventService,
    private readonly outbox: NathappOutboxService,
  ) {}

  async record(input: { projectId: string; ticketId: string; action: 'COMMENT_ADDED' | 'TICKET_UPDATED'; actorId: string; data: Record<string, unknown> }): Promise<void> {
    const { projectId, ticketId, action, actorId, data } = input;
    const event = await this.ticketEvents.create({ ticketId, projectId, action, actorId, actorType: 'user', source: 'internal', data });
    await this.outbox.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId, actorType: 'user', data }),
      metadata: { projectId, eventId: event.id },
    });
  }
}
