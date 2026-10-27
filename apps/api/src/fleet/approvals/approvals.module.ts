import { Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { FleetBudgetOverrideCommand } from './commands/fleet-budget-override.command';
import { FleetShellEscalateCommand } from './commands/fleet-shell-escalate.command';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ApprovalExpirySweeper } from './approval-expiry-sweeper';
import { ApprovalJobEndSweeper } from './approval-job-end.sweeper';
import { ApprovalStoreModule } from './approval-store.module';
import { ApprovalsService } from './approvals.service';
import { FleetApprovalCountsController } from './fleet-approval-counts.controller';
import { FleetApprovalsController } from './fleet-approvals.controller';
import { ProjectFleetApprovalsController } from './project-fleet-approvals.controller';

/** S1.5 C8 approvals (plan D226): decide, list, counts. Storage and the close port are ApprovalStoreModule. */
@Module({
  imports: [PrismaModule, ApprovalEngineModule, ProjectAccessModule, ApprovalStoreModule, BudgetStoreModule, BudgetsModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetApprovalsController, FleetApprovalsController, FleetApprovalCountsController],
  providers: [ApprovalsService, ApprovalExpirySweeper, ApprovalJobEndSweeper, FleetShellEscalateCommand, FleetBudgetOverrideCommand],
  exports: [ApprovalsService],
})
export class ApprovalsModule implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    private readonly shellEscalate: FleetShellEscalateCommand,
    private readonly budgetOverride: FleetBudgetOverrideCommand,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.shellEscalate);
    this.registry.register(this.budgetOverride);
  }
}
