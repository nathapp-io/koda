import { Injectable } from '@nestjs/common';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient, User } from '@prisma/client';
import { GlobalLock, lockGlobal } from '../common/utils/advisory-lock';
import { GlobalRole, UserAdminRecord, UserAdminWrite, UserListFilters } from './domain/user-admin.domain';

@Injectable()
export class PrismaUsersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  private toRecord(m: User): UserAdminRecord {
    return {
      id: m.id, email: m.email, name: m.name, role: m.role,
      disabled: m.disabled, createdAt: m.createdAt, updatedAt: m.updatedAt,
    };
  }

  async findUserPage(filters: UserListFilters, page: IPageOption): Promise<IPageResult<UserAdminRecord>> {
    const where: Prisma.UserWhereInput = filters.email
      ? { email: { contains: filters.email, mode: 'insensitive' } }
      : {};
    const rows = await Paginate(this.db.user, page, { where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.remap((m: User) => this.toRecord(m));
  }

  async findById(id: string): Promise<UserAdminRecord | null> {
    const m = await this.db.user.findUnique({ where: { id } });
    return m ? this.toRecord(m) : null;
  }

  /** Case-insensitive: the unique index is case-sensitive, the product is not. */
  async findByEmail(email: string): Promise<{ id: string } | null> {
    const m = await this.db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    return m;
  }

  async createUser(data: { email: string; name: string; passwordHash: string; role: GlobalRole }): Promise<UserAdminRecord> {
    return this.toRecord(await this.db.user.create({ data }));
  }

  async countActiveAdmins(): Promise<number> {
    return this.db.user.count({ where: { role: 'ADMIN', disabled: false } });
  }

  async updateUser(id: string, write: UserAdminWrite): Promise<UserAdminRecord> {
    const m = await this.db.user.update({
      where: { id },
      data: {
        ...(write.role !== undefined && { role: write.role }),
        ...(write.disabled !== undefined && { disabled: write.disabled }),
        ...(write.bumpTokenVersion && { tokenVersion: { increment: 1 } }),
      },
    });
    return this.toRecord(m);
  }

  /** Serializes last-admin checks. Call inside txManager.run only. */
  async lockUserAdministration(): Promise<void> {
    await lockGlobal(this.db, GlobalLock.USER_ADMINISTRATION);
  }
}
