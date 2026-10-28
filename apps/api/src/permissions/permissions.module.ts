import { Global, Inject, Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { AfterCommitService } from './after-commit.service';
import { MembershipService } from './membership.service';
import { PermissionCatalogController } from './permission-catalog.controller';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import { PrismaRoleRepository } from './prisma-role.repository';
import { RoleAdminService } from './role-admin.service';
import {
  ROLE_BINDING_REPOSITORY,
  ROLE_REPOSITORY,
  SYSTEM_ROLES_SEED,
} from './permissions.tokens';
import { SYSTEM_ROLES } from './system-roles';
import { SystemRoleSeeder } from './system-role.seeder';

/**
 * Permissions P1a: the role and binding model, and the system roles every installation starts with.
 *
 * The module is global because permission checks run in every feature module. The repositories stay
 * module-private (`.nax/rules/api-data.md`): the public surface is `PermissionService`,
 * `MembershipService` and `RoleAdminService`. All three are exported.
 * `PermissionCache` is internal: it is the one invalidation point the services share. The module is
 * imported by `AppModule`, so `SystemRoleSeeder` runs when the API bootstraps.
 * `AfterCommitService` is exported for a transaction owner outside this module: the approval
 * execution runs a role or binding command inside its own transaction and must open the scope those
 * writes defer their cache invalidation into. It must be the same instance the permission services
 * inject, which the global module guarantees.
 *
 * `onModuleInit` is the owner bootstrap's fail-fast (US-004): in production an installation with no
 * `KODA_OWNER_EMAIL` cannot be configured later — the first registration is already taken — so the API
 * refuses to start instead of creating an Owner nobody chose.
 *
 * Permissions P3e-1 (US-004): the role and binding routes live in `PermissionsApiModule`, which needs
 * the approval engine. This module stays free of that import, so every feature that reads
 * `PermissionService` never drags the engine in.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [PermissionCatalogController],
  providers: [
    PrismaRoleRepository,
    { provide: ROLE_REPOSITORY, useExisting: PrismaRoleRepository },
    PrismaRoleBindingRepository,
    { provide: ROLE_BINDING_REPOSITORY, useExisting: PrismaRoleBindingRepository },
    // A separate token for the same table, so a test can bootstrap the API with another seed list.
    { provide: SYSTEM_ROLES_SEED, useValue: SYSTEM_ROLES },
    SystemRoleSeeder,
    PermissionCache,
    // `MembershipService` and `RoleAdminService` defer their cache invalidation through it; the
    // approval execution opens the scope for a gated permission write, so it is exported.
    AfterCommitService,
    PermissionService,
    MembershipService,
    RoleAdminService,
  ],
  exports: [PermissionService, MembershipService, RoleAdminService, AfterCommitService],
})
export class PermissionsModule implements OnModuleInit {
  constructor(@Inject(AUTH_CFG) private readonly authConfig: IAuthConfig) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'production' && !this.authConfig.ownerEmail) {
      throw new Error('permissions.ownerEmailRequired');
    }
  }
}
