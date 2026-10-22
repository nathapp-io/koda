/**
 * Permissions P1 US-010: the pure rules of the role editor, kept out of the .vue files so they are
 * the same wherever a role is read into the matrix and written back out of it.
 *
 * A stored role is a list of catalog entries. Some are plain keys of a matrix row (`ticket.create`,
 * or `comment.update.own` for an ownable row); everything else -- wildcards (`*.read`,
 * `prefix.*`), exclusions (`!x`), keys outside the role's scope -- is kept verbatim as a chip, in
 * its stored order, because the API gives that order a meaning and the matrix cannot express it.
 */
import type { CatalogEntry, RoleScope } from '~/composables/useRoles'

/** Mirrors the API's `ROLE_KEY_PATTERN`: kebab-case, two to forty-nine characters. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,48}$/

const OWN_SUFFIX = '.own'

/** What a matrix row grants: nothing, only the rows the principal created, or every row. */
export type RowChoice = 'own' | 'any'

/** The rows with a choice made; a row with none is simply absent. */
export type MatrixSelection = Readonly<Record<string, RowChoice>>

/** Whether a role of `roleScope` can hold a catalog key of `entryScope`. */
export function scopeFits(roleScope: RoleScope, entryScope: CatalogEntry['scope']): boolean {
  if (entryScope === 'any') return true
  return roleScope === 'GLOBAL' ? entryScope === 'global' : entryScope === 'project'
}

/** The catalog entries a role of `roleScope` can hold, in catalog order. */
export function rowsFor(catalog: readonly CatalogEntry[], roleScope: RoleScope): CatalogEntry[] {
  return catalog.filter((entry) => scopeFits(roleScope, entry.scope))
}

/** The key a row writes for a choice: `X.own` for own, `X` for any. */
export function entryFor(key: string, choice: RowChoice): string {
  return choice === 'own' ? `${key}${OWN_SUFFIX}` : key
}

export interface RowGroup {
  group: string
  rows: CatalogEntry[]
}

/** Rows grouped by the first segment of their key; groups and rows keep their input order. */
export function groupRows(rows: readonly CatalogEntry[]): RowGroup[] {
  const groups = new Map<string, CatalogEntry[]>()
  for (const row of rows) {
    const group = row.key.split('.')[0] ?? row.key
    groups.set(group, [...(groups.get(group) ?? []), row])
  }
  return [...groups].map(([group, grouped]) => ({ group, rows: grouped }))
}

export interface SplitPermissions {
  /** Entries that are not a plain key of a matrix row, in stored order. */
  chips: string[]
  selection: MatrixSelection
}

/** Reads a stored entry list into the chips and the matrix selection of `rows`. */
export function splitPermissions(permissions: readonly string[], rows: readonly CatalogEntry[]): SplitPermissions {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const chips: string[] = []
  let selection: Record<string, RowChoice> = {}
  for (const entry of permissions) {
    const plain = byKey.get(entry)
    if (plain) {
      selection = { ...selection, [plain.key]: 'any' }
      continue
    }
    const base = entry.endsWith(OWN_SUFFIX) ? byKey.get(entry.slice(0, -OWN_SUFFIX.length)) : undefined
    if (base?.ownable) {
      // An explicit bare key wins over its own form when a role lists both.
      if (selection[base.key] !== 'any') selection = { ...selection, [base.key]: 'own' }
      continue
    }
    chips.push(entry)
  }
  return { chips, selection }
}

/**
 * The entry list to save: the chips in their stored order, then the checked keys sorted. Rows not in
 * `rows` (a scope the role no longer has) contribute nothing.
 */
export function buildPermissions(
  chips: readonly string[],
  selection: MatrixSelection,
  rows: readonly CatalogEntry[],
): string[] {
  const keys = rows
    .filter((row) => selection[row.key] !== undefined)
    .map((row) => entryFor(row.key, selection[row.key] as RowChoice))
    .sort()
  return [...chips, ...keys]
}

/** Rows a saved role covers without listing them (via a wildcard, say): in `expandedKeys`, not explicit. */
export function coveredKeys(
  expandedKeys: readonly string[],
  selection: MatrixSelection,
  rows: readonly CatalogEntry[],
): string[] {
  const expanded = new Set(expandedKeys)
  return rows.filter((row) => expanded.has(row.key) && selection[row.key] === undefined).map((row) => row.key)
}
