import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { PrismaCiWebhookRepository } from './prisma-ci-webhook.repository';
import { CI_WEBHOOK_REPOSITORY } from './domain/ci-webhook.domain';

@Module({
  imports: [PrismaModule],
  controllers: [CiWebhookController],
  providers: [
    PrismaCiWebhookRepository,
    { provide: CI_WEBHOOK_REPOSITORY, useExisting: PrismaCiWebhookRepository },
    CiWebhookService,
  ],
  exports: [CiWebhookService],
})
export class CiWebhookModule {}
