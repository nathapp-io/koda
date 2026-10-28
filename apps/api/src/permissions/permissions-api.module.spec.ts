/**
 * US-004 AC-15 — `PermissionsApiModule` is the engine-facing home of the role routes.
 *
 * The permission routes left the global `PermissionsModule` so that module stays free of an
 * `ApprovalEngineModule` import. This spec is the DB-free wiring guard for the new module: it must
 * compile with the shared stubs, resolve the two controllers and the command registrar, and the
 * registrar must have registered its variants once the application bootstraps.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { PERMISSION_ROUTE_VARIANTS, PermissionRouteCommands } from './permission-route.commands';
import { PermissionsApiModule } from './permissions-api.module';
import { RoleBindingsController } from './role-bindings.controller';
import { RolesController } from './roles.controller';

describe('PermissionsApiModule', () => {
  let moduleRef: TestingModule;

  const build = (): Promise<TestingModule> =>
    Test.createTestingModule({ imports: [GlobalStubsModule, PermissionsApiModule] }).compile();

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('AC-15: compiles with GlobalStubsModule and resolves the controllers and PermissionRouteCommands', async () => {
    moduleRef = await build();

    expect(moduleRef.get(RolesController)).toBeInstanceOf(RolesController);
    expect(moduleRef.get(RoleBindingsController)).toBeInstanceOf(RoleBindingsController);
    expect(moduleRef.get(PermissionRouteCommands)).toBeInstanceOf(PermissionRouteCommands);
  });

  it('AC-15: after onModuleInit the registry answers each role and binding variant under its gate key', async () => {
    moduleRef = await build();
    expect(moduleRef.get(ApprovalCommandRegistry).get('role.manage', PERMISSION_ROUTE_VARIANTS.roleCreate))
      .toBeUndefined();

    await moduleRef.init();

    const registry = moduleRef.get(ApprovalCommandRegistry);
    for (const variant of [PERMISSION_ROUTE_VARIANTS.roleCreate, PERMISSION_ROUTE_VARIANTS.roleUpdate, PERMISSION_ROUTE_VARIANTS.roleDelete]) {
      expect(registry.get('role.manage', variant)).toMatchObject({ key: 'role.manage', variant });
    }
    for (const key of ['role.binding.owner', 'role.binding.global', 'role.binding.manage']) {
      for (const variant of [PERMISSION_ROUTE_VARIANTS.bindingCreate, PERMISSION_ROUTE_VARIANTS.bindingDelete]) {
        expect(registry.get(key, variant)).toMatchObject({ key, variant });
      }
    }
  });
});
