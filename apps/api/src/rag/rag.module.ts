import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { EmbeddingService } from './embedding.service';
import { FTS_OPTIMIZE_STRATEGY, FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './strategies/manual-optimize.strategy';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [RagController],
  providers: [
    RagService,
    EmbeddingService,
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
  exports: [RagService, FTS_OPTIMIZE_STRATEGY],
})
export class RagModule {}
