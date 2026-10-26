import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { createMockPrismaService, PrismaService } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from './approval-engine.module';
import { ApprovalPolicyResolver } from './approval-policy.resolver';
import { PermissionService } from '../permissions/permission.service';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

@Global()
@Module({ providers: [
  { provide: PermissionService, useValue: { roleIdsAt: vi.fn().mockResolvedValue([]) } },
  { provide: PrismaService, useValue: createMockPrismaService({ fn: vi.fn }) },
  { provide: TRANSACTION_MANAGER, useValue: {
    run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false),
  } },
], exports: [PrismaService, TRANSACTION_MANAGER, PermissionService] })
class ExternalStubsModule {}

describe('ApprovalEngineModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });
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
});
