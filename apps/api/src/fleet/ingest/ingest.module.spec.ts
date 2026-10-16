import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeIndexQueue } from '../knowledge/knowledge-index.queue';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BundleIngestService } from './bundle-ingest.service';
import { BundleIngestSweeper } from './bundle-ingest.sweeper';
import { IngestModule } from './ingest.module';

/**
 * US-004/3c-2-D8: the ingest module imports `KnowledgeModule` for the outcome index queue. `BundleIngestService`
 * has ten constructor dependencies now, and a missing module import would only surface at boot otherwise.
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

  it('resolves BundleIngestService with the knowledge queue as its tenth dependency', () => {
    expect(module.get(BundleIngestService)).toBeInstanceOf(BundleIngestService);
    expect(module.get(KnowledgeIndexQueue)).toBeInstanceOf(KnowledgeIndexQueue);
    expect(module.get(BundleIngestSweeper)).toBeInstanceOf(BundleIngestSweeper);
  });

  it('imports KnowledgeModule instead of re-providing the queue', () => {
    const importsOf = Reflect.getMetadata('imports', IngestModule) as unknown[];

    expect(importsOf).toContain(KnowledgeModule);
    expect(Reflect.getMetadata('providers', IngestModule)).not.toContain(KnowledgeIndexQueue);
  });
});
