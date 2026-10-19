import { Inject, Injectable } from '@nestjs/common';
import type { IPageOption } from '@nathapp/nestjs-common';
import {
  ForbiddenAppException,
  NotFoundAppException,
  ValidationAppException,
} from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isForeignKeyViolation, isRecordNotFound, isUniqueViolation } from '../common/utils/prisma-errors';
import { findCatalogEntry } from './catalog';
import { expandEntries, ScopeMismatchEntryError, UnknownPermissionEntryError } from './entry-matcher';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import { PermissionService, PermissionScope } from './permission.service';
import { ROLE_BINDING_REPOSITORY, ROLE_REPOSITORY } from './permissions.tokens';
import type {
  BindingFilter,
  PrincipalRef,
  PrincipalType,
  RoleBindingView,
  RoleDomain,
  RoleScope,
} from './permissions.types';
import type { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import type { PrismaRoleRepository } from './prisma-role.repository';

/** What `POST /roles` accepts. `key` and `scope` are fixed for the life of the role. */
export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string;
  scope: RoleScope;
  permissions: string[];
}

/** What `PATCH /roles/:id` accepts: never `key` or `scope`. */
export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissions?: string[];
}

/** What `POST /role-bindings` accepts. An omitted `projectId` and null both mean a global binding. */
export interface CreateBindingInput {
  principalType: PrincipalType;
  principalId: string;
  roleKey: string;
  projectId?: string | null;
}

const OWN_SUFFIX = '.own';
const APPROVAL_DECIDE = 'approval.decide';
const APPROVAL_DECIDE_PREFIX = 'approval.decide@';
const OWNER_ROLE_KEY = 'owner';
const ADMIN_ROLE_KEY = 'admin';
const OWNER_BINDING_KEY = 'role.binding.owner';

/**
 * Permissions P1a: role administration (`/roles` and `/role-bindings`).
 *
 * The service owns the four rules the routes must not re-implement: catalog validation of every
 * entry list, the anti-escalation rule (a caller can only write into a role keys it holds itself),
 * the system/locked role protections, and the in-use check before a delete. Every route's own
 * permission check goes through `assertCan`, which is the one place these routes consult
 * `PermissionService` instead of the legacy `@RequiredPermission` decorators.
 *
 * The binding routes add the scope, principal, self-binding and escalation rules in front of
 * `MembershipService`, which owns every `RoleBinding` write (idempotency, owner-row lock, legacy
 * `User.role` mirroring). Deleting a role needs no escalation check: removing a role grants nothing.
 *
 * Every write invalidates the permission cache in the same call, so the next `can` evaluation sees
 * the edited role or the new binding.
 */
