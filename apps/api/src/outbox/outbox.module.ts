import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { AdminController } from './admin.controller';
import { PrismaModule } from '@nathapp/nestjs-prisma';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
