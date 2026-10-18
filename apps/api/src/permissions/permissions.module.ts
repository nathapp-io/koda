import { Global, Inject, Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from './membership.service';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import { PrismaRoleRepository } from './prisma-role.repository';
import { RoleAdminService } from './role-admin.service';
import { RoleBindingsController } from './role-bindings.controller';
import { RolesController } from './roles.controller';
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
 *
 * `onModuleInit` is the owner bootstrap's fail-fast (US-004): in production an installation with no
 * `KODA_OWNER_EMAIL` cannot be configured later — the first registration is already taken — so the API
 * refuses to start instead of creating an Owner nobody chose.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [RolesController, RoleBindingsController],
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
    RoleAdminService,
  ],
  exports: [PermissionService, MembershipService, RoleAdminService],
})
export class PermissionsModule implements OnModuleInit {
  constructor(@Inject(AUTH_CFG) private readonly authConfig: IAuthConfig) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'production' && !this.authConfig.ownerEmail) {
      throw new Error('permissions.ownerEmailRequired');
    }
  }
}
