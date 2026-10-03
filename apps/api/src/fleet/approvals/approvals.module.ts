import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ApprovalExpirySweeper } from './approval-expiry-sweeper';
import { ApprovalStoreModule } from './approval-store.module';
import { ApprovalsService } from './approvals.service';
import { FleetApprovalCountsController } from './fleet-approval-counts.controller';
import { FleetApprovalsController } from './fleet-approvals.controller';
import { ProjectFleetApprovalsController } from './project-fleet-approvals.controller';

/** S1.5 C8 approvals (plan D226): decide, list, counts. Storage and the close port are ApprovalStoreModule. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, ApprovalStoreModule, BudgetStoreModule, BudgetsModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetApprovalsController, FleetApprovalsController, FleetApprovalCountsController],
  providers: [ApprovalsService, ApprovalExpirySweeper],
})
export class ApprovalsModule {}
