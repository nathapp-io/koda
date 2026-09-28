import { Injectable, Logger, Module, OnModuleInit, Optional } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { VectorStore } from './vector-store.service';
import { EmbeddingService } from './embedding.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { LanceTableManager } from './lance-table-manager';
import { EntityStore } from './entity-store';
import { GraphStoreService } from './graph-store.service';
import { IncrementalGraphDiffService } from './incremental-graph-diff.service';
import { PrismaRagRepository } from './prisma-rag.repository';
import { KbTicketLifecycleSubscriber } from './kb-ticket-lifecycle.subscriber';
import { RAG_REPOSITORY } from './domain/rag.domain';
import { FTS_OPTIMIZE_STRATEGY, FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './strategies/manual-optimize.strategy';
import { OutboxModule } from '../outbox/outbox.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { ProjectAccessModule } from '../projects/project-access.module';

@Injectable()
class EntityStoreWarmup implements OnModuleInit {
  private readonly logger = new Logger(EntityStoreWarmup.name);

  constructor(
    private readonly entityStore: EntityStore,
    private readonly outboxFanOutRegistry: FanOutPublisher,
    @Optional() private readonly ragRepository?: PrismaRagRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    this.outboxFanOutRegistry.register('graphify_import', async (payload: unknown) => {
      await this.entityStore.handleOutboxEvent({
        eventType: 'graphify_import',
        payload,
      });
      this.logger.debug('EntityStore index updated from graphify_import event');
    });

    this.outboxFanOutRegistry.register('ticket_event', async (payload: unknown) => {
      await this.entityStore.handleOutboxEvent({
        eventType: 'ticket_event',
        payload,
      });
      this.logger.debug('EntityStore index updated from ticket_event event');
    });

    this.logger.debug('EntityStore outbox handlers registered');

    if (this.ragRepository) {
      try {
        const projects = await this.ragRepository.findAllActiveProjectIds();
        const projectIds = projects.map(p => p.id);
        if (projectIds.length > 0) {
          for (const projectId of projectIds) {
            await this.entityStore.indexGraphifyEntitiesForProject(projectId);
          }
          this.logger.log(`EntityStore warmup completed for ${projectIds.length} projects`);
        }
      } catch (err) {
        this.logger.warn(`EntityStore warmup skipped: ${(err as Error).message}`);
      }
    }
  }
}

@Module({
  imports: [ScheduleModule.forRoot(), OutboxModule, PrismaModule, ProjectAccessModule],
  controllers: [RagController],
  providers: [
    PrismaRagRepository,
    { provide: RAG_REPOSITORY, useExisting: PrismaRagRepository },
    // ONE shared LanceTableManager for both VectorStore and HybridRetrieverService:
    // single lancedb.connect per db path, one per-table write mutex across both
    // services, so KB documents are never double-indexed and deletes are visible
    // to both stores (H7 residual).
    {
      provide: LanceTableManager,
      useFactory: (ragConfig: IRagConfig, embeddingService: EmbeddingService): LanceTableManager =>
        new LanceTableManager(ragConfig, embeddingService),
      inject: [RAG_CFG, EmbeddingService],
    },
    RagService,
    VectorStore,
    EmbeddingService,
    HybridRetrieverService,
    EntityStore,
    EntityStoreWarmup,
    KbTicketLifecycleSubscriber,
    GraphStoreService,
    IncrementalGraphDiffService,
    {
      provide: FTS_OPTIMIZE_STRATEGY,
      useFactory: (ragConfig: IRagConfig, schedulerRegistry: SchedulerRegistry): FtsOptimizeStrategy => {
        const strategy = ragConfig.ftsOptimizeStrategy;

        switch (strategy) {
          case 'cron':
            return new CronOptimizeStrategy(ragConfig, schedulerRegistry);
          case 'manual':
            return new ManualOptimizeStrategy();
          case 'counter':
          default:
            return new CounterOptimizeStrategy(ragConfig);
        }
      },
      inject: [RAG_CFG, SchedulerRegistry],
    },
  ],
  exports: [RagService, HybridRetrieverService, LanceTableManager, EntityStore, GraphStoreService, FTS_OPTIMIZE_STRATEGY, IncrementalGraphDiffService, PrismaRagRepository],
})
export class RagModule {}
