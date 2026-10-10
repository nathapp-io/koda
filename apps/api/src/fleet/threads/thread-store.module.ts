import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { CHAT_THREAD_REPOSITORY } from './domain/chat-thread.domain';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';

@Module({
  imports: [PrismaModule],
  providers: [PrismaChatThreadRepository, { provide: CHAT_THREAD_REPOSITORY, useExisting: PrismaChatThreadRepository }],
  exports: [CHAT_THREAD_REPOSITORY],
})
export class ThreadStoreModule {}
