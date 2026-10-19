/**
 * Permissions P1 US-003 — the permission key of each state-machine edge and of each
 * `allowedActions` entry (AC-1 .. AC-8).
 */
import { TicketStatus } from '../../common/enums';
import { TICKET_ACTIONS } from './allowed-actions';
import { TICKET_ACTION_KEYS, transitionKeyFor } from './transition-keys';

describe('transitionKeyFor', () => {
  it('AC-1: CREATED -> VERIFIED is ticket.transition.verify', () => {
    expect(transitionKeyFor(TicketStatus.CREATED, TicketStatus.VERIFIED)).toBe('ticket.transition.verify');
  });

  it('AC-2: VERIFIED -> IN_PROGRESS is ticket.transition.start', () => {
    expect(transitionKeyFor(TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS)).toBe('ticket.transition.start');
  });

  it('AC-3: CREATED -> REJECTED is ticket.transition.reject', () => {
    expect(transitionKeyFor(TicketStatus.CREATED, TicketStatus.REJECTED)).toBe('ticket.transition.reject');
  });

  it('AC-4: IN_PROGRESS -> VERIFY_FIX is ticket.transition.fix', () => {
    expect(transitionKeyFor(TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX)).toBe('ticket.transition.fix');
  });

  it('AC-5: VERIFY_FIX -> CLOSED is ticket.transition.verify-fix.approve', () => {
    expect(transitionKeyFor(TicketStatus.VERIFY_FIX, TicketStatus.CLOSED)).toBe(
      'ticket.transition.verify-fix.approve',
    );
  });

  it('AC-6: VERIFY_FIX -> IN_PROGRESS is ticket.transition.verify-fix.return', () => {
    expect(transitionKeyFor(TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS)).toBe(
      'ticket.transition.verify-fix.return',
    );
  });

  it('AC-7: IN_PROGRESS -> VERIFIED has no key (stored rule, no route reaches it)', () => {
    expect(transitionKeyFor(TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED)).toBeUndefined();
  });

  it('AC-8: CREATED -> CLOSED has no key (not an edge)', () => {
    expect(transitionKeyFor(TicketStatus.CREATED, TicketStatus.CLOSED)).toBeUndefined();
  });

  it('the remaining pairs of the same edges carry the same key', () => {
    // CREATED and VERIFIED share both outgoing edges, so a route can rely on one key per edge.
    expect(transitionKeyFor(TicketStatus.CREATED, TicketStatus.IN_PROGRESS)).toBe('ticket.transition.start');
    expect(transitionKeyFor(TicketStatus.VERIFIED, TicketStatus.REJECTED)).toBe('ticket.transition.reject');
  });

  it('every other pair is undefined', () => {
    const keyed = new Set([
      'CREATED>VERIFIED',
      'CREATED>IN_PROGRESS',
      'CREATED>REJECTED',
      'VERIFIED>IN_PROGRESS',
      'VERIFIED>REJECTED',
      'IN_PROGRESS>VERIFY_FIX',
      'VERIFY_FIX>CLOSED',
      'VERIFY_FIX>IN_PROGRESS',
    ]);

    for (const from of Object.values(TicketStatus)) {
      for (const to of Object.values(TicketStatus)) {
        if (keyed.has(`${from}>${to}`)) continue;
        expect([from, to, transitionKeyFor(from, to)]).toEqual([from, to, undefined]);
      }
    }
  });
});

describe('TICKET_ACTION_KEYS', () => {
  it('offers every action with the keys that grant it', () => {
    expect(TICKET_ACTION_KEYS).toEqual({
      verify: ['ticket.transition.verify'],
      start: ['ticket.transition.start'],
      fix: ['ticket.transition.fix'],
      'verify-fix': ['ticket.transition.verify-fix.approve', 'ticket.transition.verify-fix.return'],
      reject: ['ticket.transition.reject'],
      close: ['ticket.transition.close'],
    });
  });

  it('names every action exactly once', () => {
    expect(Object.keys(TICKET_ACTION_KEYS).sort()).toEqual([...TICKET_ACTIONS].sort());
  });

  it('names at least one key per action', () => {
    for (const keys of Object.values(TICKET_ACTION_KEYS)) {
      expect(keys.length).toBeGreaterThan(0);
    }
  });
});
