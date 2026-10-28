import { AuditRecorder } from '../audit/audit-recorder.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { createMockPrismaService, PrismaService } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from './approval-engine.module';
import { ApprovalAskService } from './approval-ask.service';
import { ApprovalGate } from './approval-gate.service';
import { ApprovalDecisionService } from './approval-decision.service';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalPolicyResolver } from './approval-policy.resolver';
import { ApprovalRequestExpirySweeper } from './approval-request-expiry.sweeper';
import { FLEET_CFG } from '../config/fleet.config';
import { PermissionService } from '../permissions/permission.service';
import { SYSTEM_WRITER_METADATA } from '../permissions/system-writer.decorator';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { ApprovalRequestEvents } from './approval-request-events';
import { ApprovalRequestQueries } from './approval-request.queries';
import { ApprovalRouteGate } from './route/approval-route-gate';

@Global()
@Module({ providers: [
  { provide: AuditRecorder, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
  { provide: OutboxService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
  { provide: PermissionService, useValue: { roleIdsAt: vi.fn().mockResolvedValue([]), roleIdsAnywhere: vi.fn().mockResolvedValue([]) } },
  { provide: PrismaService, useValue: createMockPrismaService({ fn: vi.fn }) },
  { provide: TRANSACTION_MANAGER, useValue: {
    run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false),
  } },
  // The sweeper reads the fleet sweep window; a stub keeps the module DB-free and starts no timer.
  { provide: FLEET_CFG, useValue: { sweepEnabled: false, approvalSweepMs: 15_000 } },
], exports: [PrismaService, TRANSACTION_MANAGER, PermissionService, AuditRecorder, OutboxService, FLEET_CFG] })
class ExternalStubsModule {}

@Injectable()
class PolicyConsumer {
  constructor(readonly policies: ApprovalPolicyService, readonly decisions: ApprovalDecisionService, readonly executions: ApprovalExecutionService) {}
}
@Injectable()
class RegistryConsumer {
  constructor(readonly commands: ApprovalCommandRegistry, readonly gate: ApprovalGate) {}
}
/** Public engine services must be injectable by an importing module. */
@Injectable()
class EngineConsumer {
  constructor(
    readonly gate: ApprovalGate,
    readonly decisions: ApprovalDecisionService,
    readonly executions: ApprovalExecutionService,
    readonly policies: ApprovalPolicyService,
    readonly commands: ApprovalCommandRegistry,
    readonly queries: ApprovalRequestQueries,
    readonly asks: ApprovalAskService,
    readonly routeGate: ApprovalRouteGate,
  ) {}
}
@Module({ imports: [ApprovalEngineModule], providers: [PolicyConsumer, RegistryConsumer, EngineConsumer] })
class ConsumerModule {}

describe('ApprovalEngineModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });
  it('exports the policy service to consuming modules without a database', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ConsumerModule] }).compile();
    expect(moduleRef.get(PolicyConsumer).policies).toBeInstanceOf(ApprovalPolicyService);
    expect(moduleRef.get(PolicyConsumer).decisions).toBeInstanceOf(ApprovalDecisionService);
    expect(moduleRef.get(PolicyConsumer).executions).toBeInstanceOf(ApprovalExecutionService);
  });
  it('AC-13: provides ApprovalRequestEvents with the outbox stub', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ApprovalEngineModule] }).compile();
    expect(moduleRef.get(ApprovalRequestEvents)).toBeInstanceOf(ApprovalRequestEvents);
  });
  it('provides a resolver wired to policy and permission providers', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ApprovalEngineModule] }).compile();
    const repository = moduleRef.get<PrismaApprovalPolicyRepository>(APPROVAL_POLICY_REPOSITORY);
    vi.spyOn(repository, 'findCandidates').mockResolvedValue([]);
    expect(await moduleRef.get(ApprovalPolicyResolver).resolve({
      key: 'ticket.delete', projectId: null, subject: { type: 'AGENT', id: 'a1' },
    })).toEqual({ mode: 'agent', floor: 'none', policy: null, source: 'default' });
  });
  it('AC-14: aliases repository tokens to the concrete singleton providers', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ApprovalEngineModule] }).compile();
    expect(moduleRef.get(APPROVAL_POLICY_REPOSITORY)).toBe(moduleRef.get(PrismaApprovalPolicyRepository));
    expect(moduleRef.get(APPROVAL_REQUEST_REPOSITORY)).toBe(moduleRef.get(PrismaApprovalRequestRepository));
  });
  it('US-007 AC-8: exports one ApprovalCommandRegistry instance on every get', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ConsumerModule] }).compile();

    const commands = moduleRef.get(ApprovalCommandRegistry);
    expect(commands).toBeInstanceOf(ApprovalCommandRegistry);
    expect(moduleRef.get(ApprovalCommandRegistry)).toBe(commands);
    expect(moduleRef.get(RegistryConsumer).commands).toBe(commands);
    expect(moduleRef.get(RegistryConsumer).gate).toBeInstanceOf(ApprovalGate);
    expect(moduleRef.get(RegistryConsumer).gate).toBe(moduleRef.get(ApprovalGate));
  });
  it('US-012 AC-10: registers the expiry sweeper with its system writer key', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ApprovalEngineModule] }).compile();

    const sweeper = moduleRef.get(ApprovalRequestExpirySweeper);
    expect(sweeper).toBeInstanceOf(ApprovalRequestExpirySweeper);
    expect(Reflect.getMetadata(SYSTEM_WRITER_METADATA, ApprovalRequestExpirySweeper)).toBe('system.approval.expire');
    // The instance's constructor is what `runAsSystemWriter` reads the key from.
    expect(Reflect.getMetadata(SYSTEM_WRITER_METADATA, sweeper.constructor)).toBe('system.approval.expire');
  });
  it('US-012 AC-11 and visibility: an importing module injects all exported services', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ConsumerModule] }).compile();

    const consumer = moduleRef.get(EngineConsumer);
    expect(consumer.gate).toBeInstanceOf(ApprovalGate);
    expect(consumer.decisions).toBeInstanceOf(ApprovalDecisionService);
    expect(consumer.executions).toBeInstanceOf(ApprovalExecutionService);
    expect(consumer.policies).toBeInstanceOf(ApprovalPolicyService);
    expect(consumer.commands).toBeInstanceOf(ApprovalCommandRegistry);
    expect(consumer.queries).toBeInstanceOf(ApprovalRequestQueries);
  });
  it('US-006: an importing module injects ApprovalAskService from the engine', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ConsumerModule] }).compile();

    const consumer = moduleRef.get(EngineConsumer);
    expect(consumer.asks).toBeInstanceOf(ApprovalAskService);
    expect(consumer.asks).toBe(moduleRef.get(ApprovalAskService));
  });
  it('US-003: provides and exports one ApprovalRouteGate wired to the gate and the permission service', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ConsumerModule] }).compile();

    const routeGate = moduleRef.get(ApprovalRouteGate);
    expect(routeGate).toBeInstanceOf(ApprovalRouteGate);
    // The consumer proves the export: a route module imports the engine and resolves this.
    expect(moduleRef.get(EngineConsumer).routeGate).toBe(routeGate);
    // Constructed, not merely registered: a missing ApprovalGate or PermissionService would throw here.
    expect(routeGate).toHaveProperty('run');
  });
});
