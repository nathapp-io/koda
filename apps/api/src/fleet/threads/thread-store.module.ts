import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { CHAT_THREAD_REPOSITORY } from './domain/chat-thread.domain';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';

/** Plan D160-style store module: thread storage importable by ThreadsModule, SyncModule and,
 *  through ThreadsModule, FleetJobsModule's siblings — without a cycle. */
@Module({
  imports: [PrismaModule, FleetJobsModule, FleetActivityModule, BudgetStoreModule],
  providers: [PrismaChatThreadRepository, { provide: CHAT_THREAD_REPOSITORY, useExisting: PrismaChatThreadRepository }],
  exports: [CHAT_THREAD_REPOSITORY, FleetJobsModule],
})
export class ThreadStoreModule {}
