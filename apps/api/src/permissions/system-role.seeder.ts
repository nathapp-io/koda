import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runAsSystem } from '../action-context/action-context';
import { expandEntries } from './entry-matcher';
import type { RoleDomain, RoleRepository, RoleSeed } from './permissions.types';
import { ROLE_REPOSITORY, SYSTEM_ROLES_SEED } from './permissions.tokens';

/**
 * Permissions P1a: seeds the eleven system roles on every application bootstrap.
 *
 * The seed list is injected through `SYSTEM_ROLES_SEED` (`PermissionsModule` binds `SYSTEM_ROLES`), so a
 * test can bootstrap the API with another list.
 *
 * Rules (design §"Seeded system roles"):
 * - every seed is validated with `expandEntries` **before the first write**, so an invalid entry stops
 *   the API instead of half-seeding it;
 * - a missing role is created;
 * - a locked role is restored from the seed when its permissions, name or scope differ;
 * - an unlocked system role keeps its stored permissions (admins may edit them), while its name and
 *   scope are reset to the seed;
 * - no row is ever deleted.
 */
@Injectable()
export class SystemRoleSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemRoleSeeder.name);

  constructor(
    @Inject(SYSTEM_ROLES_SEED) private readonly seeds: readonly RoleSeed[],
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
  ) {}

  /** Permissions P2 US-005: the boot hook is the background entry, so the seed writes as `seed`. */
  async onApplicationBootstrap(): Promise<void> {
    await runAsSystem('seed', () => this.seedAll());
  }

  private async seedAll(): Promise<void> {
    for (const seed of this.seeds) this.validate(seed);
    for (const seed of this.seeds) await this.seedRole(seed);
  }

  /** Throws `UnknownPermissionEntryError` / `ScopeMismatchEntryError` on a bad entry. */
  private validate(seed: RoleSeed): void {
    expandEntries(seed.permissions, seed.scope);
  }

  private async seedRole(seed: RoleSeed): Promise<void> {
    const stored = await this.roles.findOne({ key: seed.key });
    if (stored === null) {
      await this.roles.createRole(this.newRole(seed));
      this.logger.log(`seeded system role '${seed.key}'`);
      return;
    }

    const patch = this.patchFor(stored, seed);
    if (Object.keys(patch).length === 0) return;
    await this.roles.update(stored.id, patch);
    this.logger.log(`restored system role '${seed.key}'`);
  }

  private newRole(seed: RoleSeed): Omit<RoleDomain, 'id'> {
    return {
      key: seed.key,
      name: seed.name,
      description: seed.description ?? '',
      scope: seed.scope,
      system: seed.system ?? true,
      locked: seed.locked ?? false,
      permissions: [...seed.permissions],
    };
  }

  /**
   * The columns this bootstrap must rewrite, if any. A locked role is owned by its seed, so a custom
   * edit is rolled back; an unlocked system role keeps the permissions an admin gave it.
   */
  private patchFor(stored: RoleDomain, seed: RoleSeed): Partial<RoleDomain> {
    const nameDiffers = stored.name !== seed.name;
    const scopeDiffers = stored.scope !== seed.scope;

    if (stored.locked) {
      const permissionsDiffer = !sameEntries(stored.permissions, seed.permissions);
      if (!permissionsDiffer && !nameDiffers && !scopeDiffers) return {};
      return {
        name: seed.name,
        scope: seed.scope,
        permissions: [...seed.permissions],
      };
    }

    if (!nameDiffers && !scopeDiffers) return {};
    return { name: seed.name, scope: seed.scope };
  }
}

/** Entry lists are compared as order-sensitive lists: the seed's order is part of the seed. */
function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
