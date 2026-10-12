import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { BudgetsModule } from '../../budgets/budgets.module';
import { LiveModule } from '../../../live/live.module';
import { LogsModule } from '../../logs/logs.module';
import { LogAppendHooks } from '../../logs/log-append-hooks';
import { THREAD_STREAM } from '../../common/thread-jobs';
import { ThreadIngestor } from './thread-ingestor';
import { ThreadIngestBootstrap } from './thread-ingest.bootstrap';
import { THREAD_INGEST_REPOSITORY, THREAD_UNFOLDED_STREAM_SOURCE } from './domain/thread-ingest.domain';
import { PrismaThreadIngestRepository } from './prisma-thread-ingest.repository';

@Injectable()
class ThreadIngestHook implements OnModuleInit {
  constructor(private readonly hooks: LogAppendHooks, private readonly ingestor: ThreadIngestor) {}

  onModuleInit(): void {
    this.hooks.register(THREAD_STREAM, ({ jobId, leaseEpoch }) => this.ingestor.catchUp(jobId, leaseEpoch));
  }
}

@Module({
  imports: [LogsModule, BudgetsModule, LiveModule, PrismaModule],
  providers: [
    PrismaThreadIngestRepository,
    { provide: THREAD_INGEST_REPOSITORY, useExisting: PrismaThreadIngestRepository },
    { provide: THREAD_UNFOLDED_STREAM_SOURCE, useExisting: PrismaThreadIngestRepository },
    ThreadIngestor,
    ThreadIngestHook,
    ThreadIngestBootstrap,
  ],
  exports: [ThreadIngestor],
})
export class ThreadIngestModule {}
