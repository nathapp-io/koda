import { BODY_MAX, NotificationCategory, NotificationDraft, TITLE_MAX, truncate } from './notification.types';

export type TicketNotificationKind = 'ticket_assigned' | 'ticket_mentioned' | 'ticket_commented' | 'ticket_status_changed';

export const TICKET_KIND_CATEGORY: Readonly<Record<TicketNotificationKind, NotificationCategory>> = Object.freeze({
  ticket_assigned: 'ASSIGNED',
  ticket_mentioned: 'MENTIONED',
  ticket_commented: 'WATCHED_ACTIVITY',
  ticket_status_changed: 'WATCHED_ACTIVITY',
});

export interface TicketDraftInput {
  kind: TicketNotificationKind;
  userId: string;
  eventId: string;
  actorId: string;
  projectId: string;
  slug: string;
  ref: string;
  ticketTitle: string;
  actorName: string;
  excerpt: string | null;
  fromStatus?: string;
  newStatus?: string;
}

const NAME_MAX = 80;

function englishTitle(kind: TicketNotificationKind, p: { ref: string; ticketTitle: string; actorName: string; fromStatus?: string; newStatus?: string }): string {
  switch (kind) {
    case 'ticket_assigned': return `${p.actorName} assigned you ${p.ref}: ${p.ticketTitle}`;
    case 'ticket_mentioned': return `${p.actorName} mentioned you on ${p.ref}`;
    case 'ticket_commented': return `${p.actorName} commented on ${p.ref}`;
    case 'ticket_status_changed': return `${p.ref} moved ${p.fromStatus ?? '?'} → ${p.newStatus ?? '?'}`;
  }
}

function englishBody(input: TicketDraftInput, ticketTitle: string): string | null {
  switch (input.kind) {
    case 'ticket_assigned': return null;
    case 'ticket_status_changed': return truncate(ticketTitle, BODY_MAX);
    default: return input.excerpt === null ? null : truncate(input.excerpt, BODY_MAX);
  }
}

/**
 * Fleet S4a kinds table: one ticket notification draft. English `title`/`body` are the CLI fallback; the
 * web renders from `kind` + `params` (spec §1). Everything user-written is truncated (D510).
 */
export function ticketDraft(input: TicketDraftInput): NotificationDraft {
  const ticketTitle = truncate(input.ticketTitle, TITLE_MAX);
  const actorName = truncate(input.actorName, NAME_MAX);
  const status = input.kind === 'ticket_status_changed'
    ? { fromStatus: input.fromStatus ?? '?', newStatus: input.newStatus ?? '?' }
    : {};
  const params = { ref: input.ref, ticketTitle, actorName, ...status };
  return {
    userId: input.userId,
    projectId: input.projectId,
    category: TICKET_KIND_CATEGORY[input.kind],
    kind: input.kind,
    title: truncate(englishTitle(input.kind, { ...params }), TITLE_MAX),
    body: englishBody(input, ticketTitle),
    link: `/${input.slug}/tickets/${input.ref}`,
    params,
    sourceType: 'ticket_event',
    sourceId: input.eventId,
    actorId: input.actorId,
  };
}
