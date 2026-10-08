import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ApprovalStoreModule } from '../approvals/approval-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetStoreModule } from './budget-store.module';
import { BudgetSweeper } from './budget-sweeper';
import { BudgetsService } from './budgets.service';
import { FleetBudgetsController } from './fleet-budgets.controller';
import { ProjectFleetBudgetsController } from './project-fleet-budgets.controller';
import { BudgetIncidentRecorder } from './budget-incident.recorder';

/** S1b §2 C1 budgets (plan D160): evaluator, sweeper, management routes. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, BudgetStoreModule, ApprovalStoreModule, FleetJobsModule, FleetActivityModule, WebhookModule],
  controllers: [FleetBudgetsController, ProjectFleetBudgetsController],
  providers: [BudgetEvaluator, BudgetIncidentRecorder, BudgetSweeper, BudgetsService],
  exports: [BudgetEvaluator, BudgetsService],
})
export class BudgetsModule {}
