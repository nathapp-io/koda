import { Test, TestingModule } from '@nestjs/testing';
import { CodeIntelModule } from './code-intel.module';
import { SymbolStore } from './symbol-store';
import { AstIndexService } from './ast-index.service';
import { CodeGraphService } from './code-graph.service';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { ImpactAnalysisService } from './impact-analysis.service';
import { CodeIntelController } from './code-intel.controller';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

describe('CodeIntelModule (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('compiles with the global stub providers and no database', async () => {
    await expect(
      Test.createTestingModule({
        imports: [GlobalStubsModule, CodeIntelModule],
      }).compile(),
    ).resolves.toBeDefined();
  });

  describe('providers', () => {
    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, CodeIntelModule],
      }).compile();
    });

    it('registers SymbolStore', () => {
      expect(moduleRef.get(SymbolStore)).toBeInstanceOf(SymbolStore);
    });

    it('registers AstIndexService', () => {
      expect(moduleRef.get(AstIndexService)).toBeInstanceOf(AstIndexService);
    });

    it('registers CodeGraphService', () => {
      expect(moduleRef.get(CodeGraphService)).toBeInstanceOf(CodeGraphService);
    });

    it('registers CodeCommitOutboxHandler', () => {
      expect(moduleRef.get(CodeCommitOutboxHandler)).toBeInstanceOf(CodeCommitOutboxHandler);
    });

    it('registers ImpactAnalysisService', () => {
      expect(moduleRef.get(ImpactAnalysisService)).toBeInstanceOf(ImpactAnalysisService);
    });

    it('registers CodeIntelController', () => {
      expect(moduleRef.get(CodeIntelController)).toBeInstanceOf(CodeIntelController);
    });
  });

  describe('BUG-6 regression: TRANSACTION_MANAGER is provisioned for SymbolStore', () => {
    it('SymbolStore can be resolved from CodeIntelModule (requires TRANSACTION_MANAGER upstream)', async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, CodeIntelModule],
      }).compile();

      const store = moduleRef.get(SymbolStore);
      expect(store).toBeDefined();
    });
  });
});
