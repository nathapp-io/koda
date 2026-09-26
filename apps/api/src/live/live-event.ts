/**
 * Track 1 Slice 5: the content-free live event pushed to browsers over SSE.
 * `type` is a union with one member today; fleet S2 adds members.
 * `id` is the ticket_event envelope id (the TicketEvent row id), stable
 * across outbox retries, so clients can drop duplicate deliveries.
 */
export type LiveTicketAction = 'created' | 'updated' | 'transitioned' | 'assigned' | 'commented' | 'deleted';

export interface LiveEvent {
  id: string;
  type: 'ticket';
  action: LiveTicketAction;
  projectId: string;
  ticketId: string;
  actorId: string;
  at: string;
}

export const TICKET_ACTION_TO_LIVE: Readonly<Record<string, LiveTicketAction>> = Object.freeze({
  TICKET_CREATED: 'created',
  TICKET_UPDATED: 'updated',
  status_changed: 'transitioned',
  assigned: 'assigned',
  COMMENT_ADDED: 'commented',
  TICKET_DELETED: 'deleted',
});

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Maps a ticket_event outbox envelope to a LiveEvent; null when it cannot or should not be sent. */
export function toLiveEvent(payload: unknown): LiveEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  // Own-property check: a plain-object lookup would otherwise resolve inherited
  // keys like 'toString' and publish an event with a function as its action.
  const action =
    typeof p['action'] === 'string' && Object.prototype.hasOwnProperty.call(TICKET_ACTION_TO_LIVE, p['action'])
      ? TICKET_ACTION_TO_LIVE[p['action']]
      : undefined;
  if (!action) return null;
  const { id, projectId, ticketId, actorId, timestamp } = p;
  if (!isNonEmptyString(id) || !isNonEmptyString(projectId) || !isNonEmptyString(ticketId)) return null;
  return {
    id,
    type: 'ticket',
    action,
    projectId,
    ticketId,
    actorId: isNonEmptyString(actorId) ? actorId : '',
    at: isNonEmptyString(timestamp) ? timestamp : new Date().toISOString(),
  };
}
