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
import { PrismaUsersRepository } from './prisma-users.repository';
import { UserListFilters } from './domain/user-admin.domain';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAdminDto } from './dto/user-admin.dto';

@Injectable()
export class UsersAdminService {
  constructor(
    private readonly usersRepo: PrismaUsersRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly cache: CacheManager,
  ) {}

  async list(filters: UserListFilters, page: IPageOption): Promise<IPageResult<UserAdminDto>> {
    return remapPage(await this.usersRepo.findUserPage(filters, page), UserAdminDto.from);
  }

  async create(dto: CreateUserDto): Promise<UserAdminDto> {
    const passwordHash = await bcrypt.hash(dto.password, 12);
    try {
      const user = await this.usersRepo.createUser({ email: dto.email, name: dto.name, passwordHash, role: dto.role });
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

      // The access token carries `role`, so a role change revokes it as well.
      const roleChanged = patch.role !== undefined && patch.role !== target.role;
      const newlyDisabled = disables && !target.disabled;
      return this.usersRepo.updateUser(userId, {
        role: patch.role,
        disabled: patch.disabled,
        bumpTokenVersion: roleChanged || newlyDisabled,
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
