import { Inject, Injectable, Logger } from '@nestjs/common';
import { CacheManager } from '@nathapp/nestjs-cache';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { userAuthStateCacheKey, userTokenVersionCacheTag } from '../auth/token-version.cache';
import { isForeignKeyViolation, isUniqueViolation } from '../common/utils/prisma-errors';
import { AfterCommitService } from './after-commit.service';
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
 * tokens, and the cache entries that hold their auth state are dropped once the write's transaction
 * committed (see `afterCommit`).
 *
 * Two locks serialize the legacy-role mirror, always in the same order — the `owner` Role row, then the
 * user's row: the survivor count of a removal must see every concurrent owner/admin change of that
 * user, or two transactions each count the other's binding as still present and nobody demotes. A
 * single `removeBinding` takes the `owner` Role row only when the binding it removes is an owner one,
 * and `removeAllBindings` takes both locks before it reads anything — the snapshot it deletes and
 * mirrors cannot be decided by an unlocked read.
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
    @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly permissionCache: PermissionCache,
    private readonly cache: CacheManager,
    private readonly afterCommitHooks: AfterCommitService,
  ) {}

  /**
   * The transaction owner's hook. Runs `fn` — normally its own `txManager.run` — and performs the
   * invalidations a nested binding write deferred inside it once the transaction ended.
   *
   * Any service that wraps a `MembershipService` write in its own transaction must pass the callback
   * through here. Nested `run`s join the outer transaction, so invalidating inside it drops the
   * permission cache before the binding is visible: a request in that window recomputes the old keys
   * and caches them under the new generation, and the commit invalidates nothing afterwards.
   */
  async afterCommit<T>(fn: () => Promise<T>): Promise<T> {
    return this.afterCommitHooks.scope(fn);
  }

  /**
   * Drops every cached effective-key set, so the next `can` call recomputes from the rows as they are
   * now. Every binding write this service performs invalidates on its own; this is the entry point for
   * a binding write it does not own, such as a direct fixture or maintenance write.
   */
  async invalidatePermissions(): Promise<void> {
    await this.permissionCache.invalidate();
  }

  /** A global `owner`/`admin` binding, independent of the legacy role mirror. */
  async isGlobalAdmin(userId: string): Promise<boolean> {
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
      await this.lockUserPrincipal({ type: 'USER', id: userId });
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
    return this.bindRole(role, input, by);
  }

  /**
   * `createBinding` for a role the caller already identifies **by id** — the invite acceptance path,
   * which binds the role the invite persisted and never whatever role owns that key now.
   *
   * Answers `null`, having written nothing, when the role row is gone. A custom role deleted after the
   * invite was read frees its key, so resolving the key here would grant its successor's permissions
   * instead of the ones the invite named; the foreign key closes the last window, because a delete that
   * commits between the read below and the insert makes the insert fail rather than bind a role this
   * call never saw.
   *
   * That failure is a constraint violation inside the current transaction, which Postgres has already
   * aborted: a caller must answer the request immediately after a `null`, not keep writing.
   */
  async createBindingForRole(
    input: { principal: PrincipalRef; roleId: string; projectId: string | null },
    by: Granter,
  ): Promise<RoleBindingView | null> {
    const role = await this.roles.findById(input.roleId);
    if (!role) return null;
    try {
      return await this.bindRole(role, input, by);
    } catch (error) {
      if (isForeignKeyViolation(error, 'roleId')) return null;
      throw error;
    }
  }

  /**
   * The write every binding route shares once the role row is known: the target checks, the insert and
   * the after-commit invalidation. Concurrent identical inserts are reconciled against the winner.
   */
  private async bindRole(
    role: RoleDomain,
    input: { principal: PrincipalRef; projectId: string | null },
    by: Granter,
  ): Promise<RoleBindingView> {
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
      await this.lockUserPrincipal(principalOfBinding(first.binding));

      // Re-read under the lock: a concurrent removal may have deleted it while this call waited.
      const current = ownerRoleId ? await this.bindings.findViewById(id) : first;
      if (!current) throw new NotFoundAppException({}, 'permissions.bindingNotFound');
      if (ownerRoleId) await this.assertOwnerRemains(ownerRoleId, [current.binding.id]);

      // The delete itself decides: a concurrent removal that won reports zero affected rows, and the
      // loser answers 404 instead of demoting a user it did not change.
      if (!(await this.bindings.deleteById(id))) {
        throw new NotFoundAppException({}, 'permissions.bindingNotFound');
      }
      return this.afterRemoval([current]);
    });
    await this.afterWrite(outcome);
  }

  /**
   * Removes the principal's bindings in one project — what the membership routes do when a member or
   * an agent is removed — restricted to the roles named by `roleKeys` when given, and answers how many
   * rows went away.
   *
   * It never touches a legacy `ProjectMember`/`AgentProject` row or a `projectId`-null binding, and it
   * never changes `User.role`: only global `owner`/`admin` bindings are mirrored. It takes the same
   * user row lock as every other binding write of this principal, so a concurrent global
   * `owner`/`admin` change and this removal are decided one at a time. Nested inside a caller's
   * `txManager.run`, the delete joins that transaction; the permission cache is invalidated after it
   * commits (through `afterCommit` when the caller owns the transaction).
   *
   * The cache is invalidated even when no binding was removed. Every caller follows this delete with
   * the legacy row the union also reads — `ProjectMembersService.remove`/`updateRole` delete the
   * `ProjectMember` row, `AgentsService.removeFromProject` deletes the `AgentProject` row — and a
   * principal whose only source in the project was that legacy row (a pre-bindings member, or a
   * rostered agent with no binding) removes zero bindings here. Skipping the invalidation would leave
   * its warmed effective keys alive for the full cache TTL, so a removed agent kept passing the
   * `agent.pickup` check and a removed user kept its project keys. The deferred invalidation runs
   * after the caller's transaction — legacy row included — has committed.
   */
  async removeProjectBindings(
    principal: PrincipalRef,
    projectId: string,
    roleKeys?: readonly string[],
  ): Promise<number> {
    const outcome = await this.txManager.run(async (): Promise<WriteOutcome<number>> => {
      await this.lockUserPrincipal(principal);
      const removed = await this.bindings.deleteProjectBindings(principal, projectId, roleKeys);
      return { value: removed, changed: true, revokedUserIds: [] };
    });
    await this.afterWrite(outcome);
    return outcome.value;
  }

  async removeAllBindings(principal: PrincipalRef): Promise<void> {
    const outcome = await this.txManager.run(async (): Promise<WriteOutcome<void>> => {
      // Both locks come before the snapshot, in the order every other binding write takes them: the
      // `owner` Role row, then the principal's user row. A snapshot read before the locks is stale, and
      // it is the snapshot this method deletes and mirrors: a concurrent global `owner`/`admin` grant of
      // this user that commits while this call waits for the lock would be deleted without ever reaching
      // `afterRemoval`, leaving zero bindings and a legacy `User.role = 'ADMIN'` behind. The owner-role
      // lock is taken unconditionally, because the locks must precede the read that decides whether an
      // owner binding is in play; it also keeps the last-owner count serialized with `removeBinding`.
      const ownerRoleId = await this.bindings.lockOwnerRole();
      await this.lockUserPrincipal(principal);

      const current = await this.bindings.findPrincipalBindings(principal);
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
    // The same order as every other path that takes both: the owner Role row, then the user's row.
    await this.lockUserPrincipal(input.principal);

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

  /**
   * The row lock that serializes this user's legacy-role mirror. Taken after the `owner` Role row
   * (when the write takes that one too) and before any binding is read, changed or counted, so the
   * survivor count always runs against the state a concurrent owner/admin change committed.
   */
  private async lockUserPrincipal(principal: PrincipalRef): Promise<void> {
    if (principal.type === 'USER') await this.bindings.lockUser(principal.id);
  }

  private async assertTargetsExist(principal: PrincipalRef, projectId: string | null): Promise<void> {
    if (!(await this.bindings.principalExists(principal))) {
      throw new NotFoundAppException({}, principal.type === 'USER' ? 'users' : 'agents');
    }
    if (projectId !== null && !(await this.bindings.projectExists(projectId))) {
      throw new NotFoundAppException({}, 'projects');
    }
  }

  /**
   * After the transaction ended: drop the permission cache and every revoked user's auth state.
   *
   * A write that joined a caller's transaction defers this to that caller's `afterCommit` scope, so
   * nothing is invalidated before the rows are visible to other requests.
   */
  private async afterWrite(outcome: WriteOutcome<unknown>): Promise<void> {
    const invalidate = async (): Promise<void> => {
      if (outcome.changed) await this.permissionCache.invalidate();
      for (const userId of outcome.revokedUserIds) {
        await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
        await this.cache.invalidate(userAuthStateCacheKey(userId));
      }
    };
    if (this.afterCommitHooks.defer(invalidate)) return;
    if (this.txManager.isInTransaction()) {
      // A caller wrapped this write in its own transaction without routing it through `afterCommit`.
      // The invalidation below is early, which can leave a stale cache entry behind for one TTL.
      this.logger.error(
        'a binding write ran inside a transaction that is not wrapped in MembershipService.afterCommit: ' +
          'the permission cache may be invalidated before the commit',
      );
    }
    await invalidate();
  }
}

/** The principal a stored binding names, as the permission layer spells it. */
function principalOfBinding(binding: BindingWithRole['binding']): PrincipalRef {
  return { type: binding.principalType, id: binding.principalId };
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
