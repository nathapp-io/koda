import { Test } from '@nestjs/testing';
import { Module, Global } from '@nestjs/common';
import { CodeIntelModule } from '../../../src/code-intel/code-intel.module';
import { SymbolStore } from '../../../src/code-intel/symbol-store';
import { PrismaService } from '@nathapp/nestjs-prisma';

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: { client: {} } }],
  exports: [PrismaService],
})
class StubPrismaModule {}

describe('CodeIntelModule - BUG-6: TRANSACTION_MANAGER provision', () => {
  it('should provide TRANSACTION_MANAGER so SymbolStore can be instantiated from CodeIntelModule', async () => {
    const moduleFixture = Test.createTestingModule({
      imports: [StubPrismaModule, CodeIntelModule],
    });

    await expect(moduleFixture.compile()).resolves.toBeDefined();

    const module = await moduleFixture.compile();
    const store = module.get(SymbolStore);
    expect(store).toBeDefined();
  });
});
