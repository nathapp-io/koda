import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationWriter } from '../notification-writer';
import { flowStoppedDraft } from './fleet-notification-drafts';
import { FLEET_FLOW_STOPPED, parseFlowStoppedPayload } from './fleet-notification-events';
import { FleetNotificationReader } from './fleet-notification.reader';

@Injectable()
@SystemWriter('system.notification.fleet')
export class FleetFlowStoppedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetFlowStoppedSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reader: FleetNotificationReader,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_FLOW_STOPPED, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseFlowStoppedPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_FLOW_STOPPED}: malformed payload skipped`);
      return;
    }
    const slug = await this.reader.projectSlug(p.projectId);
    if (!slug) return;
    const userIds = new Set<string>();
    if (p.approverId) userIds.add(p.approverId);
    if (p.creatorType === 'USER') userIds.add(p.creatorId);
    if (userIds.size === 0) return;
    await this.writer.deliver([...userIds].map((userId) => flowStoppedDraft(p, slug, userId)));
  };
}
