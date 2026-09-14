import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookReplayGuard } from './webhook-replay.guard';

@Module({
  imports: [PrismaModule],
  providers: [WebhookReplayGuard],
  exports: [WebhookReplayGuard],
})
export class WebhookSecurityModule {}