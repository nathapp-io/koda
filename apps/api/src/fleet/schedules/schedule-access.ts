import type { OwnerAccess } from './domain/schedule.domain';

/** The one key a schedule's owner must still hold in the project for its fires to dispatch. */
const DISPATCH_KEY = 'fleet.job.dispatch';

/**
 * Permissions P1d US-005 (spec AC-13): the owner may still dispatch when it exists, is not disabled,
 * and its effective keys in the schedule's project include `fleet.job.dispatch`. The keys are the
 * owner's — `PermissionService.effectiveKeys` over the schedule's `createdByType`/`createdById` — so an
 * agent owner is judged by the agent's bindings and legacy roles, not by a user's.
 */
export function mayDispatch(access: OwnerAccess, keys: ReadonlySet<string>): boolean {
  return access.exists && !access.disabled && keys.has(DISPATCH_KEY);
}
