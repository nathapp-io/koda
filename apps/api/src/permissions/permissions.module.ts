import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
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
 * `MembershipService` and `RoleAdminService`, which US-003 and US-005 add to `exports` as they are
 * implemented. Until then the module still has to be imported by `AppModule`, so that
 * `SystemRoleSeeder` runs when the API bootstraps.
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
  ],
  exports: [],
})
export class PermissionsModule {}
