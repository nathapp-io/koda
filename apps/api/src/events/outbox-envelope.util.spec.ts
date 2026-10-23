/**
 * Permissions P2 US-006: a ticket or agent event envelope carries the current action context's
 * approval block, and carries no `approval` key at all outside any context.
 */
import { runWithActionContext } from '../action-context/action-context';
import {
  buildAgentEventOutboxPayload,
  buildTicketEventOutboxPayload,
  type AgentEventOutboxEnvelopeInput,
  type TicketEventOutboxEnvelopeInput,
} from './outbox-envelope.util';

const APPROVED = {
  requiredMode: 'human',
  satisfiedBy: 'human',
  approverType: 'USER',
  approverId: 'u2',
  requestId: 'pa1',
} as const;

const ticketInput = (): TicketEventOutboxEnvelopeInput => ({
  event: { id: 'evt-1', action: 'TICKET_CREATED', timestamp: new Date('2026-01-01T00:00:00Z') },
  ticketId: 't1',
  projectId: 'p1',
  actorId: 'u1',
  actorType: 'user',
  data: { title: 'Hello' },
});

const agentInput = (): AgentEventOutboxEnvelopeInput => ({
  event: { id: 'aevt-1', action: 'AGENT_UPDATED', timestamp: new Date('2026-01-01T00:00:00Z') },
  agentId: 'a1',
  projectId: 'p1',
  actorId: 'u1',
  data: { name: 'Koda' },
});

describe('outbox envelope approval (US-006)', () => {
  describe('buildTicketEventOutboxPayload', () => {
    it('AC-3: carries the current context approval, approver and request id included', () => {
      const envelope = runWithActionContext(
        { actor: { type: 'SYSTEM', id: 'assistant' }, origin: 'thread', approval: APPROVED },
        () => buildTicketEventOutboxPayload(ticketInput()),
      );

      expect(envelope.approval).toEqual(APPROVED);
    });

    it('AC-4: carries NO_APPROVAL when the current context needed no approval', () => {
      const envelope = runWithActionContext(
        { actor: { type: 'USER', id: 'u1' }, origin: 'rest' },
        () => buildTicketEventOutboxPayload(ticketInput()),
      );

      expect(envelope.approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none' });
    });

    it('AC-5: has no approval key outside any context, and keeps the canonical fields', () => {
      const envelope = buildTicketEventOutboxPayload(ticketInput());

      expect(envelope).not.toHaveProperty('approval');
      expect(envelope).toEqual({
        id: 'evt-1',
        type: 'ticket_event',
        action: 'TICKET_CREATED',
        timestamp: '2026-01-01T00:00:00.000Z',
        ticketId: 't1',
        projectId: 'p1',
        actorId: 'u1',
        actorType: 'user',
        data: { title: 'Hello' },
      });
    });
  });

  describe('buildAgentEventOutboxPayload', () => {
    it('AC-6: carries NO_APPROVAL when the current context needed no approval', () => {
      const envelope = runWithActionContext(
        { actor: { type: 'USER', id: 'u1' }, origin: 'rest' },
        () => buildAgentEventOutboxPayload(agentInput()),
      );

      expect(envelope.approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none' });
    });

    it('AC-7: has no approval key outside any context, and keeps the canonical fields', () => {
      const envelope = buildAgentEventOutboxPayload(agentInput());

      expect(envelope).not.toHaveProperty('approval');
      expect(envelope).toEqual({
        id: 'aevt-1',
        type: 'agent_event',
        action: 'AGENT_UPDATED',
        timestamp: '2026-01-01T00:00:00.000Z',
        agentId: 'a1',
        projectId: 'p1',
        actorId: 'u1',
        actorType: 'agent',
        data: { name: 'Koda' },
      });
    });
  });
});
