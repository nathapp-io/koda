import { Test } from '@nestjs/testing';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';

describe('UsersModule — DI wiring', () => {
  it('AdminUsersController resolves with its service', async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [{ provide: UsersAdminService, useValue: {} }],
    }).compile();
    expect(module.get(AdminUsersController)).toBeDefined();
    await module.close();
  });
});
