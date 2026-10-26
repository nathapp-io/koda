import { SYSTEM_ACTOR_IDS } from '../action-context';
import { UNAUDITED_SURFACES } from '../audit-coverage.allowlist';
import type { PermissionDeclarations } from '../../permissions/test-helpers/permission-contract';

export type CoverageViolation =
  | { kind: 'stale-surface'; surface: string }
  | { kind: 'read-route-allowlisted'; surface: string }
  | { kind: 'empty-reason'; surface: string };

/** Validate each allowlist entry against the surfaces visible in a live permission declaration walk. */
export function findCoverageViolations(
  declarations: PermissionDeclarations,
  allowlist: ReadonlyMap<string, string> = UNAUDITED_SURFACES,
  systemIds: ReadonlySet<string> = SYSTEM_ACTOR_IDS,
): CoverageViolation[] {
  const violations: CoverageViolation[] = [];

  for (const [surface, reason] of allowlist) {
    const routeMatch = /^(\S+) /.exec(surface);
    let isLive = false;

    if (routeMatch) {
      isLive = declarations.routes.some((route) => route.route === surface);
      if (!isLive) violations.push({ kind: 'stale-surface', surface });
      else if (routeMatch[1] === 'GET') {
        violations.push({ kind: 'read-route-allowlisted', surface });
      }
    } else if (surface.startsWith('writer:')) {
      const writer = surface.slice('writer:'.length);
      isLive = declarations.systemWriters.some((declaration) => declaration.writer === writer);
      if (!isLive) violations.push({ kind: 'stale-surface', surface });
    } else if (surface.startsWith('system:')) {
      isLive = systemIds.has(surface.slice('system:'.length));
      if (!isLive) violations.push({ kind: 'stale-surface', surface });
    } else {
      violations.push({ kind: 'stale-surface', surface });
    }

    if (reason.trim().length === 0) violations.push({ kind: 'empty-reason', surface });
  }

  return violations;
}
