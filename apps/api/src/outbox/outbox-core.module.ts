import { Module } from '@nestjs/common';
import { FanOutPublisher } from './fan-out-publisher';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { PrismaOutboxStore } from './prisma-outbox.store';

/**
 * The outbox adapters koda supplies to @nathapp/nestjs-outbox. A separate
 * module so NathappOutboxModule.registerAsync can inject them from `imports`.
 * PrismaService and TRANSACTION_MANAGER come from the global PrismaModule.forRoot.
 */
@Module({
  providers: [PrismaOutboxRepository, PrismaOutboxStore, FanOutPublisher],
  exports: [PrismaOutboxRepository, PrismaOutboxStore, FanOutPublisher],
})
export class OutboxCoreModule {}
