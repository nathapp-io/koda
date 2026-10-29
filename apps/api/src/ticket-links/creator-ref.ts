import type { PrincipalRef } from '../permissions/permissions.types';
import { isAgentPrincipal, isUserPrincipal, type KodaPrincipal } from '../auth/principal/koda-principal.types';

/**
 * The creator recorded on a new link, as `TicketLinksService.create` takes it.
 *
 * A runner never reaches a ticket route (`CombinedAuthGuard` refuses it), and `undefined` makes the
 * service store a creatorless link rather than writing a half-typed reference.
 */
export function creatorRef(principal: KodaPrincipal): PrincipalRef | undefined {
  if (isUserPrincipal(principal)) return { type: 'USER', id: principal.id };
  if (isAgentPrincipal(principal)) return { type: 'AGENT', id: principal.id };
  return undefined;
}

