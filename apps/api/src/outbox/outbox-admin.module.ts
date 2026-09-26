import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { OutboxAdminService } from './outbox-admin.service';
import { OutboxModule } from './outbox.module';

/** Admin HTTP surface for the outbox, kept out of the domain module so OutboxModule compiles without auth wiring. */
@Module({
  imports: [OutboxModule],
  controllers: [AdminController],
  providers: [OutboxAdminService],
})
export class OutboxAdminModule {}
