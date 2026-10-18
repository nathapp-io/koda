import type { IRepository } from '@nathapp/nestjs-data';

/**
 * Permissions P1a: the module's plain domain types.
 *
 * These are the shapes the repositories return and the services consume; no Prisma-generated type
 * crosses this boundary (`.nax/rules/api-data.md`). `Role.permissions` stays a `string[]` of catalog
 * entries — the JSON column is a storage detail of `PrismaRoleRepository`.
 */

/** A role is usable globally (GLOBAL) or only inside one project (PROJECT). */
export type RoleScope = 'GLOBAL' | 'PROJECT';

/** The two kinds of principal a binding can name. `RoleBinding.principalId` has no foreign key. */
export type PrincipalType = 'USER' | 'AGENT';

/** Who is recorded as having granted a binding. `SYSTEM` is the seeder and the API's own bootstrap. */
export type GranterType = PrincipalType | 'SYSTEM';

/** A named set of permission entries. `permissions` holds catalog entries, not expanded keys. */
export interface RoleDomain {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  system: boolean;
  locked: boolean;
  permissions: string[];
}

/** A role given to a principal, in one project (`projectId`) or globally (`projectId` null). */
export interface RoleBindingDomain {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  roleId: string;
  projectId: string | null;
  grantedByType: GranterType;
  grantedById: string;
  createdAt: Date;
}

/** The input of a new binding: everything but the generated id and timestamp. */
export type NewRoleBinding = Omit<RoleBindingDomain, 'id' | 'createdAt'>;

/**
 * One system role as the seeder knows it. `system` and `locked` default to true/false so the seed
 * table only spells out the exceptional case (`owner` is locked).
 */
export interface RoleSeed {
  readonly key: string;
  readonly name: string;
  readonly scope: RoleScope;
  readonly permissions: readonly string[];
  readonly system?: boolean;
  readonly locked?: boolean;
  readonly description?: string;
}

/**
 * The `ROLE_REPOSITORY` contract. A new role has no id yet — Prisma's `cuid()` default assigns it —
 * so creation takes the domain shape without one instead of a placeholder.
 */
export interface RoleRepository extends IRepository<RoleDomain> {
  createRole(input: Omit<RoleDomain, 'id'>): Promise<RoleDomain>;
}

/** The `ROLE_BINDING_REPOSITORY` contract. */
export interface RoleBindingRepository extends IRepository<RoleBindingDomain> {
  createBinding(input: NewRoleBinding): Promise<RoleBindingDomain>;
}
