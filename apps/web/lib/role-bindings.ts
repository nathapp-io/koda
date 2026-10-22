/**
 * Permissions P1 US-011: the pure half of the role-binding chips the admin pages render.
 *
 * A `RoleBindingDto` carries a `roleKey` but no name or scope, so a chip is the join of a binding
 * against the roles from `GET /roles`. Keeping the join here means the users page and the shared
 * dialog render the same chip, and the "all projects" suffix has a single i18n key.
 *
 * A role key the loaded roles do not name shows as written: inventing a name for a role the caller
 * cannot see would be worse than showing the key. It is never a partial join — the caller either has
 * the roles or the pages show the load error instead of chips.
 */
import type { Role } from '~/composables/useRoles'
import type { RoleBinding } from '~/composables/useRoleBindings'

/** The locked system role that owns an installation; granting it needs `role.binding.owner`. */
export const OWNER_ROLE_KEY = 'owner'

/** `t` from `useI18n`, narrowed to what the chip label needs. */
export type Translate = (key: string, named?: Record<string, unknown>) => string

export interface BindingChip {
  /** The binding id: what `DELETE /role-bindings/:id` takes. */
  id: string
  roleKey: string
  /** The role's display name, or the raw key when the roles do not name it. */
  name: string
  /** The role is PROJECT-scoped, so a project-less binding applies in every project. */
  allProjects: boolean
}

export function roleByKey(roles: readonly Role[], key: string): Role | null {
  return roles.find((role) => role.key === key) ?? null
}

/** One chip per binding, in the order the bindings arrived. */
export function bindingChips(bindings: readonly RoleBinding[], roles: readonly Role[]): BindingChip[] {
  return bindings.map((binding) => {
    const role = roleByKey(roles, binding.roleKey)
    return {
      id: binding.id,
      roleKey: binding.roleKey,
      name: role?.name ?? binding.roleKey,
      allProjects: role?.scope === 'PROJECT',
    }
  })
}

/** The chip copy: a PROJECT-scope role bound with no project covers every project. */
export function chipLabel(chip: BindingChip, t: Translate): string {
  return chip.allProjects ? t('admin.bindings.chip.allProjects', { name: chip.name }) : chip.name
}

/**
 * The roles a "add role" select may offer: the ones not already bound, minus `owner` unless the
 * caller holds `role.binding.owner` and the principal is a user (an agent can never own).
 */
export function bindableRoles(
  roles: readonly Role[],
  bindings: readonly RoleBinding[],
  options: { canGrantOwner: boolean },
): Role[] {
  const bound = new Set(bindings.map((binding) => binding.roleKey))
  return roles.filter((role) =>
    !bound.has(role.key) && (role.key !== OWNER_ROLE_KEY || options.canGrantOwner))
}
