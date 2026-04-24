import { Injectable, Logger, Module, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { EmbeddingService } from './embedding.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { LexicalIndex } from './lexical-index';
import { EntityStore } from './entity-store';
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
    private readonly outboxFanOutRegistry: OutboxFanOutRegistry,
    @Optional() private readonly prisma?: PrismaService<PrismaClient>,
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

    if (this.prisma?.client) {
      try {
        const projects = await this.prisma.client.project.findMany({
          where: { deletedAt: null },
          select: { id: true },
        });
        const projectIds = projects.map(p => p.id);
        if (projectIds.length > 0) {
          await this.lexicalIndex.warmup(projectIds);
          this.logger.log(`LexicalIndex warmup completed for ${projectIds.length} projects`);
        }
      } catch (err) {
        this.logger.warn(`LexicalIndex warmup skipped: ${(err as Error).message}`);
      }
    }
  }
}

@Injectable()
class EntityStoreWarmup implements OnModuleInit {
  private readonly logger = new Logger(EntityStoreWarmup.name);

  constructor(
    private readonly entityStore: EntityStore,
    private readonly outboxFanOutRegistry: OutboxFanOutRegistry,
    @Optional() private readonly prisma?: PrismaService<PrismaClient>,
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

    if (this.prisma?.client) {
      try {
        const projects = await this.prisma.client.project.findMany({
          where: { deletedAt: null },
          select: { id: true },
        });
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
    RagService,
    EmbeddingService,
    HybridRetrieverService,
    LexicalIndex,
    LexicalIndexWarmup,
    EntityStore,
    EntityStoreWarmup,
    {
      provide: FTS_OPTIMIZE_STRATEGY,
      useFactory: (configService: ConfigService, schedulerRegistry: SchedulerRegistry): FtsOptimizeStrategy => {
        const strategy = configService.get<string>('rag.ftsOptimizeStrategy') ?? 'counter';

        switch (strategy) {
          case 'cron':
            return new CronOptimizeStrategy(configService, schedulerRegistry);
          case 'manual':
            return new ManualOptimizeStrategy();
          case 'counter':
          default:
            return new CounterOptimizeStrategy(configService);
        }
      },
      inject: [ConfigService, SchedulerRegistry],
    },
  ],
  exports: [RagService, HybridRetrieverService, LexicalIndex, EntityStore, FTS_OPTIMIZE_STRATEGY],
})
export class RagModule {}
