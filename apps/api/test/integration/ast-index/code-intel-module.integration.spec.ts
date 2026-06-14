import { Test } from '@nestjs/testing';
import { Module, Global } from '@nestjs/common';
import { CodeIntelModule } from '../../../src/code-intel/code-intel.module';
import { SymbolStore } from '../../../src/code-intel/symbol-store';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

const mockTxManager = {
  run: jest.fn((fn: () => Promise<unknown>) => fn()),
  getClient: jest.fn(),
  isInTransaction: jest.fn(() => false),
};

// Stubs the globally-provided collaborators the real app exposes (PrismaService,
// TRANSACTION_MANAGER, ConfigService) so CodeIntelModule — which pulls in RagModule
// through the module cycle — can compile in isolation.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: {} } },
    { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
    { provide: ConfigService, useValue: { get: (): undefined => undefined } },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, ConfigService],
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
