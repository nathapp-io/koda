import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { ApprovalStoreModule } from './approval-store.module';

/**
 * DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`.
 * Task 4 (budgets) and Task 6 (ApprovalsModule) are the first consumers of these exports, so a dropped
 * export must surface here rather than as an opaque DI failure in a DB-mode run.
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
