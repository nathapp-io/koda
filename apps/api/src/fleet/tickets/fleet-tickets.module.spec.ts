import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { FleetPrStateRefresher } from './fleet-pr-state.refresher';
import { FleetTicketsModule } from './fleet-tickets.module';

/**
 * The PR-state refresher's merge hook emits `KNOWLEDGE_REPO_MERGED` on the global `EventEmitter2` instead of
 * calling the knowledge queue, so `FleetTicketsModule` must not import `KnowledgeModule` (that import made
 * FleetJobs -> FleetTickets -> Knowledge a chain the knowledge module could never depend back on). A missing
 * provider is a boot-time DI failure, so it is pinned here (database-free module compilation).
 */
describe('FleetTicketsModule (merge hook wiring)', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetTicketsModule] }).compile();
  });

  afterAll(async () => {
    if (module) await module.close();
  });

  it('resolves the refresher against the global event emitter', () => {
    expect(module.get(FleetPrStateRefresher)).toBeInstanceOf(FleetPrStateRefresher);
  });

  it('does not import KnowledgeModule', () => {
    expect(Reflect.getMetadata('imports', FleetTicketsModule) as unknown[]).not.toContain(KnowledgeModule);
  });
});
