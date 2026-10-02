import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetSweeper } from './budget-sweeper';
import { BudgetStoreModule } from './budget-store.module';

/** S1b §2 C1 budgets (plan D160): evaluator, sweeper, management. */
@Module({
  imports: [PrismaModule, BudgetStoreModule, FleetJobsModule, FleetActivityModule, WebhookModule],
  providers: [BudgetEvaluator, BudgetSweeper],
  exports: [BudgetEvaluator],
})
export class BudgetsModule {}
