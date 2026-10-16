import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BundleIngestService } from './bundle-ingest.service';
import { BundleIngestSweeper } from './bundle-ingest.sweeper';
import { IngestModule } from './ingest.module';

/**
 * `BundleIngestService` emits `KNOWLEDGE_RUN_INGESTED` on the global `EventEmitter2` after a RUN ingest commits
 * (3c-2-D8) instead of calling the knowledge queue, so the ingest module no longer imports `KnowledgeModule`.
 * Unit-level: the real modules compile against the global stub providers, so no database is involved
 * (api-testing rule).
 */
describe('IngestModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, IngestModule] }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('resolves BundleIngestService against the global event emitter', () => {
    expect(module.get(BundleIngestService)).toBeInstanceOf(BundleIngestService);
    expect(module.get(BundleIngestSweeper)).toBeInstanceOf(BundleIngestSweeper);
  });

  it('does not import KnowledgeModule', () => {
    expect(Reflect.getMetadata('imports', IngestModule) as unknown[]).not.toContain(KnowledgeModule);
  });
});
