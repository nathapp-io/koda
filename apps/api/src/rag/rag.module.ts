import { Injectable, Logger, Module, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { EmbeddingService } from './embedding.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { LexicalIndex } from './lexical-index';
import { EntityStore } from './entity-store';
import { GraphStoreService } from './graph-store.service';
import { IncrementalGraphDiffService } from './incremental-graph-diff.service';
import { PrismaRagRepository } from './prisma-rag.repository';
import { RAG_REPOSITORY } from './domain/rag.domain';
import { FTS_OPTIMIZE_STRATEGY, FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './strategies/manual-optimize.strategy';
import { OutboxModule } from '../outbox/outbox.module';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';
import { RetrievalModule } from '../retrieval/retrieval.module';

@Injectable()
class LexicalIndexWarmup implements OnModuleInit {
  private readonly logger = new Logger(LexicalIndexWarmup.name);

  constructor(
    private readonly lexicalIndex: LexicalIndex,
    private readonly ragService: RagService,
    private readonly outboxFanOutRegistry: OutboxFanOutRegistry,
    @Optional() private readonly ragRepository?: PrismaRagRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    this.outboxFanOutRegistry.register('document_indexed', async (payload: unknown) => {
      const p = payload as { projectId?: string; sourceId?: string; content?: string; metadata?: Record<string, unknown> };
      if (p.projectId && p.sourceId && p.content !== undefined) {
        const event = {
          eventType: 'document_indexed',
          payload: { projectId: p.projectId, sourceId: p.sourceId, content: p.content, metadata: p.metadata ?? {} },
        };
        await this.lexicalIndex.handleOutboxEvent(event);
        this.logger.debug(`LexicalIndex rebuild triggered for project ${p.projectId}`);
      }
    });
    this.logger.debug('LexicalIndex outbox handler registered');

    if (this.ragRepository) {
      const ragRepository = this.ragRepository;
      // Begin warmup in background — does not block API startup
      Promise.resolve().then(async () => {
        try {
          const projects = await ragRepository.findAllActiveProjectIds();
          let warmedUp = 0;
          for (const { id: projectId } of projects) {
            try {
              const docs = await this.ragService.listDocuments(projectId, 50_000);
              if (docs.length > 0) {
                this.lexicalIndex.buildIndex(projectId, docs.map(d => ({ id: d.sourceId, content: d.content })));
                this.lexicalIndex.setWarmupCompleted(projectId, true);
                warmedUp++;
              }
            } catch {
              // non-fatal: lazy build will handle this project on first search
            }
          }
          this.logger.log(`LexicalIndex warmup completed for ${warmedUp}/${projects.length} projects`);
        } catch (err) {
          this.logger.warn(`LexicalIndex warmup skipped: ${(err as Error).message}`);
        }
      }).catch(() => {});
    }
  }
}

@Injectable()
class EntityStoreWarmup implements OnModuleInit {
  private readonly logger = new Logger(EntityStoreWarmup.name);

  constructor(
    private readonly entityStore: EntityStore,
    private readonly outboxFanOutRegistry: OutboxFanOutRegistry,
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
  imports: [ScheduleModule.forRoot(), OutboxModule, PrismaModule, forwardRef(() => RetrievalModule)],
  controllers: [RagController],
  providers: [
    PrismaRagRepository,
    { provide: RAG_REPOSITORY, useExisting: PrismaRagRepository },
    RagService,
    EmbeddingService,
    HybridRetrieverService,
    LexicalIndex,
    LexicalIndexWarmup,
    EntityStore,
    EntityStoreWarmup,
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
  exports: [RagService, HybridRetrieverService, LexicalIndex, EntityStore, GraphStoreService, FTS_OPTIMIZE_STRATEGY, IncrementalGraphDiffService],
})
export class RagModule {}
