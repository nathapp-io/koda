/**
 * Permissions P1a: the role permission-entry grammar.
 *
 * A role stores a list of entries. An entry is one of:
 * - a key from the catalog (`ticket.delete`);
 * - an ownable key in its `.own` form (`comment.update.own`), meaning "rows the caller created";
 * - a prefix wildcard (`ticket.*`) for every queue under `ticket.`;
 * - a prefix wildcard in own form (`thread.*.own`) for the ownable keys under `thread.`;
 * - `*` for every role-grantable key, and `*.read` for every role-grantable read;
 * - `approval.decide@<pattern>` to narrow the decide permission to actions matching a pattern;
 * - `!<entry>` to remove what that entry expands to, applied after every inclusion.
 *
 * A key fits a role scope when its own scope is the same or `any`; a key is role-grantable when its
 * access class is `role`. Everything a role can hold comes out of `expandEntries`, so an entry that
 * would grant nothing (or grant a key the role's scope cannot carry) fails loudly instead of being
 * silently dropped.
 */
import { findCatalogEntry, OWNABLE_KEYS, PERMISSION_CATALOG } from './catalog';
import type { KeyScope, PermissionCatalogEntry } from './catalog';

type RoleScope = 'GLOBAL' | 'PROJECT';

/** An entry that names no catalog key. */
export class UnknownPermissionEntryError extends Error {
  constructor(readonly entry: string) {
    super(entry);
    this.name = 'UnknownPermissionEntryError';
  }
}

/** An entry naming a catalog key that cannot be granted by a role of this scope. */
export class ScopeMismatchEntryError extends Error {
  constructor(readonly entry: string) {
    super(entry);
    this.name = 'ScopeMismatchEntryError';
  }
}

const ANY_KEY = '*';
const EXCLUSION_PREFIX = '!';
const OWN_SUFFIX = '.own';
const PREFIX_ANY_SUFFIX = '.*';
const PREFIX_ANY_OWN_SUFFIX = '.*.own';
const APPROVAL_DECIDE_PREFIX = 'approval.decide@';
const READ_SEGMENT = 'read';

function fits(scope: KeyScope, roleScope: RoleScope): boolean {
  if (scope === 'any') return true;
  return roleScope === 'GLOBAL' ? scope === 'global' : scope === 'project';
}

function isGrantable(entry: PermissionCatalogEntry, roleScope: RoleScope): boolean {
  return entry.access === 'role' && fits(entry.scope, roleScope);
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

/** `approval.decide@<pattern>` accepts an exact key or a `p.*` prefix that matches a catalog key. */
function matchesCatalogPattern(pattern: string): boolean {
  if (pattern.endsWith(PREFIX_ANY_SUFFIX)) {
    const prefix = pattern.slice(0, -ANY_KEY.length);
    return PERMISSION_CATALOG.some((entry) => entry.key.startsWith(prefix));
  }
  return findCatalogEntry(pattern) !== undefined;
}

/**
 * Adds every role-grantable, fitting key `matches` accepts — in its `.own` form when `own` — and
 * returns how many keys matched (the count decides a wildcard's "matched nothing" error).
 */
function collectMatches(
  target: Set<string>,
  roleScope: RoleScope,
  own: boolean,
  matches: (entry: PermissionCatalogEntry) => boolean,
): number {
  let matched = 0;
  for (const entry of PERMISSION_CATALOG) {
    if (!isGrantable(entry, roleScope) || !matches(entry)) continue;
    matched += 1;
    target.add(own ? `${entry.key}${OWN_SUFFIX}` : entry.key);
  }
  return matched;
}

function expandEntry(target: Set<string>, entry: string, roleScope: RoleScope): void {
  if (entry === ANY_KEY) {
    collectMatches(target, roleScope, false, () => true);
    return;
  }

  if (entry.startsWith(APPROVAL_DECIDE_PREFIX)) {
    if (!matchesCatalogPattern(entry.slice(APPROVAL_DECIDE_PREFIX.length))) {
      throw new UnknownPermissionEntryError(entry);
    }
    target.add(entry);
    return;
  }

  if (entry.endsWith(PREFIX_ANY_OWN_SUFFIX)) {
    const prefix = `${entry.slice(0, -PREFIX_ANY_OWN_SUFFIX.length)}.`;
    const matched = collectMatches(
      target,
      roleScope,
      true,
      (candidate) => candidate.key.startsWith(prefix) && OWNABLE_KEYS.has(candidate.key),
    );
    if (matched === 0) throw new UnknownPermissionEntryError(entry);
    return;
  }

  if (entry.endsWith(OWN_SUFFIX)) {
    const base = entry.slice(0, -OWN_SUFFIX.length);
    const catalogEntry = findCatalogEntry(base);
    if (catalogEntry === undefined) throw new UnknownPermissionEntryError(entry);
    if (!OWNABLE_KEYS.has(base) || !isGrantable(catalogEntry, roleScope)) {
      throw new ScopeMismatchEntryError(entry);
    }
    target.add(entry);
    return;
  }

  if (entry === `${ANY_KEY}.${READ_SEGMENT}`) {
    collectMatches(target, roleScope, false, (candidate) => lastSegment(candidate.key) === READ_SEGMENT);
    return;
  }

  if (entry.endsWith(PREFIX_ANY_SUFFIX)) {
    const prefix = entry.slice(0, -ANY_KEY.length);
    const matched = collectMatches(target, roleScope, false, (candidate) => candidate.key.startsWith(prefix));
    if (matched === 0) throw new UnknownPermissionEntryError(entry);
    return;
  }

  const catalogEntry = findCatalogEntry(entry);
  if (catalogEntry === undefined) throw new UnknownPermissionEntryError(entry);
  if (!isGrantable(catalogEntry, roleScope)) throw new ScopeMismatchEntryError(entry);
  target.add(entry);
}

export function expandEntries(
  entries: readonly string[],
  roleScope: 'GLOBAL' | 'PROJECT',
): ReadonlySet<string> {
  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const entry of entries) {
    if (entry.startsWith(EXCLUSION_PREFIX)) {
      expandEntry(excluded, entry.slice(EXCLUSION_PREFIX.length), roleScope);
    } else {
      expandEntry(included, entry, roleScope);
    }
  }

  // Exclusions apply after every inclusion, whatever their order in the list.
  for (const entry of excluded) included.delete(entry);

  return included;
}
