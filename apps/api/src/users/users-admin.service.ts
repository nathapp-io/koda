import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
import { fieldsSummary } from '../audit/audit-summary';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { remapPage } from '../common/dto/koda-page.query';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { userAuthStateCacheKey, userTokenVersionCacheTag } from '../auth/token-version.cache';
import { MembershipService } from '../permissions/membership.service';
import { PrismaUsersRepository } from './prisma-users.repository';
import { UserListFilters } from './domain/user-admin.domain';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAdminDto } from './dto/user-admin.dto';

/**
 * Permissions P1l (US-005): creating a user grants the `member` baseline and nothing else. A global
 * admin is a `POST /role-bindings` grant afterwards, so the create has no role to promote and no
 * granter to record.
 */
@Injectable()
export class UsersAdminService {
  constructor(
    private readonly usersRepo: PrismaUsersRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly cache: CacheManager,
    private readonly membership: MembershipService,
    private readonly audit: AuditRecorder,
  ) {}

  async list(filters: UserListFilters, page: IPageOption): Promise<IPageResult<UserAdminDto>> {
    return remapPage(await this.usersRepo.findUserPage(filters, page), UserAdminDto.from);
  }

  async create(dto: CreateUserDto): Promise<UserAdminDto> {
    // Canonical lower-case; the check is case-insensitive because the default
    // unique index is not (a legacy mixed-case row would otherwise slip through).
    const email = dto.email.trim().toLowerCase();
    if (await this.usersRepo.findByEmail(email)) {
      throw new ConflictAppException({}, 'users');
    }

    // Permissions P1l (US-005): the request carries no role, so every created account is the
    // least-privileged member — roles are bound to it afterwards.
    const passwordHash = await bcrypt.hash(dto.password, 12);
    try {
      // The user row and its baseline binding are one unit (B4): a user whose binding write failed must
      // not stay behind. The cache invalidation the nested write defers lands only after the commit.
      const user = await this.membership.afterCommit(() =>
        this.txManager.run(async () => {
          const created = await this.usersRepo.createUser({
            email,
            name: dto.name,
            passwordHash,
          });
          // Permissions P1a (US-004): every user starts at the member baseline, and stays there.
          await this.membership.bindBaseline({ type: 'USER', id: created.id });
          await this.audit.record({
            key: 'user.create', resourceType: 'user', resourceId: created.id,
            projectId: null, summary: 'created',
          });
          return created;
        }),
      );
      return UserAdminDto.from(user);
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw new ConflictAppException({}, 'users');
      throw error;
    }
  }

  async update(actorId: string, userId: string, patch: UpdateUserDto): Promise<UserAdminDto> {
    const disables = patch.disabled === true;
    // Permissions P1l (US-005): `disabled` is the only patchable field, so a self-disable is the only
    // self-patch the rule refuses; asking to change your own "role" changes nothing at all.
    if (actorId === userId && disables) {
      throw new ForbiddenAppException({}, 'users.self');
    }

    // The permission-cache invalidation of the nested writes is deferred to the `afterCommit` scope,
    // so no request can recompute the user's permissions from the pre-commit state.
    const updated = await this.membership.afterCommit(() =>
      this.txManager.run(async () => {
        await this.usersRepo.lockUserAdministration();
        const target = await this.usersRepo.findById(userId);
        if (!target) throw new NotFoundAppException({}, 'users');

        // The last-admin guard still applies to a disable: disabling the last active global admin would
        // leave the installation unadministrable.
        const removesActiveAdmin = !target.disabled && disables && (await this.membership.isGlobalAdmin(target.id));
        if (removesActiveAdmin && (await this.usersRepo.countActiveAdmins()) <= 1) {
          throw new ConflictAppException({}, 'users.lastAdmin');
        }

        const newlyDisabled = disables && !target.disabled;

        // Permissions P1l (US-005): `update` never grants or removes a binding. Granting the global
        // admin is `POST /role-bindings` (roleKey `admin`, no project); demoting is its `DELETE`.
        const written = await this.usersRepo.updateUser(userId, {
          disabled: patch.disabled,
          bumpTokenVersion: newlyDisabled,
        });
        await this.audit.record({
          key: 'user.update', resourceType: 'user', resourceId: userId,
          projectId: null, summary: fieldsSummary(patch),
        });
        return written;
      }),
    );

    // Tag invalidation covers Redis deployments (tag registry); under the
    // MEMORY strategy there is no registry and tag mode is a no-op, so the
    // cached 60 s auth-state entry is also evicted by its direct key.
    await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
    await this.cache.invalidate(userAuthStateCacheKey(userId));
    return UserAdminDto.from(updated);
  }
}
