/**
 * Permissions P1b: the legacy project roles a binding is read as.
 *
 * Everything that still speaks the pre-bindings vocabulary (`ADMIN`, `DEVELOPER`, `VIEWER`) reads the
 * role of a membership through here, so a membership that lives in a binding and one that lives in a
 * legacy `ProjectMember` row answer the same string.
 *
 * Mapping every other role key to `VIEWER` is deliberate: the legacy CASL factory knows only these
 * three roles, so `reviewer`, `verifier`, `triager`, `approver` and custom PROJECT roles get the
 * least-privileged legacy set until `permissions-p1-enforce-core` checks their real keys.
 */

export type LegacyProjectRole = 'ADMIN' | 'DEVELOPER' | 'VIEWER';

/** The binding a legacy role is written as. */
export const ROLE_KEY_FOR_LEGACY_ROLE: Readonly<Record<LegacyProjectRole, string>> = {
  ADMIN: 'project-admin',
  DEVELOPER: 'developer',
  VIEWER: 'viewer',
};

const LEGACY_ROLE_FOR_ROLE_KEY: ReadonlyMap<string, LegacyProjectRole> = new Map<string, LegacyProjectRole>([
  [ROLE_KEY_FOR_LEGACY_ROLE.ADMIN, 'ADMIN'],
  [ROLE_KEY_FOR_LEGACY_ROLE.DEVELOPER, 'DEVELOPER'],
  [ROLE_KEY_FOR_LEGACY_ROLE.VIEWER, 'VIEWER'],
]);

/**
 * `'project-admin'` -> `'ADMIN'`, `'developer'` -> `'DEVELOPER'`, every other role key -> `'VIEWER'`.
 *
 * The lookup is a `Map`, not a record: a record answers an inherited `Object.prototype` member for a
 * role key such as `constructor`, `toString` or `__proto__`. The role keys are caller input (a custom
 * PROJECT role may use any key), and such a key must fall into the `VIEWER` fallback rather than come
 * back as a function that no downstream role allow-list accepts.
 */
export function legacyRoleForRoleKey(roleKey: string): LegacyProjectRole {
  return LEGACY_ROLE_FOR_ROLE_KEY.get(roleKey) ?? 'VIEWER';
}

/** Strongest first; a role this file does not know ranks below every legacy role. */
const RANK_BY_LEGACY_ROLE: Readonly<Record<LegacyProjectRole, number>> = { ADMIN: 0, DEVELOPER: 1, VIEWER: 2 };
const UNKNOWN_ROLE_RANK = 3;

/** A `Map` for the same reason as `LEGACY_ROLE_FOR_ROLE_KEY`: `ROLE_RANK['constructor']` is a function. */
const ROLE_RANK: ReadonlyMap<string, number> = new Map(Object.entries(RANK_BY_LEGACY_ROLE));

function rankOf(role: string): number {
  return ROLE_RANK.get(role) ?? UNKNOWN_ROLE_RANK;
}

function isStronger(candidate: string, current: string): boolean {
  const candidateRank = rankOf(candidate);
  const currentRank = rankOf(current);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  return candidateRank === UNKNOWN_ROLE_RANK && candidate < current;
}

/**
 * The strongest of several legacy roles: `ADMIN` > `DEVELOPER` > `VIEWER` > any other string.
 * Among other strings, the lexicographically smallest wins. An empty list answers `null`.
 */
export function strongestProjectRole(roles: readonly string[]): string | null {
  let strongest: string | null = null;
  for (const role of roles) {
    if (strongest === null || isStronger(role, strongest)) strongest = role;
  }
  return strongest;
}
