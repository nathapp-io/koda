import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationWriter } from '../notification-writer';
import { jobOutcomeDraft } from './fleet-notification-drafts';
import { FLEET_JOB_OUTCOME, parseJobOutcomePayload } from './fleet-notification-events';
import { FleetNotificationReader } from './fleet-notification.reader';

/** Fleet S4a §2.4: fleet_job_outcome -> the requester (FLEET_NEEDS_YOU). Throws only on database failure. */
@Injectable()
export class FleetJobOutcomeSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetJobOutcomeSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reader: FleetNotificationReader,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_JOB_OUTCOME, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseJobOutcomePayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_JOB_OUTCOME}: malformed payload skipped`);
      return;
    }
    const slug = await this.reader.projectSlug(p.projectId);
    if (!slug) return; // the project is gone: nobody to link to
    await this.writer.deliver([jobOutcomeDraft(p, slug)]);
  };
}
