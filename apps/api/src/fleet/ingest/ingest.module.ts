import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { IngestRequeueService } from './ingest-requeue.service';
import { IngestRouteCommands } from './ingest-route.commands';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ArtifactStoreModule } from '../artifacts/artifact-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { FleetTicketsModule } from '../tickets/fleet-tickets.module';
import { BundleIngestService } from './bundle-ingest.service';
import { BundleIngestSweeper } from './bundle-ingest.sweeper';
import { BUNDLE_INGEST_REPOSITORY } from './domain/bundle-ingest.domain';
import { FleetIngestController } from './fleet-ingest.controller';
import { PrismaBundleIngestRepository } from './prisma-bundle-ingest.repository';

/**
 * Fleet S2b (d) (spec docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md).
 *
 * `BundleIngestService` emits `KNOWLEDGE_RUN_INGESTED` on the global `EventEmitter2` after a RUN ingest commits
 * (S5b 3c-2-D8); this module never imports `KnowledgeModule`.
 */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, ArtifactStoreModule, FleetJobsModule, FleetActivityModule, BudgetsModule, FleetTicketsModule],
  controllers: [FleetIngestController],
  providers: [
    PrismaBundleIngestRepository, { provide: BUNDLE_INGEST_REPOSITORY, useExisting: PrismaBundleIngestRepository },
    BundleIngestService, BundleIngestSweeper, IngestRequeueService, IngestRouteCommands,
  ],
  exports: [BUNDLE_INGEST_REPOSITORY, BundleIngestService],
})
export class IngestModule {}
