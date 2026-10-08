import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { NotificationEligibility } from './notification-eligibility';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationRetentionProcessor } from './notification-retention.processor';
import { MeNotificationsController } from './me-notifications.controller';
import { MeNotificationsService } from './me-notifications.service';
import { NotificationWriter } from './notification-writer';
import { NotificationsRepository } from './notifications.repository';
import { TicketMentionResolver } from './ticket-mention.resolver';
import { TicketNotificationReadsRepository } from './ticket-notification-reads.repository';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';
import { TicketWatchersRepository } from './ticket-watchers.repository';

/**
 * Fleet S4a: in-app notifications. Producers are outbox fan-out handlers (D500); the writer is the
 * only path that inserts rows. Controllers are added in Tasks A8-A9.
 */
@Module({
  imports: [OutboxModule, LiveModule, ProjectAccessModule],
  controllers: [MeNotificationsController],
  providers: [
    MeNotificationsService,
    NotificationsRepository,
    TicketWatchersRepository,
    NotificationPreferencesService,
    NotificationEligibility,
    NotificationWriter,
    NotificationRetentionProcessor,
    TicketNotificationReadsRepository,
    TicketMentionResolver,
    TicketNotificationSubscriber,
  ],
  exports: [NotificationWriter, NotificationEligibility],
})
export class NotificationsModule {}
