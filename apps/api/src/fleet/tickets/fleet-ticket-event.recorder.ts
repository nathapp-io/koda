import { Injectable } from '@nestjs/common';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../../events/outbox-envelope.util';
import { actorTypeFor } from '../../action-context/action-context';

/**
 * Fleet C9: TicketEvent + outbox rows for ticket writes the fleet makes (live `commented` / `updated`).
 * Attributed to the job's requester (TicketEvent.actorType is user | agent). Call inside txManager.run.
 *
 * US-002: `actorType` is the caller's when it knows it (a job's effects, which often run after commit and
 * outside any request); otherwise the action context answers, so an agent unlinking a job is recorded as
 * an `agent`. Both the event and the `ticket_event` outbox row carry the same type.
 */
@Injectable()
export class FleetTicketEventRecorder {
  constructor(
    private readonly ticketEvents: TicketEventService,
    private readonly outbox: NathappOutboxService,
  ) {}

  async record(input: {
    projectId: string; ticketId: string; action: 'COMMENT_ADDED' | 'TICKET_UPDATED'; actorId: string;
    actorType?: 'user' | 'agent'; data: Record<string, unknown>;
  }): Promise<void> {
    const { projectId, ticketId, action, actorId, data } = input;
    const actorType = input.actorType ?? (actorTypeFor(actorId) === 'AGENT' ? 'agent' : 'user');
    const event = await this.ticketEvents.create({ ticketId, projectId, action, actorId, actorType, source: 'internal', data });
    await this.outbox.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }
}
