import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { budgetDrafts } from './fleet-notification-drafts';
import { FLEET_BUDGET_INCIDENT, parseBudgetIncidentPayload } from './fleet-notification-events';

/** Fleet S4a §2.4 (D508): fleet_budget_incident (warn, hard_stop) -> every global admin (FLEET_HEALTH). */
@Injectable()
export class FleetBudgetIncidentSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetBudgetIncidentSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly eligibility: NotificationEligibility,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_BUDGET_INCIDENT, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseBudgetIncidentPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_BUDGET_INCIDENT}: malformed payload skipped`);
      return;
    }
    await this.writer.deliver(budgetDrafts(await this.eligibility.findGlobalAdminIds(), p));
  };
}
