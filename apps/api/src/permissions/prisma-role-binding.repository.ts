import { Inject, Injectable } from '@nestjs/common';
import {
  AbstractPrismaRepository,
  PrismaClientLike,
  PrismaModelDelegate,
  PrismaService,
} from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient, RoleBinding as RoleBindingModel } from '../generated/prisma/client';
import type {
  GranterType,
  NewRoleBinding,
  PrincipalType,
  RoleBindingDomain,
  RoleBindingRepository,
} from './permissions.types';

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
}
