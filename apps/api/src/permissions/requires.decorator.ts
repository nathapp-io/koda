import { SetMetadata } from '@nestjs/common';

/**
 * Permissions P1: the route-side half of the one authorization mechanism.
 *
 * A route declares the catalog keys it needs; `RequiresGuard` reads them back and asks
 * `PermissionService` (design `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`).
 * `enforcedBy: 'service'` is the escape hatch for checks the guard cannot make — the target row
 * (ownership), the ticket's current status (a transition edge), the caller's identity (roster
 * self-update) or a filtered listing — where the handler or its service checks the same key.
 */
export const REQUIRES_METADATA = 'koda:requires';

export interface RequiresOptions {
  /** 'all' (default): every key must pass. 'any': at least one. */
  mode?: 'all' | 'any';
  /** 'guard' (default): RequiresGuard checks the keys. 'service': the handler or service checks them; the guard only records them. */
  enforcedBy?: 'guard' | 'service';
}

export interface RequiresMetadata {
  keys: readonly string[];
  mode: 'all' | 'any';
  enforcedBy: 'guard' | 'service';
}

/**
 * Declares the catalog keys a route needs. Throws at decoration time on an empty list: a route that
 * names no key would otherwise read as "allowed" to anyone reading the decorator.
 */
export const Requires = (keys: string | readonly string[], options: RequiresOptions = {}) => {
  const list = typeof keys === 'string' ? [keys] : [...keys];
  if (list.length === 0) throw new Error('@Requires needs at least one permission key');

  return SetMetadata<string, RequiresMetadata>(REQUIRES_METADATA, {
    keys: list,
    mode: options.mode ?? 'all',
    enforcedBy: options.enforcedBy ?? 'guard',
  });
};
