import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenAppException,
  NotFoundAppException,
  ValidationAppException,
} from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isForeignKeyViolation, isRecordNotFound, isUniqueViolation } from '../common/utils/prisma-errors';
import { expandEntries, ScopeMismatchEntryError, UnknownPermissionEntryError } from './entry-matcher';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { ROLE_BINDING_REPOSITORY, ROLE_REPOSITORY } from './permissions.tokens';
import type { PrincipalRef, RoleDomain, RoleScope } from './permissions.types';
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

const OWN_SUFFIX = '.own';
const APPROVAL_DECIDE = 'approval.decide';
const APPROVAL_DECIDE_PREFIX = 'approval.decide@';

/**
 * Permissions P1a: role administration (`/roles`).
 *
 * The service owns the four rules the routes must not re-implement: catalog validation of every
 * entry list, the anti-escalation rule (a caller can only write into a role keys it holds itself),
 * the system/locked role protections, and the in-use check before a delete. Every route's own
 * permission check goes through `assertCan`, which is the one place these routes consult
 * `PermissionService` instead of the legacy `@RequiredPermission` decorators.
 *
 * Every write invalidates the permission cache in the same call, so the next `can` evaluation sees
 * the edited role. Deleting a role needs no escalation check: removing a role grants nothing.
 */
@Injectable()
export class RoleAdminService {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
    @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
    private readonly permissions: PermissionService,
    private readonly permissionCache: PermissionCache,
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
    await this.assertNoEscalation(principal, expanded);

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
      patch.permissions === undefined ? undefined : this.expand(patch.permissions, role.scope);
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
   * Nobody writes into a role a key it does not hold itself. `X.own` counts as `X` and
   * `approval.decide@…` as `approval.decide`; the raw entry is accepted too, so a caller can always
   * delegate the exact entry it holds.
   */
  private async assertNoEscalation(
    principal: KodaPrincipal,
    expanded: ReadonlySet<string>,
  ): Promise<void> {
    if (expanded.size === 0) return;
    const held = await this.permissions.effectiveKeys(principalRef(principal), 'global');
    const escalating = [...expanded].filter((key) => !held.has(key) && !held.has(baseKey(key)));
    if (escalating.length > 0) throw new ForbiddenAppException({}, 'permissions.escalation');
  }
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
