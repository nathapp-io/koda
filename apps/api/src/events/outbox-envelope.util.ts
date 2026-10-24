/**
 * H13: outbox payload envelope builders.
 *
 * The outbox fan-out consumers (`memory-outbox.subscriber.ts`,
 * `entity-graph-outbox.subscriber.ts`) switch on `action` and read
 * `id`/`timestamp`/`ticketId`/`agentId`/`actorId`/`data` from the payload.
 * Producers must therefore enqueue the FULL canonical event envelope, not a
 * partial `{ ticketId, projectId, actorId, data }` projection — otherwise
 * memory extraction and entity-graph updates silently no-op.
 *
 * Permissions P2 US-006: when a producer runs inside an action context the envelope also carries
 * the context's approval block, so the consumer side knows an event was approved (and by whom)
 * without reconstructing it from the domain actor. Outside any context — a test, a script — the
 * key is omitted rather than set to a made-up `NO_APPROVAL`.
 */
import { currentContext, type ActionApproval } from '../action-context/action-context';

/** The approval block of the current action context; nothing when no context is current. */
function approvalField(): { approval?: ActionApproval } {
  const context = currentContext();
  return context === undefined ? {} : { approval: context.approval };
}

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
    ...approvalField(),
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
    ...approvalField(),
    data: input.data,
  };
}
