import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { createMockPrismaService, PrismaService } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from './approval-engine.module';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

@Global()
@Module({ providers: [
  { provide: PrismaService, useValue: createMockPrismaService({ fn: vi.fn }) },
  { provide: TRANSACTION_MANAGER, useValue: {
    run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false),
  } },
], exports: [PrismaService, TRANSACTION_MANAGER] })
class ExternalStubsModule {}

describe('ApprovalEngineModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });
  it('AC-14: aliases repository tokens to the concrete singleton providers', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ExternalStubsModule, ApprovalEngineModule] }).compile();
    expect(moduleRef.get(APPROVAL_POLICY_REPOSITORY)).toBe(moduleRef.get(PrismaApprovalPolicyRepository));
    expect(moduleRef.get(APPROVAL_REQUEST_REPOSITORY)).toBe(moduleRef.get(PrismaApprovalRequestRepository));
  });
});
