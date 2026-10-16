import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KNOWLEDGE_REPO_MERGED, KNOWLEDGE_RUN_INGESTED } from '../common/knowledge-events';
import { KnowledgeIndexQueue } from './knowledge-index.queue';
import { KnowledgeModule } from './knowledge.module';
import { VcsPollingService } from '../../vcs/vcs-polling.service';

/**
 * The trigger events reach the queue through Nest's `@OnEvent` subscription, which is registered at
 * application bootstrap. Unit-level (api-testing rule): the real module compiles against the global stubs,
 * which carry `EventEmitterModule`, and no database is involved. `init()` runs every lifecycle hook, so the VCS
 * poller (reached through GitBrokerModule) is stubbed: it would query the stub Prisma client at startup.
 */
describe('KnowledgeModule trigger event wiring', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, KnowledgeModule] })
      .overrideProvider(VcsPollingService)
      .useValue({})
      .compile();
    await module.init();
  });

  afterAll(async () => {
    await module.close();
  });

  it('a repo-merged event reaches the queue as a merge pass', () => {
    const queue = module.get(KnowledgeIndexQueue);
    const enqueue = vi.spyOn(queue, 'enqueue').mockImplementation(() => undefined);

    module.get(EventEmitter2).emit(KNOWLEDGE_REPO_MERGED, { repoId: 'r9' });

    expect(enqueue).toHaveBeenCalledExactlyOnceWith('r9', 'merge');
  });

  it('a run-ingested event reaches the queue as an outcome pass', () => {
    const queue = module.get(KnowledgeIndexQueue);
    const enqueueOutcomes = vi.spyOn(queue, 'enqueueOutcomes').mockImplementation(() => undefined);

    module.get(EventEmitter2).emit(KNOWLEDGE_RUN_INGESTED, { jobId: 'j1' });

    expect(enqueueOutcomes).toHaveBeenCalledExactlyOnceWith('j1');
  });
});
