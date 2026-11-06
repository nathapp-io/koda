import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { ApprovalAskService } from '../../approvals/approval-ask.service';
import { AuditLogModule } from '../../audit/audit-log.module';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { FleetReposService } from '../repos/fleet-repos.service';
import { ThreadsModule } from '../threads/threads.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectAccessService } from '../../projects/project-access.service';
import { RequiresGuard } from '../../permissions/requires.guard';
import { PermissionService } from '../../permissions/permission.service';
import { ThreadsService } from '../threads/threads.service';
import { ApprovalCommandRegistry, type ApprovalCommand } from '../../approvals/approval-command.registry';
import { FleetFlowStartCommand } from './fleet-flow-start.command';
import { FleetFlowsService } from './fleet-flows.service';
import { FlowsModule } from './flows.module';
import { FLEET_FLOW_REPOSITORY } from './domain/fleet-flow.domain';
import { PrismaFleetFlowRepository } from './prisma-fleet-flow.repository';

@Module({
  providers: [
    ApprovalCommandRegistry,
    { provide: ApprovalAskService, useValue: { open: vi.fn(), close: vi.fn() } },
    { provide: ApprovalRouteGate, useValue: { run: vi.fn() } },
  ],
  exports: [ApprovalCommandRegistry, ApprovalAskService, ApprovalRouteGate],
})
class StubApprovalEngineModule {}
@Module({ providers: [{ provide: AuditRecorder, useValue: { record: vi.fn() } }], exports: [AuditRecorder] })
class StubAuditLogModule {}
@Module({ providers: [{ provide: FleetActivityService, useValue: { record: vi.fn() } }], exports: [FleetActivityService] })
class StubFleetActivityModule {}
@Module({
  providers: [{ provide: FleetReposService, useValue: { findByIdentity: vi.fn(), lockById: vi.fn() } }],
  exports: [FleetReposService],
})
class StubFleetReposModule {}
@Module({
  providers: [{ provide: ThreadsService, useValue: { lockForFlow: vi.fn(), consumePreApproval: vi.fn() } }],
  exports: [ThreadsService],
})
class StubThreadsModule {}
const stubTxManager = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) };
@Module({
  providers: [
    { provide: ProjectAccessService, useValue: {} },
    { provide: ProjectMembershipGuard, useValue: {} },
    { provide: PermissionService, useValue: {} },
  ],
  exports: [ProjectAccessService, ProjectMembershipGuard, PermissionService],
})
class StubProjectAccessModule {}
@Module({
  providers: [
    { provide: TRANSACTION_MANAGER, useValue: stubTxManager },
    { provide: PrismaService, useValue: { client: {} } },
  ],
  exports: [TRANSACTION_MANAGER, PrismaService],
})
class StubPrismaModule {}

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

  it('compiles the real module without a database and registers the command through its repository token', async () => {
    testingModule = await Test.createTestingModule({ imports: [FlowsModule] })
      .overrideModule(ApprovalEngineModule).useModule(StubApprovalEngineModule)
      .overrideModule(AuditLogModule).useModule(StubAuditLogModule)
      .overrideModule(FleetActivityModule).useModule(StubFleetActivityModule)
      .overrideModule(FleetReposModule).useModule(StubFleetReposModule)
      .overrideModule(ThreadsModule).useModule(StubThreadsModule)
      .overrideModule(ProjectAccessModule).useModule(StubProjectAccessModule)
      .overrideProvider(ProjectMembershipGuard).useValue({})
      .overrideProvider(ProjectAccessService).useValue({})
      .overrideProvider(RequiresGuard).useValue({})
      .overrideModule(PrismaModule).useModule(StubPrismaModule)
      .overrideProvider(PrismaFleetFlowRepository)
      .useValue({ lockById: vi.fn(), findById: vi.fn(), approve: vi.fn(), stop: vi.fn() })
      .compile();
    await testingModule.init();
    expect(testingModule.get(ApprovalCommandRegistry, { strict: false }).get('fleet.flow.start'))
      .toBeInstanceOf(FleetFlowStartCommand);
    expect(testingModule.get(FLEET_FLOW_REPOSITORY, { strict: false }))
      .toBe(testingModule.get(PrismaFleetFlowRepository, { strict: false }));
    // The create service is wired with the thread and repo services another module exports, not with
    // their repositories: a flows service that read either repository would break the layering.
    expect(testingModule.get(FleetFlowsService, { strict: false })).toBeInstanceOf(FleetFlowsService);
  });
});