@Injectable()
export class RoleAdminService {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
    @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
    private readonly permissions: PermissionService,
    private readonly permissionCache: PermissionCache,
    private readonly membership: MembershipService,
  ) {}

  /** The routes' own check: `ForbiddenAppException({}, 'permissions')` when `can` denies. */
  async assertCan(principal: KodaPrincipal, key: string, projectId?: string): Promise<void> {
    const decision = await this.permissions.can(
      principal,
      key,
      projectId === undefined ? {} : { projectId },
    );
    if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
  }

  async listRoles(principal: KodaPrincipal): Promise<RoleDomain[]> {
    await this.assertCan(principal, 'role.read');
    return this.roles.findRoles();
  }

  async createRole(principal: KodaPrincipal, input: CreateRoleInput): Promise<RoleDomain> {
    await this.assertCan(principal, 'role.manage');
    const expanded = this.expand(input.permissions, input.scope);
    if (await this.roles.findOne({ key: input.key })) {
      throw new ConflictAppException({}, 'permissions.roleKeyTaken');
    }
    await this.assertNoEscalation(principal, this.confer(input, expanded, true));

    try {
      const created = await this.roles.createRole({
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        scope: input.scope,
        system: false,
        locked: false,
        permissions: [...input.permissions],
      });
      await this.permissionCache.invalidate();
      return created;
    } catch (error) {
      // A concurrent create won the unique index after the check above; both answer the same 409.
      if (isUniqueViolation(error, 'key')) throw new ConflictAppException({}, 'permissions.roleKeyTaken');
      throw error;
    }
  }

  async updateRole(
    principal: KodaPrincipal,
    id: string,
    patch: UpdateRoleInput,
  ): Promise<RoleDomain> {
    await this.assertCan(principal, 'role.manage');
    const role = await this.findById(id);

    const expanded =
      patch.permissions === undefined
        ? undefined
        : this.confer(role, this.expand(patch.permissions, role.scope), true);
    if (role.system && patch.name !== undefined) {
      throw new ValidationAppException({}, 'permissions.systemRole');
    }
    if (expanded !== undefined) await this.assertNoEscalation(principal, expanded);
    if (role.locked) throw new ForbiddenAppException({}, 'permissions.ownerLocked');

    const data: Partial<RoleDomain> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.permissions !== undefined) data.permissions = [...patch.permissions];
    if (Object.keys(data).length === 0) return role;

    const updated = await this.roles.update(id, data);
    await this.permissionCache.invalidate();
    return updated;
  }

  async deleteRole(principal: KodaPrincipal, id: string): Promise<void> {
    await this.assertCan(principal, 'role.manage');
    const role = await this.findById(id);

    // The checks run in this order, whatever else is true of the role: lock, then system role,
    // then in use (spec § "Role write rules").
    if (role.locked) throw new ForbiddenAppException({}, 'permissions.ownerLocked');
    if (role.system) throw new ForbiddenAppException({}, 'permissions.systemRole');
    if ((await this.bindings.countByRole(id)) > 0) throw new ConflictAppException({}, 'permissions.roleInUse');

    try {
      await this.roles.delete(id);
    } catch (error) {
      // A binding inserted between the count above and this statement: the relation is RESTRICT.
      if (isForeignKeyViolation(error, 'roleId')) throw new ConflictAppException({}, 'permissions.roleInUse');
      if (isRecordNotFound(error)) throw new NotFoundAppException({}, 'permissions.roleNotFound');
      throw error;
    }
    await this.permissionCache.invalidate();
  }

  private async findById(id: string): Promise<RoleDomain> {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundAppException({}, 'permissions.roleNotFound');
    return role;
  }

  /** `GET /role-bindings`: the `role.read` gate, then the paginated view. */
  async listBindings(
    principal: KodaPrincipal,
    filter: BindingFilter,
    page: IPageOption,
  ): Promise<IPageResult<RoleBindingView>> {
    await this.assertCan(principal, 'role.read');
    return this.membership.listBindings(filter, page);
  }

  /**
   * `POST /role-bindings`. The checks run in the brief's order and the first failure decides the
   * response: route keys, then the role, project and principal lookups, the scope and principal-type
   * rules, the self-binding rule and finally escalation. `MembershipService` takes the owner lock.
   */
  async createBinding(principal: KodaPrincipal, input: CreateBindingInput): Promise<RoleBindingView> {
    const projectId = input.projectId ?? null;
    await this.assertBindingKeys(principal, { projectId, roleKey: input.roleKey });

    const role = await this.findByKey(input.roleKey);
    if (projectId !== null && !(await this.bindings.projectExists(projectId))) {
      throw new NotFoundAppException({}, 'projects');
    }
    const target: PrincipalRef = { type: input.principalType, id: input.principalId };
    if (!(await this.bindings.principalExists(target))) {
      throw new NotFoundAppException({}, 'permissions.principalNotFound');
    }
    if (role.scope === 'GLOBAL' && projectId !== null) {
      // The sentence interpolates the entry that cannot be granted in this scope. Nothing is being
      // granted entry-by-entry here — the caller is trying to hand out a whole GLOBAL role inside a
      // project — so the role itself is the thing that cannot be granted in a project scope.
      throw new ValidationAppException({ entry: role.key }, 'permissions.scopeMismatch');
    }
    const expanded = this.expandStored(role);
    this.assertPrincipalType(expanded, input.principalType);
    this.assertNotSelf(principal, target);
    await this.assertNoEscalation(
      principal,
      this.confer(role, expanded, projectId === null),
      scopeOf(projectId),
    );

    return this.membership.createBinding(
      { principal: target, roleKey: input.roleKey, projectId },
      principalRef(principal),
    );
  }

  /**
   * `DELETE /role-bindings/:id`. The route's keys come from the stored binding, never from the
   * request: a caller cannot pick the scope it is checked against.
   */
  async removeBinding(principal: KodaPrincipal, id: string): Promise<void> {
    const binding = await this.membership.findBinding(id);
    if (!binding) throw new NotFoundAppException({}, 'permissions.bindingNotFound');
    await this.assertBindingKeys(principal, { projectId: binding.projectId, roleKey: binding.roleKey });

    const target: PrincipalRef = { type: binding.principalType, id: binding.principalId };
    this.assertNotSelf(principal, target);

    // The FK makes this unreachable; refusing is still safer than skipping the escalation rule.
    const role = await this.findByKey(binding.roleKey);
    const expanded = this.expandStored(role);
    await this.assertNoEscalation(
      principal,
      this.confer(role, expanded, binding.projectId === null),
      scopeOf(binding.projectId),
    );

    await this.membership.removeBinding(id);
  }

  /** The binding routes' own keys: the scope's key, plus the owner key for an `owner` binding. */
  private async assertBindingKeys(
    principal: KodaPrincipal,
    target: { projectId: string | null; roleKey: string },
  ): Promise<void> {
    if (target.projectId === null) await this.assertCan(principal, 'role.binding.global');
    else await this.assertCan(principal, 'role.binding.manage', target.projectId);
    if (target.roleKey === OWNER_ROLE_KEY) await this.assertCan(principal, 'role.binding.owner');
  }

  private async findByKey(key: string): Promise<RoleDomain> {
    const role = await this.roles.findOne({ key });
    if (!role) throw new NotFoundAppException({}, 'permissions.roleNotFound');
    return role;
  }

  /** Nobody binds a role to itself: type and id must both differ from the caller's. */
  private assertNotSelf(principal: KodaPrincipal, target: PrincipalRef): void {
    const caller = principalRef(principal);
    if (caller.type === target.type && caller.id === target.id) {
      throw new ForbiddenAppException({}, 'permissions.selfBinding');
    }
  }

  /** A role holding a key this principal type can never have (today: `owner` and an AGENT). */
  private assertPrincipalType(expanded: ReadonlySet<string> | null, type: PrincipalType): void {
    if (expanded === null) return;
    const kind = type === 'USER' ? 'user' : 'agent';
    for (const key of expanded) {
      const entry = findCatalogEntry(baseKey(key));
      if (entry && !entry.principals.includes(kind)) {
        throw new ValidationAppException({}, 'permissions.principalType');
      }
    }
  }

  /**
   * `expandEntries` for an already-stored role, or null when its entries no longer expand. A role
   * whose entries are invalid grants nothing (`PermissionService` logs and skips it), so there is
   * nothing for the caller to escalate to and there is no principal-type rule to break.
   */
  private expandStored(role: RoleDomain): ReadonlySet<string> | null {
    try {
      return expandEntries(role.permissions, role.scope);
    } catch {
      return null;
    }
  }

  /**
   * The keys a role confers where it is being written: its own entries, plus the authority a global
   * `owner` or `admin` binding carries whatever its entry list says. Escalation that read only the
   * editable entries could be defeated — a caller holding `role.manage` and `role.binding.global`
   * clears `admin.permissions`, binds the emptied role, and `MembershipService` mirrors that binding
   * into a legacy `User.role = 'ADMIN'`, which is every project key in every project.
   *
   * `globallyBound` is true for a `projectId`-null binding and for a role write (a role's own scope is
   * global, whatever the caller's project). An invalid stored entry list contributes nothing, so the
   * `null` of `expandStored` only ever removes the role's own contribution.
   */
  private confer(
    role: { key: string; scope: RoleScope },
    expanded: ReadonlySet<string> | null,
    globallyBound: boolean,
  ): ReadonlySet<string> {
    const synthetic = globallyBound ? syntheticGlobalAdminKeys(role) : null;
    if (synthetic === null) return expanded ?? new Set<string>();
    return new Set<string>([...(expanded ?? []), ...synthetic]);
  }

  /** `expandEntries` with its two grammar errors turned into the routes' 400s. */
  private expand(entries: readonly string[], scope: RoleScope): ReadonlySet<string> {
    try {
      return expandEntries(entries, scope);
    } catch (error) {
      if (error instanceof UnknownPermissionEntryError) {
        throw new ValidationAppException({ entry: error.entry }, 'permissions.unknownEntry');
      }
      if (error instanceof ScopeMismatchEntryError) {
        throw new ValidationAppException({ entry: error.entry }, 'permissions.scopeMismatch');
      }
      throw error;
    }
  }

  /**
   * Nobody writes into a role a key it does not hold itself, at the scope the write lands in:
   * `'global'` for a global role, the project for a binding inside one. `X.own` counts as `X` and
   * `approval.decide@…` as `approval.decide`; the raw entry is accepted too, so a caller can always
   * delegate the exact entry it holds.
   */
  private async assertNoEscalation(
    principal: KodaPrincipal,
    expanded: ReadonlySet<string>,
    scope: PermissionScope = 'global',
  ): Promise<void> {
    if (expanded.size === 0) return;
    const held = await this.permissions.effectiveKeys(principalRef(principal), scope);
    const escalating = [...expanded].filter((key) => !held.has(key) && !held.has(baseKey(key)));
    if (escalating.length > 0) throw new ForbiddenAppException({}, 'permissions.escalation');
  }
}

