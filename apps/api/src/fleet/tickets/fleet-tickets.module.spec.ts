import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeIndexQueue } from '../knowledge/knowledge-index.queue';
import { FleetPrStateRefresher } from './fleet-pr-state.refresher';
import { FleetTicketsModule } from './fleet-tickets.module';

/**
 * US-005 wiring: the PR-state refresher's merge hook needs `KnowledgeIndexQueue`, which `KnowledgeModule`
 * exports — so `FleetTicketsModule` must import that module. A missing import is a boot-time DI failure the
 * endpoint e2e suite would only report indirectly, so it is pinned here (database-free module compilation).
 */
describe('FleetTicketsModule (US-005 merge hook wiring)', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetTicketsModule] }).compile();
  });

  afterAll(async () => {
    if (module) await module.close();
  });

  it('resolves the refresher with the exported knowledge queue', () => {
    expect(module.get(KnowledgeIndexQueue)).toBeInstanceOf(KnowledgeIndexQueue);
    expect(module.get(FleetPrStateRefresher)).toBeInstanceOf(FleetPrStateRefresher);
  });
});
