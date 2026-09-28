import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { TicketStatus, CommentType } from '../../common/enums';
import { TRANSITION_RULES } from './ticket-transitions';

/**
 * `close()` is an admin override (Track 3 ruling 2026-09-27): global ADMIN or
 * project ADMIN only; agents never. `principal` must be the role-enriched one
 * (withProjectRole), so projectRole is the role in the project being accessed.
 */
export function canOverrideClose(principal: KodaPrincipal): boolean {
  if (!isUserPrincipal(principal)) return false;
  return principal.role === 'ADMIN' || principal.projectRole === 'ADMIN';
}

export const TICKET_ACTIONS = ['verify', 'start', 'fix', 'verify-fix', 'reject', 'close'] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** The state-machine request each endpoint makes (verify only from CREATED; see file doc). */
const ACTION_TARGETS: Record<Exclude<TicketAction, 'close'>, Array<[TicketStatus, CommentType | undefined]>> = {
  verify: [[TicketStatus.VERIFIED, CommentType.VERIFICATION]],
  start: [[TicketStatus.IN_PROGRESS, undefined]],
  fix: [[TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT]],
  'verify-fix': [[TicketStatus.CLOSED, CommentType.REVIEW], [TicketStatus.IN_PROGRESS, CommentType.REVIEW]],
  reject: [[TicketStatus.REJECTED, CommentType.GENERAL]],
};

const CLOSE_SOURCES: readonly TicketStatus[] = [TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, TicketStatus.VERIFY_FIX];

/**
 * Strict rule match. Not validateTransition: it returns early for a 'NONE'
 * rule without looking at the comment type, which would offer verify-fix
 * (IN_PROGRESS + REVIEW) on CREATED/VERIFIED tickets.
 */
function isValid(from: TicketStatus, to: TicketStatus, comment: CommentType | undefined): boolean {
  const required = TRANSITION_RULES[from]?.[to];
  if (required === undefined) return false;
  return required === 'NONE' ? comment === undefined : comment === required;
}

/**
 * M25: endpoint-level actions the caller may take on a ticket in `status`,
 * derived from the state machine and filtered by the caller's permissions
 * (TRANSITION from the project-role ability; close via canOverrideClose).
 */
export function allowedActions(
  status: TicketStatus,
  perms: { canTransition: boolean; canClose: boolean },
): TicketAction[] {
  const transitions = perms.canTransition
    ? (Object.keys(ACTION_TARGETS) as Array<Exclude<TicketAction, 'close'>>).filter((action) =>
        ACTION_TARGETS[action].some(([to, comment]) => isValid(status, to, comment)),
      )
    : [];
  const close = perms.canClose && CLOSE_SOURCES.includes(status) ? (['close'] as const) : [];
  return [...transitions, ...close];
}
