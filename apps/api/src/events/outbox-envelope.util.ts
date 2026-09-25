/**
 * H13: outbox payload envelope builders.
 *
 * The outbox fan-out consumers (`memory-outbox.subscriber.ts`,
 * `entity-graph-outbox.subscriber.ts`) switch on `action` and read
 * `id`/`timestamp`/`ticketId`/`agentId`/`actorId`/`data` from the payload.
 * Producers must therefore enqueue the FULL canonical event envelope, not a
 * partial `{ ticketId, projectId, actorId, data }` projection — otherwise
 * memory extraction and entity-graph updates silently no-op.
 */

export interface OutboxEnvelopeEventFields {
  id: string;
  action: string;
  timestamp: Date | string;
}

export function outboxEnvelopeTimestamp(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

export interface TicketEventOutboxEnvelopeInput {
  event: OutboxEnvelopeEventFields;
  ticketId: string;
  projectId: string;
  actorId: string;
  actorType: 'user' | 'agent';
  data: unknown;
}

export function buildTicketEventOutboxPayload(input: TicketEventOutboxEnvelopeInput): Record<string, unknown> {
  return {
    id: input.event.id,
    type: 'ticket_event',
    action: input.event.action,
    timestamp: outboxEnvelopeTimestamp(input.event.timestamp),
    ticketId: input.ticketId,
    projectId: input.projectId,
    actorId: input.actorId,
    actorType: input.actorType,
    data: input.data,
  };
}

export interface AgentEventOutboxEnvelopeInput {
  event: OutboxEnvelopeEventFields;
  agentId: string;
  projectId: string;
  actorId: string;
  data: unknown;
}

export function buildAgentEventOutboxPayload(input: AgentEventOutboxEnvelopeInput): Record<string, unknown> {
  return {
    id: input.event.id,
    type: 'agent_event',
    action: input.event.action,
    timestamp: outboxEnvelopeTimestamp(input.event.timestamp),
    agentId: input.agentId,
    projectId: input.projectId,
    actorId: input.actorId,
    actorType: 'agent',
    data: input.data,
  };
}
