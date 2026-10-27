import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { ApprovalStoreModule } from './approval-store.module';

/**
 * DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`.
 * `moduleRef.get` is non-strict and resolves from the whole container, so this catches an import cycle
 * or a provider that is no longer declared at all, not one merely dropped from `exports`.
 */
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
});
