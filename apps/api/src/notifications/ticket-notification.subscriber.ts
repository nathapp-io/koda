import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { NotificationWriter } from './notification-writer';
import { TicketMentionResolver } from './ticket-mention.resolver';
import { TicketForNotification, TicketNotificationReadsRepository } from './ticket-notification-reads.repository';
import { HANDLED_TICKET_ACTIONS, HandledTicketAction, TicketEventFacts, ticketRecipients, watchEntries } from './ticket-notification.rules';
import { ticketDraft } from './ticket-notification-text';
import { TicketWatchersRepository } from './ticket-watchers.repository';

export interface TicketEnvelope {
  id: string;
  action: string;
  ticketId: string;
  projectId: string;
  actorId: string;
  actorType: 'user' | 'agent';
  data: Readonly<Record<string, unknown>>;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The `ticket_event` envelope (buildTicketEventOutboxPayload); null when a required field is missing. */
export function parseTicketEnvelope(payload: unknown): TicketEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (!str(p.id) || !str(p.action) || !str(p.ticketId) || !str(p.projectId) || !str(p.actorId)) return null;
  if (p.actorType !== 'user' && p.actorType !== 'agent') return null;
  const data = typeof p.data === 'object' && p.data !== null && !Array.isArray(p.data) ? (p.data as Record<string, unknown>) : {};
  return { id: p.id, action: p.action, ticketId: p.ticketId, projectId: p.projectId, actorId: p.actorId, actorType: p.actorType, data };
}

interface EventContext {
  facts: TicketEventFacts;
  excerpt: string | null;
}

/**
 * Fleet S4a §2.2: ticket_event → watchers, then notifications. Watchers are written before recipients
 * are resolved, in the same handler, so an outbox retry repeats both (both idempotent). Throws only on
 * database failure; a deleted ticket or comment ends the handler quietly (Review Focus 1).
 */
@Injectable()
export class TicketNotificationSubscriber implements OnModuleInit {
  private readonly logger = new Logger(TicketNotificationSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reads: TicketNotificationReadsRepository,
    private readonly watchers: TicketWatchersRepository,
    private readonly mentions: TicketMentionResolver,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const event = parseTicketEnvelope(payload);
    if (!event) {
      this.logger.warn('Skipped a malformed ticket_event payload');
      return;
    }
    if (!HANDLED_TICKET_ACTIONS.has(event.action)) return;
    const ticket = await this.reads.findTicket(event.ticketId);
    if (!ticket || ticket.deletedAt) return;
    const context = await this.contextFor(event, ticket);
    if (!context) return;
    await this.watchers.ensure(ticket.id, watchEntries(context.facts));
    const recipients = ticketRecipients(context.facts, await this.watchers.findUnmutedUserIds(ticket.id));
    if (recipients.length === 0) return;
    const actorName = await this.reads.actorName(event.actorId, event.actorType);
    const ref = `${ticket.project.key}-${ticket.number}`;
    await this.writer.deliver(recipients.map((r) => ticketDraft({
      kind: r.kind, userId: r.userId, eventId: event.id, actorId: event.actorId, projectId: ticket.projectId,
      slug: ticket.project.slug, ref, ticketTitle: ticket.title, actorName, excerpt: context.excerpt,
      fromStatus: str(event.data.fromStatus) ? event.data.fromStatus : undefined,
      newStatus: str(event.data.newStatus) ? event.data.newStatus : undefined,
    })));
  };

  private async contextFor(event: TicketEnvelope, ticket: TicketForNotification): Promise<EventContext | null> {
    const base = { action: event.action as HandledTicketAction, reporterId: null, assigneeUserId: null, commentAuthorId: null, mentionedIds: [] };
    switch (event.action) {
      case 'TICKET_CREATED':
        return {
          facts: { ...base, reporterId: ticket.createdByUserId, mentionedIds: await this.mentions.mentionedUserIds(ticket.projectId, ticket.description) },
          excerpt: ticket.description,
        };
      case 'assigned':
        return { facts: { ...base, assigneeUserId: await this.userAssignee(event.data) }, excerpt: null };
      case 'COMMENT_ADDED': {
        const commentId = event.data.commentId;
        if (!str(commentId)) return null;
        const comment = await this.reads.findComment(commentId);
        if (!comment || comment.ticketId !== ticket.id) return null;
        return {
          facts: { ...base, commentAuthorId: comment.authorUserId, mentionedIds: await this.mentions.mentionedUserIds(ticket.projectId, comment.body) },
          excerpt: comment.body,
        };
      }
      case 'status_changed':
        return { facts: base, excerpt: null };
      default:
        return null;
    }
  }

  /** Events recorded before `assigneeType` existed fall back to a User lookup. */
  private async userAssignee(data: Readonly<Record<string, unknown>>): Promise<string | null> {
    const id = data.assignedTo;
    if (!str(id)) return null;
    if (data.assigneeType === 'user') return id;
    if (data.assigneeType === 'agent' || data.assigneeType === null) return null;
    return (await this.reads.isUser(id)) ? id : null;
  }
}
