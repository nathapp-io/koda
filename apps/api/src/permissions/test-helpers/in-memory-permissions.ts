import { Prisma } from '../../generated/prisma/client';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { IPageOption } from '@nathapp/nestjs-common';
import type {
  BindingFilter,
  BindingWithRole,
  NewRoleBinding,
  PrincipalRef,
  RoleBindingDomain,
  RoleDomain,
  UserLegacyState,
} from '../permissions.types';
import { SYSTEM_ROLES } from '../system-roles';

/**
 * Unit-test double of the two permission repositories and the cache. It mimics the contracts the
 * services rely on (partial unique index, owner lock as a no-op, user legacy role persistence), so
 * the service specs can assert behaviour without Postgres. The integration specs cover the real thing.
 */
export class InMemoryPermissionStore {
  roles: RoleDomain[] = SYSTEM_ROLES.map((seed) => ({
    id: `role-${seed.key}`,
    key: seed.key,
    name: seed.name,
    description: '',
    scope: seed.scope,
    system: true,
    locked: seed.locked ?? false,
    permissions: [...seed.permissions],
  }));
  bindings: RoleBindingDomain[] = [];
  users = new Map<string, UserLegacyState & { tokenVersion: number }>();
  agents = new Set<string>();
  projects = new Set<string>();
  calls: string[] = [];
  /** Runs once, right before the next insert: lets a spec insert the row a concurrent caller won with. */
  beforeInsert: (() => void) | null = null;
  /** When true, `delete` refuses like Postgres does when a binding appeared after the in-use check. */
  raceBindingOnDelete = false;
  private counter = 0;

  addUser(id: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER', disabled = false): void {
    this.users.set(id, { role, disabled, tokenVersion: 0 });
  }

  roleByKey(key: string): RoleDomain {
    const role = this.roles.find((candidate) => candidate.key === key);
    if (!role) throw new Error(`no role ${key}`);
    return role;
  }

  bind(principal: PrincipalRef, roleKey: string, projectId: string | null = null): RoleBindingDomain {
    const binding: RoleBindingDomain = {
      id: `binding-${(this.counter += 1)}`,
      principalType: principal.type,
      principalId: principal.id,
      roleId: this.roleByKey(roleKey).id,
      projectId,
      grantedByType: 'SYSTEM',
      grantedById: 'test',
      createdAt: new Date(),
    };
    this.bindings.push(binding);
    return binding;
  }

  /** The `ROLE_REPOSITORY` double: role reads and writes, with the repository's own errors. */
  roleRepo() {
    return {
      findOne: async (criteria: Partial<RoleDomain>) =>
        this.roles.find((role) => role.key === criteria.key) ?? null,
      findById: async (id: string) => this.roles.find((role) => role.id === id) ?? null,
      findRoles: async () => {
        this.calls.push('find-roles');
        return [...this.roles];
      },
      /**
       * US-003: the PROJECT-scope listing read to exhaustion. The double has every row in memory, so it
       * answers the same order the repository's keyset pages produce: system roles first, then by key.
       */
      findRolesByScope: async (scope: 'GLOBAL' | 'PROJECT') => {
        this.calls.push(`find-roles-by-scope:${scope}`);
        const byKey = (left: RoleDomain, right: RoleDomain) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
        return this.roles
          .filter((role) => role.scope === scope)
          .sort((left, right) => Number(right.system) - Number(left.system) || byKey(left, right));
      },
      createRole: async (input: Omit<RoleDomain, 'id'>) => {
        if (this.roles.some((role) => role.key === input.key)) {
          throw uniqueKeyViolation();
        }
        const role: RoleDomain = { ...input, id: `role-${(this.counter += 1)}` };
        this.roles.push(role);
        this.calls.push(`create-role:${role.key}`);
        return role;
      },
      update: async (id: string, patch: Partial<RoleDomain>) => {
        const index = this.roles.findIndex((role) => role.id === id);
        if (index < 0) throw new Error(`no role ${id}`);
        const updated = { ...this.roles[index], ...patch };
        this.roles[index] = updated;
        this.calls.push(`update-role:${updated.key}`);
        return updated;
      },
      delete: async (id: string) => {
        if (this.raceBindingOnDelete) throw foreignKeyViolation();
        this.roles = this.roles.filter((role) => role.id !== id);
        this.calls.push(`delete-role:${id}`);
      },
    };
  }

  /** A role repository whose insert always loses the unique-index race, whatever the pre-check saw. */
  racingRoleRepo() {
    return {
      ...this.roleRepo(),
      findOne: async () => null,
      createRole: async (): Promise<RoleDomain> => {
        throw uniqueKeyViolation();
      },
    };
  }

