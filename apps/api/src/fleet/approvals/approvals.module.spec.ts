import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalsModule } from './approvals.module';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { FleetBudgetOverrideCommand } from './commands/fleet-budget-override.command';
import { FleetShellEscalateCommand } from './commands/fleet-shell-escalate.command';
import { FleetAskEventsSubscriber } from './fleet-ask-events.subscriber';

describe('ApprovalsModule', () => {
  it('AC-3: resolves and registers both engine commands during module initialization', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalsModule] }).compile();
    try {
      await moduleRef.init();
      expect(moduleRef.get(FleetShellEscalateCommand)).toBeInstanceOf(FleetShellEscalateCommand);
      expect(moduleRef.get(FleetBudgetOverrideCommand)).toBeInstanceOf(FleetBudgetOverrideCommand);
      const registry = moduleRef.get(ApprovalCommandRegistry);
      expect(registry.get('fleet.job.shell.escalate')).toBeInstanceOf(FleetShellEscalateCommand);
      expect(registry.get('fleet.budget.override')).toBeInstanceOf(FleetBudgetOverrideCommand);
    } finally {
      await moduleRef.close();
    }
  });

  it('US-009: resolves the one recorder of engine-side fleet events', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalsModule] }).compile();
    try {
      await moduleRef.init();
      expect(moduleRef.get(FleetAskEventsSubscriber)).toBeInstanceOf(FleetAskEventsSubscriber);
    } finally {
      await moduleRef.close();
    }
  });
});
