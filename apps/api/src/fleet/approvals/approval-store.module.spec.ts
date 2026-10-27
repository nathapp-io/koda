import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { FLEET_APPROVAL_ASK_REPOSITORY } from './domain/fleet-approval-ask.domain';
import { ApprovalStoreModule } from './approval-store.module';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';
import { PrismaApprovalRepository } from './prisma-approval.repository';

/**
 * DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`.
 * `moduleRef.get` is non-strict and resolves from the whole container, so this catches an import cycle
 * or a provider that is no longer declared at all, not one merely dropped from `exports`.
 */

/** US-009 AC-11: a consumer that only sees what ApprovalStoreModule exports. */
@Injectable()
class AskStoreConsumer {
  constructor(readonly store: FleetApprovalAskStore) {}
}

@Module({ imports: [GlobalStubsModule, ApprovalStoreModule], providers: [AskStoreConsumer] })
class AskStoreConsumerModule {}

/** US-009 AC-12: the legacy exports a consumer injected before the ask store existed. */
@Injectable()
class LegacyApprovalConsumer {
  constructor(
    readonly closer: ApprovalCloser,
    readonly livePublisher: ApprovalLivePublisher,
    readonly approvals: PrismaApprovalRepository,
    @Inject(APPROVAL_REPOSITORY) readonly token: unknown,
  ) {}
}

@Module({ imports: [GlobalStubsModule, ApprovalStoreModule], providers: [LegacyApprovalConsumer] })
class LegacyApprovalConsumerModule {}

describe('ApprovalStoreModule', () => {
  it('compiles and resolves the closer, the live publisher and the repository token', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalStoreModule] }).compile();
    try {
      expect(moduleRef.get(ApprovalCloser)).toBeDefined();
      expect(moduleRef.get(ApprovalLivePublisher)).toBeDefined();
      expect(moduleRef.get(APPROVAL_REPOSITORY)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });

  it('AC-11: a consumer importing the module injects FleetApprovalAskStore, which stays its only public face', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AskStoreConsumerModule] }).compile();
    try {
      const consumer = moduleRef.get(AskStoreConsumer);
      expect(consumer.store).toBeInstanceOf(FleetApprovalAskStore);
      const exported = (Reflect.getMetadata('exports', ApprovalStoreModule) ?? []) as unknown[];
      // The store is the public face; the token it injects stays inside the module.
      expect(exported).toContain(FleetApprovalAskStore);
      expect(exported).not.toContain(FLEET_APPROVAL_ASK_REPOSITORY);
    } finally {
      await moduleRef.close();
    }
  });

  it('AC-12: a consumer still injects the closer, live publisher and the legacy approval repository', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [LegacyApprovalConsumerModule] }).compile();
    try {
      const consumer = moduleRef.get(LegacyApprovalConsumer);
      expect(consumer.closer).toBeInstanceOf(ApprovalCloser);
      expect(consumer.livePublisher).toBeInstanceOf(ApprovalLivePublisher);
      expect(consumer.approvals).toBeInstanceOf(PrismaApprovalRepository);
      expect(consumer.token).toBe(consumer.approvals);
    } finally {
      await moduleRef.close();
    }
  });
});
