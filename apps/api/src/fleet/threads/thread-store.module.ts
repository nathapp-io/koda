import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { CHAT_THREAD_REPOSITORY } from './domain/chat-thread.domain';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';
import { ThreadJobEffects } from './thread-job-effects';

@Module({
  imports: [PrismaModule, forwardRef(() => FleetJobsModule), FleetActivityModule, BudgetStoreModule],
  providers: [PrismaChatThreadRepository, { provide: CHAT_THREAD_REPOSITORY, useExisting: PrismaChatThreadRepository }, ThreadJobEffects],
  exports: [CHAT_THREAD_REPOSITORY, ThreadJobEffects],
})
export class ThreadStoreModule {}
