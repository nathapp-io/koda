import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ThreadJobEffects } from './thread-job-effects';
import { CHAT_THREAD_REPOSITORY } from './domain/chat-thread.domain';
import { ThreadStoreModule } from './thread-store.module';

/**
 * DI guard, as approval-store.module.spec.ts: a missing provider or an import cycle fails
 * `bun run test`. `moduleRef.get` is non-strict and resolves from the whole container, so this
 * catches an import cycle or a provider that is no longer declared at all, not one merely dropped
 * from `exports`. ThreadStoreModule forwardRef-imports FleetJobsModule, so the cycle it breaks is
 * resolved here too.
 */
describe('ThreadStoreModule', () => {
  it('compiles and resolves the repository token and the thread effects port', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ThreadStoreModule] }).compile();
    try {
      expect(moduleRef.get(CHAT_THREAD_REPOSITORY)).toBeDefined();
      expect(moduleRef.get(ThreadJobEffects)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
