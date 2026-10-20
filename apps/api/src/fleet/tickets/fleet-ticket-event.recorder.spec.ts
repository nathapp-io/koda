import type { Mock } from 'vitest';
import { runWithActor } from '../../action-context/action-context';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';

/**
 * Permissions P1d US-002 — `FleetTicketEventRecorder` attributes a fleet ticket write to a user or an
 * agent. The explicit `actorType` wins (a job's effects run after commit, outside any request); without
 * one the action context answers, so an agent unlinking a job is recorded as an `agent`.
 */
describe('FleetTicketEventRecorder (US-002)', () => {
  const event = { id: 'e1', action: 'TICKET_UPDATED', timestamp: new Date('2026-10-30T00:00:00.000Z') };
  let events: { create: Mock };
  let outbox: { record: Mock };
  let recorder: FleetTicketEventRecorder;

  const input = { projectId: 'p1', ticketId: 't1', action: 'TICKET_UPDATED' as const, actorId: 'a1', data: { fleetJobUnlinked: 'j1' } };

  beforeEach(() => {
    events = { create: vi.fn().mockResolvedValue(event) };
    outbox = { record: vi.fn().mockResolvedValue(undefined) };
    recorder = new FleetTicketEventRecorder(events as never, outbox as never);
  });

  it('writes an agent type for both the event and the outbox row when the caller says agent', async () => {
    await recorder.record({ ...input, actorType: 'agent' });

    expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'a1', actorType: 'agent', source: 'internal' }));
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket_event',
      payload: expect.objectContaining({ actorId: 'a1', actorType: 'agent', action: 'TICKET_UPDATED' }),
      metadata: { projectId: 'p1', eventId: 'e1' },
    }));
  });

  it('takes the actor type from the action context when the caller passes none', async () => {
    await runWithActor({ type: 'AGENT', id: 'a1' }, () => recorder.record(input));

    expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'agent' }));
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ actorType: 'agent' }) }));
  });

  it('records a user when the context names someone else, and outside any context', async () => {
    await runWithActor({ type: 'AGENT', id: 'a2' }, () => recorder.record(input));
    expect(events.create).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'user' }));

    await recorder.record(input);
    expect(events.create).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'user' }));
  });

  it('lets an explicit user type override an agent context', async () => {
    await runWithActor({ type: 'AGENT', id: 'a1' }, () => recorder.record({ ...input, actorType: 'user' }));

    expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'user' }));
  });
});
