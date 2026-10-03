/**
 * Track 1 Slice 5: the content-free live event pushed to browsers over SSE.
 * `type` is a union: `ticket` since Track 1 Slice 5, `fleet_job` since fleet S1,
 * `fleet_approval` since fleet S1.5.
 * `id` is the ticket_event envelope id (the TicketEvent row id), stable
 * across outbox retries, so clients can drop duplicate deliveries.
 */
export type LiveTicketAction = 'created' | 'updated' | 'transitioned' | 'assigned' | 'commented' | 'deleted';

export interface LiveTicketEvent {
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

/**
 * Fleet S1 (spec §1): content-free job change; the page refetches the job.
 * `projectId` is required: ProjectEventBus routes on it.
 */
export interface LiveFleetJobEvent {
  id: string;
  type: 'fleet_job';
  projectId: string;
  jobId: string;
  state: string;
  at: string;
}

/**
 * Fleet S1.5 (spec §2.5): content-free approval change; the inbox refetches.
 * Only approvals with a project are published (the bus routes on projectId).
 */
export interface LiveFleetApprovalEvent {
  id: string;
  type: 'fleet_approval';
  projectId: string;
  approvalId: string;
  status: string;
  at: string;
}

export type LiveEvent = LiveTicketEvent | LiveFleetJobEvent | LiveFleetApprovalEvent;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Maps a ticket_event outbox envelope to a LiveTicketEvent; null when it cannot or should not be sent. */
export function toLiveEvent(payload: unknown): LiveTicketEvent | null {
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
