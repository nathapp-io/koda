import { TicketStatus } from '../../common/enums';
import type { TicketAction } from './allowed-actions';

/**
 * Permissions P1 US-003: the catalog key of every state-machine edge.
 *
 * A transition route is gated twice: the route key says the caller may make that kind of move
 * (`ticket.transition.verify`), the edge key says the ticket's *current* status allows it for this
 * caller (`ticket.transition.verify-fix.approve` on a VERIFY_FIX ticket). A pair with no key is not
 * an edge of the state machine (`CREATED -> CLOSED`): nothing is checked, and `validateTransition`
 * answers for it.
 */
const EDGE_KEYS: Readonly<Partial<Record<TicketStatus, Readonly<Partial<Record<TicketStatus, string>>>>>> = {
  [TicketStatus.CREATED]: {
    [TicketStatus.VERIFIED]: 'ticket.transition.verify',
    [TicketStatus.IN_PROGRESS]: 'ticket.transition.start',
    [TicketStatus.REJECTED]: 'ticket.transition.reject',
  },
  [TicketStatus.VERIFIED]: {
    [TicketStatus.IN_PROGRESS]: 'ticket.transition.start',
    [TicketStatus.REJECTED]: 'ticket.transition.reject',
  },
  [TicketStatus.IN_PROGRESS]: {
    [TicketStatus.VERIFY_FIX]: 'ticket.transition.fix',
  },
  [TicketStatus.VERIFY_FIX]: {
    [TicketStatus.CLOSED]: 'ticket.transition.verify-fix.approve',
    [TicketStatus.IN_PROGRESS]: 'ticket.transition.verify-fix.return',
  },
};

/**
 * The permission key of a state-machine edge; undefined for a pair with no key (not an edge of the
 * state machine).
 */
export function transitionKeyFor(from: TicketStatus, to: TicketStatus): string | undefined {
  return EDGE_KEYS[from]?.[to];
}

/**
 * The key(s) that offer each `allowedActions` entry; an action is offered when the caller holds any
 * of them. `verify-fix` names both outcomes, so the entry shows for an approver and for a returner.
 */
export const TICKET_ACTION_KEYS: Readonly<Record<TicketAction, readonly string[]>> = {
  verify: ['ticket.transition.verify'],
  start: ['ticket.transition.start'],
  fix: ['ticket.transition.fix'],
  'verify-fix': ['ticket.transition.verify-fix.approve', 'ticket.transition.verify-fix.return'],
  reject: ['ticket.transition.reject'],
  close: ['ticket.transition.close'],
};
