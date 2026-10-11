import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';
import { CHAT_THREAD_REPOSITORY } from './domain/chat-thread.domain';
import { ThreadsModule } from './threads.module';

/**
 * DI guard, as approval-store.module.spec.ts: a missing provider or an import cycle fails
 * `bun run test`. `moduleRef.get` is non-strict and resolves from the whole container, so this
 * catches an import cycle or a provider that is no longer declared at all, not one merely dropped
 * from `exports`. ThreadsModule imports ThreadStoreModule, which forwardRef-imports FleetJobsModule,
 * so the thread graph's cycle is resolved here too.
 */
describe('ThreadsModule', () => {
  it('compiles and resolves the controller, the service and the repository token', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ThreadsModule] }).compile();
    try {
      expect(moduleRef.get(ThreadsController)).toBeDefined();
      expect(moduleRef.get(ThreadsService)).toBeDefined();
      expect(moduleRef.get(CHAT_THREAD_REPOSITORY)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
