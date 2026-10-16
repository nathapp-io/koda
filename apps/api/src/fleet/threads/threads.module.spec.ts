import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ThreadsController } from './threads.controller';
import { ThreadEventsController, ThreadEventsGuard } from './thread-events.controller';
import { ThreadsService } from './threads.service';
import { CHAT_THREAD_REPOSITORY } from './domain/chat-thread.domain';
import { ProjectBriefService } from './project-brief.service';
import { ThreadsModule } from './threads.module';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { WorkspaceThreadsController } from './workspace-threads.controller';

/**
 * DI guard, as approval-store.module.spec.ts: a missing provider or an import cycle fails
 * `bun run test`. `moduleRef.get` is non-strict and resolves from the whole container, so this
 * catches an import cycle or a provider that is no longer declared at all, not one merely dropped
 * from `exports`. ThreadsModule imports ThreadStoreModule, which forwardRef-imports FleetJobsModule,
 * so the thread graph's cycle is resolved here too. US-002 adds ProjectBriefService, which reads the
 * repository context through GitBrokerModule's GitHubAppClient.
 */
describe('ThreadsModule', () => {
  it('compiles and resolves the controller, the service and the repository token', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ThreadsModule] }).compile();
    try {
      expect(moduleRef.get(WorkspaceThreadsService)).toBeDefined();
      expect(moduleRef.get(WorkspaceThreadsController)).toBeDefined();
      expect(moduleRef.get(ThreadsController)).toBeDefined();
      expect(moduleRef.get(ThreadEventsController)).toBeDefined();
      expect(moduleRef.get(ThreadEventsGuard)).toBeDefined();
      expect(moduleRef.get(ThreadsService)).toBeDefined();
      expect(moduleRef.get(CHAT_THREAD_REPOSITORY)).toBeDefined();
      expect(moduleRef.get(ProjectBriefService)).toBeInstanceOf(ProjectBriefService);
    } finally {
      await moduleRef.close();
    }
  });
});
