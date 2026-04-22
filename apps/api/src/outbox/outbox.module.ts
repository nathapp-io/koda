import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { PrismaModule } from '@nathapp/nestjs-prisma';

@Module({
  imports: [PrismaModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
