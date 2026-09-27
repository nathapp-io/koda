import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';

/**
 * `close()` is an admin override (Track 3 ruling 2026-09-27): global ADMIN or
 * project ADMIN only; agents never. `principal` must be the role-enriched one
 * (withProjectRole), so projectRole is the role in the project being accessed.
 */
export function canOverrideClose(principal: KodaPrincipal): boolean {
  if (!isUserPrincipal(principal)) return false;
  return principal.role === 'ADMIN' || principal.projectRole === 'ADMIN';
}
