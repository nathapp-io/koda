import type { OwnerAccess } from './domain/schedule.domain';

/**
 * S1b §3.2, plan D201: the owner may still dispatch when the user exists, is not disabled, and is a global ADMIN
 * or holds project role ADMIN or DEVELOPER (the roles that hold CASL CREATE on FleetJob).
 */
export function mayDispatch(access: OwnerAccess): boolean {
  if (!access.exists || access.disabled) return false;
  return access.globalRole === 'ADMIN' || access.projectRole === 'ADMIN' || access.projectRole === 'DEVELOPER';
}
