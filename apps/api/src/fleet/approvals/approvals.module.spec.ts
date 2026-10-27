import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalsModule } from './approvals.module';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { FleetBudgetOverrideCommand } from './commands/fleet-budget-override.command';
import { FleetShellEscalateCommand } from './commands/fleet-shell-escalate.command';
import { ApprovalsService } from './approvals.service';

/** DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('ApprovalsModule', () => {
  it('compiles and resolves the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalsModule] }).compile();
    try {
      await moduleRef.init();
      expect(moduleRef.get(ApprovalsService)).toBeDefined();
      expect(moduleRef.get(ApprovalCommandRegistry).get('fleet.job.shell.escalate')).toBeInstanceOf(FleetShellEscalateCommand);
    } finally {
      await moduleRef.close();
    }
  });

  it('AC-1: registers the budget override command', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalsModule] }).compile();
    try {
      await moduleRef.init();
      expect(moduleRef.get(ApprovalCommandRegistry).get('fleet.budget.override')).toBeInstanceOf(FleetBudgetOverrideCommand);
    } finally {
      await moduleRef.close();
    }
  });
});
