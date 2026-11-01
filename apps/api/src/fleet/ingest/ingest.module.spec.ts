import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BundleIngestService } from './bundle-ingest.service';
import { BundleIngestSweeper } from './bundle-ingest.sweeper';
import { IngestModule } from './ingest.module';
import { FleetReviewsModule } from '../reviews/fleet-reviews.module';
import { FleetReviewEventsService } from '../reviews/fleet-review-events.service';
import { FLEET_REVIEW_EVENT_REPOSITORY } from '../reviews/domain/fleet-review-event.domain';

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

  it('imports the public review event service while keeping its repository private', () => {
    expect(Reflect.getMetadata('imports', IngestModule) as unknown[]).toContain(FleetReviewsModule);
    expect(module.get(FleetReviewEventsService)).toBeInstanceOf(FleetReviewEventsService);
    expect(Reflect.getMetadata('exports', FleetReviewsModule) as unknown[]).toContain(FleetReviewEventsService);
    expect(Reflect.getMetadata('exports', FleetReviewsModule) as unknown[]).not.toContain(FLEET_REVIEW_EVENT_REPOSITORY);
  });

  it('does not import KnowledgeModule', () => {
    expect(Reflect.getMetadata('imports', IngestModule) as unknown[]).not.toContain(KnowledgeModule);
  });
});
