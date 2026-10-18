import { Inject, Injectable } from '@nestjs/common';
import { CacheManager } from '@nathapp/nestjs-cache';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { userAuthStateCacheKey, userTokenVersionCacheTag } from '../auth/token-version.cache';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { PermissionCache } from './permission-cache';
import { ROLE_BINDING_REPOSITORY, ROLE_REPOSITORY } from './permissions.tokens';
import type {
  BindingFilter,
  BindingWithRole,
  Granter,
  PrincipalRef,
  RoleBindingView,
  RoleDomain,
} from './permissions.types';
import type { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import type { PrismaRoleRepository } from './prisma-role.repository';

const OWNER_ROLE_KEY = 'owner';
const ADMIN_ROLE_KEY = 'admin';
const GLOBAL_ADMIN_ROLE_KEYS: readonly string[] = [OWNER_ROLE_KEY, ADMIN_ROLE_KEY];
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SYSTEM_GRANTER: Granter = { type: 'SYSTEM', id: 'system' };

/** What a transaction decided: the binding, and the users whose `User.role` it changed. */
interface WriteOutcome<T> {
  value: T;
  changed: boolean;
  revokedUserIds: string[];
}

/**
 * Permissions P1a: every read and write of `RoleBinding`.
 *
 * Owner bindings are serialised by a `SELECT … FOR UPDATE` on the `owner` Role row, which also
 * protects the last-owner rule. For USER principals a global `owner` or `admin` binding is mirrored
 * into the legacy `User.role` in the same transaction; a change of `User.role` revokes the user's
 * tokens, and the cache entries that hold their auth state are dropped after the transaction.
 */
@Injectable()
export class MembershipService {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
    @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly permissionCache: PermissionCache,
    private readonly cache: CacheManager,
  ) {}

  /** Legacy `User.role = 'ADMIN'` or a global `owner`/`admin` binding. */
  async isGlobalAdmin(userId: string): Promise<boolean> {
    const state = await this.bindings.findUserState(userId);
    if (state?.role === 'ADMIN') return true;
    return (await this.bindings.countGlobalAdminBindings(userId)) > 0;
  }

  async bindOwnerIfFirst(userId: string, wasFirstUser: boolean): Promise<void> {
    if (!wasFirstUser) return;
    await this.createBinding({ principal: { type: 'USER', id: userId }, roleKey: OWNER_ROLE_KEY, projectId: null }, SYSTEM_GRANTER);
  }

  async bindBaseline(principal: PrincipalRef): Promise<void> {
    const roleKey = principal.type === 'USER' ? 'member' : 'agent';
    await this.createBinding({ principal, roleKey, projectId: null }, SYSTEM_GRANTER);
  }

  async setGlobalAdmin(userId: string, admin: boolean, by: Granter): Promise<void> {
    if (admin) {
      await this.createBinding({ principal: { type: 'USER', id: userId }, roleKey: ADMIN_ROLE_KEY, projectId: null }, by);
      return;
    }
    const adminRole = await this.roles.findOne({ key: ADMIN_ROLE_KEY });
    const outcome = await this.txManager.run(async (): Promise<WriteOutcome<void>> => {
      if (!(await this.bindings.findUserState(userId))) throw new NotFoundAppException({}, 'users');
      const existing = adminRole
        ? await this.bindings.findExisting({ type: 'USER', id: userId }, adminRole.id, null)
        : null;
      if (existing) await this.bindings.deleteById(existing.id);
      const demoted = await this.syncLegacyRole(userId);
      return { value: undefined, changed: existing !== null || demoted, revokedUserIds: demoted ? [userId] : [] };
    });
    await this.afterWrite(outcome);
  }

  async createBinding(
    input: { principal: PrincipalRef; roleKey: string; projectId: string | null },
    by: Granter,
  ): Promise<RoleBindingView> {
    const role = await this.roles.findOne({ key: input.roleKey });
    if (!role) throw new NotFoundAppException({}, 'permissions.roleNotFound');
    await this.assertTargetsExist(input.principal, input.projectId);

    try {
      const outcome = await this.txManager.run(() => this.insertBinding(role, input, by));
      await this.afterWrite(outcome);
      return outcome.value;
    } catch (error) {
      // A concurrent identical insert won the partial unique index. The failed statement aborted its
      // own transaction, so the winner is re-read here, outside it.
      if (!isUniqueViolation(error, 'principalId')) throw error;
      const existing = await this.bindings.findExisting(input.principal, role.id, input.projectId);
      if (!existing) throw error;
      return toView(existing, role.key);
    }
  }

  async findBinding(id: string): Promise<RoleBindingView | null> {
    const row = await this.bindings.findViewById(id);
    return row ? toView(row.binding, row.roleKey) : null;
  }

  async listBindings(filter: BindingFilter, page: IPageOption): Promise<IPageResult<RoleBindingView>> {
    const result = await this.bindings.findViewPage(filter, normalizePage(page));
    return { ...result, records: result.records.map((row) => toView(row.binding, row.roleKey)) };
  }

  async removeBinding(id: string): Promise<void> {
    const outcome = await this.txManager.run(async (): Promise<WriteOutcome<void>> => {
      const first = await this.bindings.findViewById(id);
      if (!first) throw new NotFoundAppException({}, 'permissions.bindingNotFound');
      const ownerRoleId = first.roleKey === OWNER_ROLE_KEY ? await this.bindings.lockOwnerRole() : null;

      // Re-read under the lock: a concurrent removal may have deleted it while this call waited.
      const current = ownerRoleId ? await this.bindings.findViewById(id) : first;
      if (!current) throw new NotFoundAppException({}, 'permissions.bindingNotFound');
      if (ownerRoleId) await this.assertOwnerRemains(ownerRoleId, [current.binding.id]);

      await this.bindings.deleteById(id);
      return this.afterRemoval([current]);
    });
    await this.afterWrite(outcome);
  }

  async removeAllBindings(principal: PrincipalRef): Promise<void> {
    const outcome = await this.txManager.run(async (): Promise<WriteOutcome<void>> => {
      const probe = await this.bindings.findPrincipalBindings(principal);
      const ownerRoleId = probe.some((row) => row.roleKey === OWNER_ROLE_KEY)
        ? await this.bindings.lockOwnerRole()
        : null;

      const current = ownerRoleId ? await this.bindings.findPrincipalBindings(principal) : probe;
      if (ownerRoleId) {
        const owned = current.filter((row) => row.roleKey === OWNER_ROLE_KEY);
        if (owned.length > 0) await this.assertOwnerRemains(ownerRoleId, owned.map((row) => row.binding.id));
      }

      await this.bindings.deleteForPrincipal(principal);
      return this.afterRemoval(current);
    });
    await this.afterWrite(outcome);
  }

  private async insertBinding(
    role: RoleDomain,
    input: { principal: PrincipalRef; projectId: string | null },
    by: Granter,
  ): Promise<WriteOutcome<RoleBindingView>> {
    if (role.key === OWNER_ROLE_KEY) await this.bindings.lockOwnerRole();

    const existing = await this.bindings.findExisting(input.principal, role.id, input.projectId);
    if (existing) return { value: toView(existing, role.key), changed: false, revokedUserIds: [] };

    const created = await this.bindings.createBinding({
      principalType: input.principal.type,
      principalId: input.principal.id,
      roleId: role.id,
      projectId: input.projectId,
      grantedByType: by.type,
      grantedById: by.id,
    });

    const promoted =
      input.principal.type === 'USER' && input.projectId === null && GLOBAL_ADMIN_ROLE_KEYS.includes(role.key)
        ? await this.bindings.setUserRole(input.principal.id, 'ADMIN')
        : false;
    return {
      value: toView(created, role.key),
      changed: true,
      revokedUserIds: promoted ? [input.principal.id] : [],
    };
  }

  /** Refuses the removal when it would leave no enabled user holding an `owner` binding. */
  private async assertOwnerRemains(ownerRoleId: string, removedIds: readonly string[]): Promise<void> {
    if ((await this.bindings.countEnabledOwnerBindings(ownerRoleId, removedIds)) < 1) {
      throw new ForbiddenAppException({}, 'permissions.ownerLocked');
    }
  }

  /** The legacy-role mirror after bindings were deleted: demote each user left without a global admin binding. */
  private async afterRemoval(removed: BindingWithRole[]): Promise<WriteOutcome<void>> {
    const candidates = new Set(
      removed
        .filter(
          (row) =>
            row.binding.principalType === 'USER' &&
            row.binding.projectId === null &&
            GLOBAL_ADMIN_ROLE_KEYS.includes(row.roleKey),
        )
        .map((row) => row.binding.principalId),
    );
    const revokedUserIds: string[] = [];
    for (const userId of candidates) {
      if (await this.syncLegacyRole(userId)) revokedUserIds.push(userId);
    }
    return { value: undefined, changed: removed.length > 0, revokedUserIds };
  }

  /** Sets `User.role = 'MEMBER'` (and revokes tokens) when no global `owner`/`admin` binding remains. */
  private async syncLegacyRole(userId: string): Promise<boolean> {
    if ((await this.bindings.countGlobalAdminBindings(userId)) > 0) return false;
    return this.bindings.setUserRole(userId, 'MEMBER');
  }

  private async assertTargetsExist(principal: PrincipalRef, projectId: string | null): Promise<void> {
    if (!(await this.bindings.principalExists(principal))) {
      throw new NotFoundAppException({}, principal.type === 'USER' ? 'users' : 'agents');
    }
    if (projectId !== null && !(await this.bindings.projectExists(projectId))) {
      throw new NotFoundAppException({}, 'projects');
    }
  }

  /** After the transaction committed: drop the permission cache and every revoked user's auth state. */
  private async afterWrite(outcome: WriteOutcome<unknown>): Promise<void> {
    if (outcome.changed) await this.permissionCache.invalidate();
    for (const userId of outcome.revokedUserIds) {
      await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
      await this.cache.invalidate(userAuthStateCacheKey(userId));
    }
  }
}

function toView(binding: BindingWithRole['binding'], roleKey: string): RoleBindingView {
  return {
    id: binding.id,
    principalType: binding.principalType,
    principalId: binding.principalId,
    roleId: binding.roleId,
    roleKey,
    projectId: binding.projectId,
    grantedByType: binding.grantedByType,
    grantedById: binding.grantedById,
    createdAt: binding.createdAt,
  };
}

/** `size` defaults to 50 and is capped at 200; `current` is at least 1. */
function normalizePage(page: IPageOption): IPageOption {
  const size = Number.isFinite(page.size) && page.size >= 1 ? Math.trunc(page.size) : DEFAULT_PAGE_SIZE;
  const current = Number.isFinite(page.current) && page.current >= 1 ? Math.trunc(page.current) : 1;
  return { current, size: Math.min(size, MAX_PAGE_SIZE) };
}
