import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { OutboxProcessor } from './outbox-processor';
import { AdminController } from './admin.controller';
import { PrismaModule } from '@nathapp/nestjs-prisma';

@Module({
  imports: [PrismaModule, ScheduleModule],
  controllers: [AdminController],
  providers: [OutboxService, OutboxFanOutRegistry, OutboxProcessor],
  exports: [OutboxService, OutboxFanOutRegistry],
})
export class OutboxModule {}