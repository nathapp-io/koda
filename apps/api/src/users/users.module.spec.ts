import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { UsersModule } from './users.module';
import { UserRouteCommands } from './user-route.commands';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';
import { PrismaUsersRepository } from './prisma-users.repository';

describe('UsersModule', () => {
  let module: TestingModule;
  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, UsersModule] }).compile();
    await module.init();
  });
  afterEach(async () => { await module?.close(); });
  it('resolves the controller, service and repository from the real module', () => {
    expect(module.get(AdminUsersController)).toBeInstanceOf(AdminUsersController);
    expect(module.get(UsersAdminService)).toBeInstanceOf(UsersAdminService);
    expect(module.get(PrismaUsersRepository)).toBeInstanceOf(PrismaUsersRepository);
  });
  it('AC-7: resolves and initializes the user update command', () => {
    expect(module.get(UserRouteCommands)).toBeInstanceOf(UserRouteCommands);
    expect(module.get(ApprovalCommandRegistry).get('user.update', 'rest:admin-users.update')).toMatchObject({ key: 'user.update' });
  });
});
