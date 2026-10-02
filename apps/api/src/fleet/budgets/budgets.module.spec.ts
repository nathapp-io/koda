import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetsModule } from './budgets.module';

/** DI guard, as fleet-jobs.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('BudgetsModule', () => {
  it('compiles and resolves the evaluator', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, BudgetsModule] }).compile();
    try {
      expect(moduleRef.get(BudgetEvaluator)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