/** The scope a binding's escalation check runs against: global for a null `projectId`. */
function scopeOf(projectId: string | null): PermissionScope {
  return projectId === null ? 'global' : { projectId };
}

/**
 * What a global `owner`/`admin` binding confers on top of its role's editable entries, straight from
 * the rules `PermissionService` applies: such a binding also gives its principal every key in
 * `expandEntries(['*'], 'PROJECT')`, in every project, and its legacy `User.role = 'ADMIN'` carries
 * the admin role's own global authority. `owner` therefore holds `role.binding.owner` and `admin`
 * does not, exactly as the seeded entries say.
 *
 * `null` for every other role: a custom GLOBAL role — even one holding `*` — confers only what its
 * entries expand to, because `PermissionService` grants the synthetic project set to `owner`/`admin`
 * bindings alone.
 */
function syntheticGlobalAdminKeys(role: { key: string; scope: RoleScope }): ReadonlySet<string> | null {
  if (role.scope !== 'GLOBAL') return null;
  if (role.key !== OWNER_ROLE_KEY && role.key !== ADMIN_ROLE_KEY) return null;
  const globalEntries = role.key === OWNER_ROLE_KEY ? ['*'] : ['*', `!${OWNER_BINDING_KEY}`];
  return new Set([...expandEntries(globalEntries, 'GLOBAL'), ...expandEntries(['*'], 'PROJECT')]);
}

/** `comment.update.own` → `comment.update`; `approval.decide@…` → `approval.decide`. */
function baseKey(key: string): string {
  if (key.endsWith(OWN_SUFFIX)) return key.slice(0, -OWN_SUFFIX.length);
  if (key.startsWith(APPROVAL_DECIDE_PREFIX)) return APPROVAL_DECIDE;
  return key;
}

/** The caller as the permission layer names principals. Reached only after a `can` allowed it. */
function principalRef(principal: KodaPrincipal): PrincipalRef {
  if (principal.actorType === 'runner') throw new ForbiddenAppException({}, 'permissions');
  return { type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id };
}
