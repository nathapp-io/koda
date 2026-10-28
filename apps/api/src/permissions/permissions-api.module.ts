import { Module } from '@nestjs/common';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { PermissionRouteCommands } from './permission-route.commands';
import { RoleBindingsController } from './role-bindings.controller';
import { RolesController } from './roles.controller';

/**
 * US-004: the API home of the permission routes.
 *
 * The role and binding controllers moved out of the global `PermissionsModule` so that module never
 * imports the approval engine: the engine is needed here only because these handlers are gated. The
 * services they call (`RoleAdminService`, `MembershipService`) stay in the global module, which every
 * feature already sees.
 *
 * `PermissionCatalogController` stays behind: it is a read of the catalog and asks the engine nothing.
 *
 * `PermissionRouteCommands` registers this module's route variants in `onModuleInit`, on the one
 * registry instance `ApprovalEngineModule` exports.
 */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule],
  controllers: [RolesController, RoleBindingsController],
  providers: [PermissionRouteCommands],
})
export class PermissionsApiModule {}
