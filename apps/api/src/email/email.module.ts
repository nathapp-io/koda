import { Global, Module } from '@nestjs/common';
import { NotificationChannel, NotifyModule } from '@nathapp/nestjs-notify';
import { NotifyPrismaModule } from '@nathapp/nestjs-notify-prisma';
import { EmailAvailability } from './email-availability';
import { EmailPlatformModule } from './email-platform.module';
import { EmailTemplateSeeder } from './email-template.seeder';
import { EmailScheduleRepository } from './schedule/email-schedule.repository';
import { EmailScheduleService } from './schedule/email-schedule.service';
import { SMTP_EMAIL_PROVIDER, SmtpDeliveryChannel, smtpEmailProviderFactory } from './smtp-delivery.channel';

/**
 * SmtpDeliveryChannel is instantiated inside NotifyModule, so its provider token must be globally visible.
 * Global so every module can inject EmailAvailability without importing EmailModule.
 * S4b B1: the EmailSchedule repository stays private; only the service is exported (global).
 */
@Global()
@Module({
  providers: [
    EmailAvailability,
    EmailScheduleRepository,
    EmailScheduleService,
    { provide: SMTP_EMAIL_PROVIDER, useFactory: smtpEmailProviderFactory, inject: [EmailAvailability] },
  ],
  exports: [EmailAvailability, EmailScheduleService, SMTP_EMAIL_PROVIDER],
})
export class EmailCoreModule {}

/**
 * Fleet S4b §1: nestjs-notify (global) + Prisma repositories + koda's SMTP channel. The channel is always
 * registered (R2); callers gate on EmailAvailability.configured.
 */
@Module({
  imports: [
    EmailPlatformModule,
    EmailCoreModule,
    NotifyPrismaModule.register(),
    NotifyModule.register({ deliveryChannels: [{ channel: NotificationChannel.EMAIL, provider: SmtpDeliveryChannel }] }),
  ],
  providers: [EmailTemplateSeeder],
})
export class EmailModule {}
