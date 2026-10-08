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
import { TicketWatchController } from './ticket-watch.controller';
import { TicketWatchService } from './ticket-watch.service';
import { TicketWatchersRepository } from './ticket-watchers.repository';
import { BudgetStoreModule } from '../fleet/budgets/budget-store.module';
import { FleetApprovalRequestedSubscriber } from './fleet/fleet-approval-requested.subscriber';
import { FleetBudgetIncidentSubscriber } from './fleet/fleet-budget-incident.subscriber';
import { FleetHealthAlertSubscriber } from './fleet/fleet-health-alert.subscriber';
import { FleetHealthAlertsRepository } from './fleet/fleet-health-alerts.repository';
import { FleetHealthDetector } from './fleet/fleet-health.detector';
import { FleetJobOutcomeSubscriber } from './fleet/fleet-job-outcome.subscriber';
import { FleetNotificationReader } from './fleet/fleet-notification.reader';

/**
 * Fleet S4a: in-app notifications. Producers are outbox fan-out handlers (D500); the writer is the
 * only path that inserts rows. Controllers are added in Tasks A8-A9.
 */
@Module({
  imports: [OutboxModule, LiveModule, ProjectAccessModule, BudgetStoreModule],
  controllers: [MeNotificationsController, TicketWatchController],
  providers: [
    MeNotificationsService,
    TicketWatchService,
    NotificationsRepository,
    TicketWatchersRepository,
    NotificationPreferencesService,
    NotificationEligibility,
    NotificationWriter,
    NotificationRetentionProcessor,
    TicketNotificationReadsRepository,
    TicketMentionResolver,
    TicketNotificationSubscriber,
    // Fleet S4a §2.4 (Part D)
    FleetNotificationReader,
    FleetHealthAlertsRepository,
    FleetJobOutcomeSubscriber,
    FleetApprovalRequestedSubscriber,
    FleetBudgetIncidentSubscriber,
    FleetHealthDetector,
    FleetHealthAlertSubscriber,
  ],
  exports: [NotificationWriter, NotificationEligibility],
})
export class NotificationsModule {}
