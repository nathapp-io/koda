import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalAppException } from '@nathapp/nestjs-common';
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

/** The page size of a read that must answer *every* role of a scope, whatever the table holds. */
const ROLE_READ_PAGE = 500;

/**
 * The safety bound of that read (`.nax/rules/api-data.md`: an unbounded loop needs a hard iteration cap).
 * Five hundred thousand roles is a defect, not a size: reaching it fails instead of answering a partial list,
 * so "every PROJECT role" is never quietly wrong.
 */
const MAX_ROLE_READ_PAGES = 1000;

const logger = new Logger('PrismaRoleRepository');

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

  /**
   * **Every** role of one scope — system roles first, then by key — read in `ROLE_READ_PAGE`-sized keyset
   * pages instead of one capped `findMany`. The scope is a filter, not a cap: `GET /projects/:slug/roles`
   * must answer every PROJECT role a project admin can hand out, and neither role creation nor storage
   * bounds the table, so a single capped read would silently hide the roles past it (and a GLOBAL role would
   * consume a slot of it).
   *
   * Two independent keyset scans (system, then custom) rather than one over `(system, key)`: `Role.key` is
   * unique, so `key > last` is a total order inside each group, and the groups concatenate into exactly the
   * system-first-then-by-key order the route documents.
   */
  async findRolesByScope(scope: RoleScope): Promise<RoleDomain[]> {
    const [system, custom] = await Promise.all([
      this.readRolesOfScope(scope, true),
      this.readRolesOfScope(scope, false),
    ]);
    return [...system, ...custom];
  }

  /** One `(scope, system)` group, keyset-paged on `key` until a short page ends it. */
  private async readRolesOfScope(scope: RoleScope, system: boolean): Promise<RoleDomain[]> {
    const roles: RoleDomain[] = [];
    let cursor: string | undefined;

    for (let page = 1; page <= MAX_ROLE_READ_PAGES; page += 1) {
      const models = await this.db.role.findMany({
        where: { scope, system, ...(cursor === undefined ? {} : { key: { gt: cursor } }) },
        orderBy: { key: 'asc' },
        take: ROLE_READ_PAGE,
      });
      roles.push(...models.map((model: RoleModel) => this.toDomain(model)));
      if (models.length < ROLE_READ_PAGE) return roles;

      cursor = (models[models.length - 1] as RoleModel).key;
      if (page === MAX_ROLE_READ_PAGES) {
        logger.error(
          `findRolesByScope reached its ${MAX_ROLE_READ_PAGES}-page bound for ${scope}/${system ? 'system' : 'custom'} after ${roles.length} roles; refusing to answer a partial role list`,
        );
        throw new InternalAppException({ count: roles.length }, 'permissions');
      }
    }
    return roles;
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
