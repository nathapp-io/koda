import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { BudgetGate } from './budget-gate';
import { BudgetScopeLabels } from './budget-scope-labels';
import { BUDGET_REPOSITORY } from './domain/budget.domain';
import { PrismaBudgetRepository } from './prisma-budget.repository';

/** Plan D160: budget storage and the pause gate, importable by the jobs module without a cycle. */
@Module({
  imports: [PrismaModule],
  providers: [PrismaBudgetRepository, { provide: BUDGET_REPOSITORY, useExisting: PrismaBudgetRepository }, BudgetGate, BudgetScopeLabels],
  exports: [BUDGET_REPOSITORY, BudgetGate, BudgetScopeLabels],
})
export class BudgetStoreModule {}
