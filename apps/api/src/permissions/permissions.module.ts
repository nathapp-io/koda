import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import { PrismaRoleRepository } from './prisma-role.repository';
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
 * `MembershipService` and `RoleAdminService`. The first two are exported; US-005 adds the third.
 * `PermissionCache` is internal: it is the one invalidation point both services share. The module is
 * imported by `AppModule`, so `SystemRoleSeeder` runs when the API bootstraps.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    PrismaRoleRepository,
    { provide: ROLE_REPOSITORY, useExisting: PrismaRoleRepository },
    PrismaRoleBindingRepository,
    { provide: ROLE_BINDING_REPOSITORY, useExisting: PrismaRoleBindingRepository },
    // A separate token for the same table, so a test can bootstrap the API with another seed list.
    { provide: SYSTEM_ROLES_SEED, useValue: SYSTEM_ROLES },
    SystemRoleSeeder,
    PermissionCache,
    PermissionService,
    MembershipService,
  ],
  exports: [PermissionService, MembershipService],
})
export class PermissionsModule {}