  bindingRepo() {
    const withRole = (binding: RoleBindingDomain): BindingWithRole => {
      const role = this.roles.find((candidate) => candidate.id === binding.roleId) as RoleDomain;
      return { binding, roleKey: role.key, roleScope: role.scope, rolePermissions: role.permissions };
    };
    const same = (binding: RoleBindingDomain, principal: PrincipalRef) =>
      binding.principalType === principal.type && binding.principalId === principal.id;
    const isAdminBinding = (row: BindingWithRole) =>
      row.binding.projectId === null && (row.roleKey === 'owner' || row.roleKey === 'admin');
    return {
      findEffectiveBindings: async (principal: PrincipalRef, projectId: string | null) =>
        this.bindings
          .filter((b) => same(b, principal) && (b.projectId === null || b.projectId === projectId))
          .map(withRole),
      findExisting: async (principal: PrincipalRef, roleId: string, projectId: string | null) =>
        this.bindings.find(
          (b) => same(b, principal) && b.roleId === roleId && b.projectId === projectId,
        ) ?? null,
      findViewById: async (id: string) => {
        const found = this.bindings.find((b) => b.id === id);
        return found ? withRole(found) : null;
      },
      findViewPage: async (
        filter: BindingFilter,
        page: IPageOption,
      ): Promise<IPageResult<BindingWithRole>> => {
        this.calls.push(`page:${page.current}:${page.size}`);
        const rows = this.bindings
          .filter((b) => (filter.principal ? same(b, filter.principal) : true))
          .filter((b) => (filter.principalType === undefined ? true : b.principalType === filter.principalType))
          .filter((b) => (filter.projectId === undefined ? true : b.projectId === filter.projectId))
          .map(withRole);
        const start = (page.current - 1) * page.size;
        return {
          records: rows.slice(start, start + page.size),
          total: rows.length,
          current: page.current,
          size: page.size,
          hasNext: start + page.size < rows.length,
          hasPrev: page.current > 1,
        };
      },
      findPrincipalBindings: async (principal: PrincipalRef) =>
        this.bindings.filter((b) => same(b, principal)).map(withRole),
      createBinding: async (input: NewRoleBinding) => {
        const hook = this.beforeInsert;
        this.beforeInsert = null;
        hook?.();
        const duplicate = this.bindings.find(
          (b) => same(b, { type: input.principalType, id: input.principalId }) &&
            b.roleId === input.roleId && b.projectId === input.projectId,
        );
        if (duplicate) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: 'RoleBinding_principalType_principalId_roleId_global_key' },
          });
        }
        const row = { ...input, id: `binding-${(this.counter += 1)}`, createdAt: new Date() };
        this.bindings.push(row);
        this.calls.push(`create:${input.roleId}`);
        return row;
      },
      deleteById: async (id: string) => {
        const before = this.bindings.length;
        this.bindings = this.bindings.filter((b) => b.id !== id);
        this.calls.push(`delete-binding:${id}`);
        return this.bindings.length < before;
      },
      deleteForPrincipal: async (principal: PrincipalRef) => {
        this.bindings = this.bindings.filter((b) => !same(b, principal));
      },
      deleteProjectBindings: async (
        principal: PrincipalRef,
        projectId: string,
        roleKeys?: readonly string[],
      ) => {
        const keys = roleKeys === undefined ? null : new Set(roleKeys);
        const before = this.bindings.length;
        this.bindings = this.bindings.filter((b) => {
          if (!same(b, principal) || b.projectId !== projectId) return true;
          if (keys === null) return false;
          const role = this.roles.find((candidate) => candidate.id === b.roleId) as RoleDomain;
          return !keys.has(role.key);
        });
        this.calls.push(`delete-project-bindings:${principal.type}:${principal.id}:${projectId}`);
        return before - this.bindings.length;
      },
      lockOwnerRole: async () => {
        this.calls.push('lock-owner');
        return this.roleByKey('owner').id;
      },
      lockUser: async (userId: string) => {
        this.calls.push(`lock-user:${userId}`);
      },
      countEnabledOwnerBindings: async (ownerRoleId: string, excludeIds: readonly string[]) =>
        this.bindings.filter(
          (b) =>
            b.roleId === ownerRoleId &&
            b.principalType === 'USER' &&
            !excludeIds.includes(b.id) &&
            this.users.get(b.principalId)?.disabled === false,
        ).length,
      countGlobalAdminBindings: async (userId: string) =>
        this.bindings
          .filter((b) => same(b, { type: 'USER', id: userId }))
          .map(withRole)
          .filter(isAdminBinding).length,
      findUserState: async (userId: string): Promise<UserLegacyState | null> => {
        const user = this.users.get(userId);
        return user ? { role: user.role, disabled: user.disabled } : null;
      },
      setUserRole: async (userId: string, role: 'MEMBER' | 'ADMIN') => {
        const user = this.users.get(userId);
        if (!user || user.role === role) return false;
        this.users.set(userId, { ...user, role, tokenVersion: user.tokenVersion + 1 });
        this.calls.push(`role:${userId}:${role}`);
        return true;
      },
      principalExists: async (principal: PrincipalRef) =>
        principal.type === 'USER' ? this.users.has(principal.id) : this.agents.has(principal.id),
      projectExists: async (id: string) => this.projects.has(id),
      countByRole: async (roleId: string) =>
        this.bindings.filter((binding) => binding.roleId === roleId).length,
    };
  }
}

function uniqueKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`key`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'Role_key_key' },
  });
}

/** The driver-adapter shape Prisma 7 reports for an `ON DELETE RESTRICT` refusal: no constraint name. */
function foreignKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Foreign key constraint violated on the constraint: `RoleBinding_roleId_fkey`',
    {
      code: 'P2003',
      clientVersion: 'test',
      meta: { modelName: 'Role', driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'ForeignKeyConstraintViolation' } } },
    },
  );
}

/** A cache double with the two CacheManager calls the permission cache uses. */
export class FakeCacheManager {
  readonly entries = new Map<string, unknown>();
  readonly invalidations: string[] = [];
  loads = 0;

  async get<T>(keys: string[], loader: () => Promise<T>): Promise<T> {
    const key = keys.join('|');
    if (!this.entries.has(key)) {
      this.loads += 1;
      this.entries.set(key, await loader());
    }
    return this.entries.get(key) as T;
  }

  async invalidate(key: string | string[], options?: { mode: string }): Promise<void> {
    this.invalidations.push(`${Array.isArray(key) ? key.join('|') : key}${options ? `#${options.mode}` : ''}`);
  }
}
