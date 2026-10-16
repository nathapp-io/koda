import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ArtifactStoreModule } from '../artifacts/artifact-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { FleetTicketsModule } from '../tickets/fleet-tickets.module';
import { BundleIngestService } from './bundle-ingest.service';
import { BundleIngestSweeper } from './bundle-ingest.sweeper';
import { BUNDLE_INGEST_REPOSITORY } from './domain/bundle-ingest.domain';
import { FleetIngestController } from './fleet-ingest.controller';
import { PrismaBundleIngestRepository } from './prisma-bundle-ingest.repository';

/**
 * Fleet S2b (d) (spec docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md).
 *
 * `KnowledgeModule` is imported for the outcome index queue `BundleIngestService` triggers after an ingest
 * commit (S5b 3c-2-D8). No cycle: the knowledge module imports no fleet module.
 */
@Module({
  imports: [PrismaModule, ArtifactStoreModule, FleetJobsModule, FleetActivityModule, BudgetsModule, FleetTicketsModule, KnowledgeModule],
  controllers: [FleetIngestController],
  providers: [
    PrismaBundleIngestRepository, { provide: BUNDLE_INGEST_REPOSITORY, useExisting: PrismaBundleIngestRepository },
    BundleIngestService, BundleIngestSweeper,
  ],
  exports: [BUNDLE_INGEST_REPOSITORY, BundleIngestService],
})
export class IngestModule {}
