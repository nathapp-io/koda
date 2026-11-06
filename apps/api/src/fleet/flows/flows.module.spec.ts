import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { FLEET_FLOW_REPOSITORY } from './domain/fleet-flow.domain';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ApprovalCommandRegistry, type ApprovalCommand } from '../../approvals/approval-command.registry';
import { FleetFlowStartCommand } from './fleet-flow-start.command';
import { FlowsModule } from './flows.module';

describe('FlowsModule', () => {
  let testingModule: TestingModule | undefined;
  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
  });

  it('registers the primary flow-start command without replacing other commands', () => {
    const registry = new ApprovalCommandRegistry();
    const budget = { key: 'fleet.budget.override', parse: vi.fn(), execute: vi.fn() } as unknown as ApprovalCommand;
    const shell = { key: 'fleet.job.shell.escalate', parse: vi.fn(), execute: vi.fn() } as unknown as ApprovalCommand;
    registry.register(budget);
    registry.register(shell);
    const start = { key: 'fleet.flow.start' } as FleetFlowStartCommand;
    const module = new FlowsModule(registry, start);

    module.onModuleInit();

    expect(registry.get('fleet.flow.start')).toBe(start);
    expect(registry.get('fleet.budget.override')).toBe(budget);
    expect(registry.get('fleet.job.shell.escalate')).toBe(shell);
  });

  it('compiles its command providers without a database and registers the command at module init', async () => {
    testingModule = await Test.createTestingModule({
      providers: [
        ApprovalCommandRegistry,
        FleetFlowStartCommand,
        FlowsModule,
        { provide: FLEET_FLOW_REPOSITORY, useValue: { lockById: vi.fn(), findById: vi.fn(), approve: vi.fn(), stop: vi.fn() } },
        { provide: AuditRecorder, useValue: { record: vi.fn() } },
        { provide: FleetActivityService, useValue: { record: vi.fn() } },
      ],
    }).compile();
    const module = testingModule.get(FlowsModule);
    module.onModuleInit();
    expect(testingModule.get(ApprovalCommandRegistry).get('fleet.flow.start')).toBeInstanceOf(FleetFlowStartCommand);
  });
});
