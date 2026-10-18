import { Inject, Injectable } from '@nestjs/common';
import {
  AbstractPrismaRepository,
  PrismaClientLike,
  PrismaModelDelegate,
  PrismaService,
} from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient, Role as RoleModel } from '../generated/prisma/client';
import type { RoleDomain, RoleRepository, RoleScope } from './permissions.types';

/** Upper bound of a role list read; the table is small and admin-written. */
const ROLE_SCAN_LIMIT = 500;

/**
 * Permissions P1a: the only code that reads or writes `Role` through Prisma.
 *
 * `Role.permissions` is a JSON column holding the entry list as strings; the repository translates it
 * to and from `RoleDomain.permissions`, so no Prisma `JsonValue` reaches a service or a controller.
 */
@Injectable()
export class PrismaRoleRepository
  extends AbstractPrismaRepository<RoleDomain, RoleModel, string>
  implements RoleRepository
{
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<RoleModel, string> {
    return (client as unknown as PrismaClient).role as unknown as PrismaModelDelegate<RoleModel, string>;
  }

  protected toDomain(model: RoleModel): RoleDomain {
    return {
      id: model.id,
      key: model.key,
      name: model.name,
      description: model.description,
      scope: model.scope as RoleScope,
      system: model.system,
      locked: model.locked,
      permissions: readEntries(model.permissions),
    };
  }

  protected toPersistenceCreate(domain: RoleDomain): Omit<RoleModel, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      key: domain.key,
      name: domain.name,
      description: domain.description,
      scope: domain.scope,
      system: domain.system,
      locked: domain.locked,
      permissions: writeEntries(domain.permissions),
    };
  }

  protected toPersistenceUpdate(
    patch: Partial<RoleDomain>,
  ): Partial<Omit<RoleModel, 'id' | 'createdAt' | 'updatedAt'>> {
    const data: Partial<Omit<RoleModel, 'id' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.key !== undefined) data.key = patch.key;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.scope !== undefined) data.scope = patch.scope;
    if (patch.system !== undefined) data.system = patch.system;
    if (patch.locked !== undefined) data.locked = patch.locked;
    if (patch.permissions !== undefined) data.permissions = writeEntries(patch.permissions);
    return data;
  }

  /** A new role has no id yet: Prisma's `cuid()` default assigns it on insert. */
  async createRole(input: Omit<RoleDomain, 'id'>): Promise<RoleDomain> {
    return this.create({ ...input, id: '' });
  }

  /**
   * The whole role list, system roles first (`Role` is an admin-written table, so it is small).
   * `take` is the bounded-read rule of `.nax/rules/api-data.md`: never a bare `findMany`.
   */
  async findRoles(): Promise<RoleDomain[]> {
    const models = await this.db.role.findMany({
      orderBy: [{ system: 'desc' }, { key: 'asc' }],
      take: ROLE_SCAN_LIMIT,
    });
    return models.map((model: RoleModel) => this.toDomain(model));
  }

  private get db() {
    return this.prisma.client;
  }
}

/**
 * The entry list of a stored role. A malformed column reads as an empty list rather than crashing the
 * API: nothing may grant permissions the row does not literally contain.
 */
function readEntries(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function writeEntries(entries: readonly string[]): string[] {
  return [...entries];
}
