import { Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { OutboxCoreModule } from '../../outbox/outbox-core.module';
import { LiveModule } from '../../live/live.module';
import { FleetBudgetOverrideCommand } from './commands/fleet-budget-override.command';
import { FleetShellEscalateCommand } from './commands/fleet-shell-escalate.command';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ApprovalJobEndSweeper } from './approval-job-end.sweeper';
import { ApprovalStoreModule } from './approval-store.module';
import { FleetAskEventsSubscriber } from './fleet-ask-events.subscriber';
import { PolicyAskCloseSweeper } from './policy-ask-close.sweeper';

/** Fleet approval engine commands and ask lifecycle workers. */
@Module({
  imports: [
    PrismaModule, OutboxCoreModule, LiveModule, ApprovalEngineModule, ApprovalStoreModule, BudgetStoreModule,
    BudgetsModule, FleetJobsModule, FleetActivityModule,
  ],
  providers: [
    ApprovalJobEndSweeper, PolicyAskCloseSweeper, FleetAskEventsSubscriber,
    FleetShellEscalateCommand, FleetBudgetOverrideCommand,
  ],
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
