import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { healthDrafts } from './fleet-notification-drafts';
import { FLEET_HEALTH_ALERT, parseHealthAlertPayload } from './fleet-notification-events';

/** Fleet S4a §2.4 (D507): fleet_health_alert -> every global admin (FLEET_HEALTH), once per opened episode. */
@Injectable()
export class FleetHealthAlertSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetHealthAlertSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly eligibility: NotificationEligibility,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_HEALTH_ALERT, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseHealthAlertPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_HEALTH_ALERT}: malformed payload skipped`);
      return;
    }
    await this.writer.deliver(healthDrafts(await this.eligibility.findGlobalAdminIds(), p));
  };
}
