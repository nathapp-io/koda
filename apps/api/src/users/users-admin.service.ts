import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
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

/** Who the admin routes record as the granter of a global admin binding they created. */
const ADMIN_USERS_GRANTER = { type: 'SYSTEM', id: 'admin-users' } as const;

@Injectable()
export class UsersAdminService {
  constructor(
    private readonly usersRepo: PrismaUsersRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly cache: CacheManager,
    private readonly membership: MembershipService,
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

    const passwordHash = await bcrypt.hash(dto.password, 12);
    try {
      const user = await this.usersRepo.createUser({ email, name: dto.name, passwordHash, role: dto.role });
      // Permissions P1a (US-004): every user starts at the member baseline; an ADMIN also gets the
      // global admin binding, which keeps `User.role` in step with the binding model.
      await this.membership.bindBaseline({ type: 'USER', id: user.id });
      if (dto.role === 'ADMIN') {
        await this.membership.setGlobalAdmin(user.id, true, ADMIN_USERS_GRANTER);
      }
      return UserAdminDto.from(user);
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw new ConflictAppException({}, 'users');
      throw error;
    }
  }

  async update(actorId: string, userId: string, patch: UpdateUserDto): Promise<UserAdminDto> {
    const demotes = patch.role !== undefined && patch.role !== 'ADMIN';
    const disables = patch.disabled === true;
    if (actorId === userId && (demotes || disables)) {
      throw new ForbiddenAppException({}, 'users.self');
    }

    const updated = await this.txManager.run(async () => {
      await this.usersRepo.lockUserAdministration();
      const target = await this.usersRepo.findById(userId);
      if (!target) throw new NotFoundAppException({}, 'users');

      const removesActiveAdmin = target.role === 'ADMIN' && !target.disabled && (demotes || disables);
      if (removesActiveAdmin && (await this.usersRepo.countActiveAdmins()) <= 1) {
        throw new ConflictAppException({}, 'users.lastAdmin');
      }

      const newlyDisabled = disables && !target.disabled;

      // Permissions P1a (US-004): the role column belongs to the binding model. `setGlobalAdmin`
      // removes only a global `admin` binding (an Owner keeps `ADMIN`) and revokes the user's tokens
      // when the role changed, so `update` no longer writes `role` and no longer bumps for it.
      if (patch.role !== undefined) {
        await this.membership.setGlobalAdmin(userId, patch.role === 'ADMIN', { type: 'USER', id: actorId });
      }

      // Read back through the update so the response carries the stored role — after a requested
      // demotion of an Owner that is still `ADMIN`, not the `MEMBER` the patch asked for.
      return this.usersRepo.updateUser(userId, {
        disabled: patch.disabled,
        bumpTokenVersion: newlyDisabled,
      });
    });

    // Tag invalidation covers Redis deployments (tag registry); under the
    // MEMORY strategy there is no registry and tag mode is a no-op, so the
    // cached 60 s auth-state entry is also evicted by its direct key.
    await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
    await this.cache.invalidate(userAuthStateCacheKey(userId));
    return UserAdminDto.from(updated);
  }
}
