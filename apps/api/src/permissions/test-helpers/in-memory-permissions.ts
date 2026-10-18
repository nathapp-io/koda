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

  roleRepo() {
    return {
      findOne: async (criteria: Partial<RoleDomain>) =>
        this.roles.find((role) => role.key === criteria.key) ?? null,
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
        return this.bindings.length < before;
      },
      deleteForPrincipal: async (principal: PrincipalRef) => {
        this.bindings = this.bindings.filter((b) => !same(b, principal));
      },
      lockOwnerRole: async () => {
        this.calls.push('lock-owner');
        return this.roleByKey('owner').id;
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
    };
  }
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
