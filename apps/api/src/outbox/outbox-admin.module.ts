import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { OutboxModule } from './outbox.module';

/** Admin HTTP surface for the outbox, kept out of the domain module so OutboxModule compiles without auth wiring. */
@Module({
  imports: [OutboxModule],
  controllers: [AdminController],
})
export class OutboxAdminModule {}
