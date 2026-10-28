import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetRouteCommands } from './budget-route.commands';
import { BudgetsModule } from './budgets.module';

/** A missing provider or import cycle must fail the database-free unit suite. */
describe('BudgetsModule', () => {
  let moduleRef: TestingModule;
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, BudgetsModule] }).compile();
  });
  afterAll(async () => { await moduleRef?.close(); });

  it('AC-14: compiles and resolves the evaluator and route commands without a database', () => {
    expect(moduleRef.get(BudgetEvaluator)).toBeDefined();
    expect(moduleRef.get(BudgetRouteCommands)).toBeDefined();
  });
});
