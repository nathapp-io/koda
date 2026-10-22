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

/** A principal a binding can name. */
export type PrincipalRef = { type: PrincipalType; id: string };

/**
 * Permissions P1b: one row of a project's membership list, as the compatibility queries answer it.
 *
 * The principal's legacy role (`ADMIN` | `DEVELOPER` | `VIEWER`) over its LOCAL sources in the
 * project, when the earliest of those sources joined, and who added it.
 */
export interface ProjectMembership {
  principalId: string;
  /** `strongestProjectRole` over the principal's LOCAL sources in the project. */
  role: string;
  /** The earliest of: the legacy row's date (`ProjectMember.joinedAt`, `AgentProject.createdAt`) and the `createdAt` of each project binding. */
  since: Date;
  /** From the earliest source: `AgentProject.addedById`; a binding's `grantedById` when its `grantedByType` is `'USER'`; otherwise `null`. */
  addedByUserId: string | null;
}

/** Who performs a write; recorded as `grantedByType` and `grantedById`. */
export type Granter = { type: GranterType; id: string };

/** What the services return for a binding: the row plus its role's key. */
export interface RoleBindingView {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  roleId: string;
  roleKey: string;
  projectId: string | null;
  grantedByType: string;
  grantedById: string;
  createdAt: Date;
}

export interface PermissionDecision {
  allowed: boolean;
  reason:
    | 'implicit'
    | 'public'
    | 'granted'
    | 'not-granted'
    | 'not-owner'
    | 'non-role-key'
    | 'unknown-key'
    | 'no-project'
    | 'principal-type';
}

/** A binding row with the role fields the permission decision needs. */
export interface BindingWithRole {
  binding: RoleBindingDomain;
  roleKey: string;
  roleScope: RoleScope;
  rolePermissions: string[];
}

/** Filter of a binding list. `projectId: null` means global bindings only; undefined means any. */
export interface BindingFilter {
  principal?: PrincipalRef;
  /** Only bindings of this principal type, whatever principal they name (US-002). */
  principalType?: PrincipalType;
  projectId?: string | null;
}

/** Login-relevant state of a user: the legacy global role and whether the account is disabled. */
export interface UserLegacyState {
  role: 'MEMBER' | 'ADMIN';
  disabled: boolean;
}
