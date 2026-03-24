import { Module } from '@nestjs/common';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';

@Module({
  controllers: [CiWebhookController],
  providers: [CiWebhookService],
  exports: [CiWebhookService],
})
export class CiWebhookModule {}
