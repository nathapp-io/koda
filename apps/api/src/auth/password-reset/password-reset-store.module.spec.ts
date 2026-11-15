import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PasswordResetStoreModule } from './password-reset-store.module';
import { PasswordResetTokenStore } from './password-reset-token.store';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: {} } },
    { provide: TRANSACTION_MANAGER, useValue: { run: (fn: () => Promise<unknown>) => fn(), getClient: () => ({}), isInTransaction: () => false } },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER],
})
class StubsModule {}

describe('PasswordResetStoreModule', () => {
  let module: TestingModule;
  afterEach(async () => { await module?.close(); });
  it('compiles without a database and exports only the store', async () => {
    module = await Test.createTestingModule({ imports: [StubsModule, PasswordResetStoreModule] }).compile();
    expect(module.get(PasswordResetTokenStore)).toBeInstanceOf(PasswordResetTokenStore);
    expect(Reflect.getMetadata('exports', PasswordResetStoreModule)).toEqual([PasswordResetTokenStore]);
  });
});
