import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalsModule } from './approvals.module';
import { ApprovalsService } from './approvals.service';

/** DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('ApprovalsModule', () => {
  it('compiles and resolves the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalsModule] }).compile();
    try {
      expect(moduleRef.get(ApprovalsService)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
