import { Inject, Injectable } from '@nestjs/common';
import {
  AbstractPrismaRepository,
  PrismaClientLike,
  PrismaModelDelegate,
  PrismaService,
} from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Paginate } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient, Role as RoleModel, RoleBinding as RoleBindingModel } from '../generated/prisma/client';
import type {
  BindingFilter,
  BindingWithRole,
  GranterType,
  NewRoleBinding,
  PrincipalRef,
  PrincipalType,
  RoleBindingDomain,
  RoleBindingRepository,
  RoleScope,
  UserLegacyState,
} from './permissions.types';

type BindingWithRoleModel = RoleBindingModel & { role: RoleModel };

/** The role keys whose `projectId`-null bindings make a user a global admin. */
const GLOBAL_ADMIN_ROLE_KEYS = ['owner', 'admin'];
/** Upper bound of owner bindings read for the last-owner count; owners are a handful of rows. */
const OWNER_BINDING_SCAN_LIMIT = 10_000;

/**
 * Permissions P1a: the only code that reads or writes `RoleBinding` through Prisma.
 *
 * `principalId` has no foreign key — it names a `User` or an `Agent` — so the principal's existence is
 * checked by the services that write a binding, never by the database.
 */
@Injectable()
export class PrismaRoleBindingRepository
  extends AbstractPrismaRepository<RoleBindingDomain, RoleBindingModel, string>
  implements RoleBindingRepository
{
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<RoleBindingModel, string> {
    return (client as unknown as PrismaClient).roleBinding as unknown as PrismaModelDelegate<
      RoleBindingModel,
      string
    >;
  }

  protected toDomain(model: RoleBindingModel): RoleBindingDomain {
    return {
      id: model.id,
      principalType: model.principalType as PrincipalType,
      principalId: model.principalId,
      roleId: model.roleId,
      projectId: model.projectId,
      grantedByType: model.grantedByType as GranterType,
      grantedById: model.grantedById,
      createdAt: model.createdAt,
    };
  }

  protected toPersistenceCreate(
    domain: RoleBindingDomain,
  ): Omit<RoleBindingModel, 'id' | 'createdAt'> {
    return {
      principalType: domain.principalType,
      principalId: domain.principalId,
      roleId: domain.roleId,
      projectId: domain.projectId,
      grantedByType: domain.grantedByType,
      grantedById: domain.grantedById,
    };
  }

  protected toPersistenceUpdate(
    patch: Partial<RoleBindingDomain>,
  ): Partial<Omit<RoleBindingModel, 'id' | 'createdAt'>> {
    const data: Partial<Omit<RoleBindingModel, 'id' | 'createdAt'>> = {};
    if (patch.principalType !== undefined) data.principalType = patch.principalType;
    if (patch.principalId !== undefined) data.principalId = patch.principalId;
    if (patch.roleId !== undefined) data.roleId = patch.roleId;
    if (patch.projectId !== undefined) data.projectId = patch.projectId;
    if (patch.grantedByType !== undefined) data.grantedByType = patch.grantedByType;
    if (patch.grantedById !== undefined) data.grantedById = patch.grantedById;
    return data;
  }

  /** A new binding has no id yet: Prisma's `cuid()` default assigns it on insert. */
  async createBinding(input: NewRoleBinding): Promise<RoleBindingDomain> {
    return this.create({ ...input, id: '', createdAt: new Date() });
  }

  private get db() {
    return this.prisma.client;
  }

  private toBindingWithRole(model: BindingWithRoleModel): BindingWithRole {
    return {
      binding: this.toDomain(model),
      roleKey: model.role.key,
      roleScope: model.role.scope as RoleScope,
      rolePermissions: Array.isArray(model.role.permissions)
        ? model.role.permissions.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  }

  private principalWhere(principal: PrincipalRef): Prisma.RoleBindingWhereInput {
    return { principalType: principal.type, principalId: principal.id };
  }

  /** Bindings of the principal that apply in `projectId` (or only the global ones when null). */
  async findEffectiveBindings(principal: PrincipalRef, projectId: string | null): Promise<BindingWithRole[]> {
    const rows = await this.db.roleBinding.findMany({
      where: {
        ...this.principalWhere(principal),
        ...(projectId === null ? { projectId: null } : { OR: [{ projectId: null }, { projectId }] }),
      },
      include: { role: true },
      take: OWNER_BINDING_SCAN_LIMIT,
    });
    return rows.map((row: BindingWithRoleModel) => this.toBindingWithRole(row));
  }

  async findPrincipalBindings(principal: PrincipalRef): Promise<BindingWithRole[]> {
    const rows = await this.db.roleBinding.findMany({
      where: this.principalWhere(principal),
      include: { role: true },
      take: OWNER_BINDING_SCAN_LIMIT,
    });
    return rows.map((row: BindingWithRoleModel) => this.toBindingWithRole(row));
  }

  async findExisting(
    principal: PrincipalRef,
    roleId: string,
    projectId: string | null,
  ): Promise<RoleBindingDomain | null> {
    const row = await this.db.roleBinding.findFirst({
      where: { ...this.principalWhere(principal), roleId, projectId },
    });
    return row ? this.toDomain(row) : null;
  }

  async findViewById(id: string): Promise<BindingWithRole | null> {
    const row = await this.db.roleBinding.findUnique({ where: { id }, include: { role: true } });
    return row ? this.toBindingWithRole(row) : null;
  }

  async findViewPage(filter: BindingFilter, page: IPageOption): Promise<IPageResult<BindingWithRole>> {
    const where: Prisma.RoleBindingWhereInput = {
      ...(filter.principal ? this.principalWhere(filter.principal) : {}),
      ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
    };
    const result = await Paginate(this.db.roleBinding, page, {
      where,
      include: { role: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return result.remap((row: BindingWithRoleModel) => this.toBindingWithRole(row));
  }

  /** True when a row was deleted; false when it was already gone. */
  async deleteById(id: string): Promise<boolean> {
    const result = await this.db.roleBinding.deleteMany({ where: { id } });
    return result.count > 0;
  }

  /** How many bindings reference a role. A non-zero count is why a role cannot be deleted. */
  async countByRole(roleId: string): Promise<number> {
    return this.db.roleBinding.count({ where: { roleId } });
  }

  async deleteForPrincipal(principal: PrincipalRef): Promise<void> {
    await this.db.roleBinding.deleteMany({ where: this.principalWhere(principal) });
  }

  /**
   * Deletes the principal's bindings in one project and answers how many rows went away. Restricted to
   * the roles named by `roleKeys` when given. A `projectId`-null binding is a different projectId and
   * is never matched; a legacy `ProjectMember` row is a different table and is never touched.
   */
  async deleteProjectBindings(
    principal: PrincipalRef,
    projectId: string,
    roleKeys?: readonly string[],
  ): Promise<number> {
    const result = await this.db.roleBinding.deleteMany({
      where: {
        ...this.principalWhere(principal),
        projectId,
        ...(roleKeys === undefined ? {} : { role: { key: { in: [...roleKeys] } } }),
      },
    });
    return result.count;
  }

  /**
   * Takes the `owner` Role row lock (`SELECT … FOR UPDATE`) and returns its id, or null when the role
   * is not seeded. Call inside `txManager.run` only: the lock lives until the transaction ends.
   */
  async lockOwnerRole(): Promise<string | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Role" WHERE "key" = 'owner' FOR UPDATE`;
    return rows[0]?.id ?? null;
  }

  /**
   * Takes the user's row lock (`SELECT … FOR UPDATE`) so the legacy `User.role` mirror of concurrent
   * global `owner`/`admin` binding writes of that user is decided one transaction at a time: without
   * it, two removals each count the other's uncommitted binding as still present and neither demotes.
   * Call inside `txManager.run` only, after `lockOwnerRole` when the same write takes that one too —
   * never in the opposite order, or two transactions deadlock.
   */
  async lockUser(userId: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  }

  /** Owner bindings of enabled users, leaving out `excludeIds` (the bindings about to be removed). */
  async countEnabledOwnerBindings(ownerRoleId: string, excludeIds: readonly string[]): Promise<number> {
    const owners = await this.db.roleBinding.findMany({
      where: { roleId: ownerRoleId, principalType: 'USER', id: { notIn: [...excludeIds] } },
      select: { principalId: true },
      take: OWNER_BINDING_SCAN_LIMIT,
    });
    if (owners.length === 0) return 0;
    return this.db.user.count({
      where: { id: { in: owners.map((owner: { principalId: string }) => owner.principalId) }, disabled: false },
    });
  }

  /** Global `owner` or `admin` bindings of the user (`projectId` null). */
  async countGlobalAdminBindings(userId: string): Promise<number> {
    return this.db.roleBinding.count({
      where: {
        principalType: 'USER',
        principalId: userId,
        projectId: null,
        role: { key: { in: GLOBAL_ADMIN_ROLE_KEYS } },
      },
    });
  }

  async findUserState(userId: string): Promise<UserLegacyState | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { role: true, disabled: true },
    });
    return user ? { role: user.role as UserLegacyState['role'], disabled: user.disabled } : null;
  }

  /**
   * Sets the legacy `User.role` and, in the same statement, bumps `tokenVersion` so the user's tokens
   * stop working. Returns false (and writes nothing) when the role is already `role`.
   */
  async setUserRole(userId: string, role: UserLegacyState['role']): Promise<boolean> {
    const result = await this.db.user.updateMany({
      where: { id: userId, role: { not: role } },
      data: { role, tokenVersion: { increment: 1 } },
    });
    return result.count > 0;
  }

  async principalExists(principal: PrincipalRef): Promise<boolean> {
    if (principal.type === 'USER') {
      return (await this.db.user.count({ where: { id: principal.id } })) > 0;
    }
    return (await this.db.agent.count({ where: { id: principal.id } })) > 0;
  }

  async projectExists(projectId: string): Promise<boolean> {
    return (await this.db.project.count({ where: { id: projectId, deletedAt: null } })) > 0;
  }
}
