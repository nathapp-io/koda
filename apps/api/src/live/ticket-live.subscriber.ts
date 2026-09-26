import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { ProjectEventBus } from './project-event-bus';
import { toLiveEvent } from './live-event';

/**
 * ticket_event fan-out handler that republishes a content-free LiveEvent to
 * the in-process bus. Never throws, so it never causes an outbox retry
 * (a sibling handler's failure can still cause a re-delivery; clients dedupe
 * on the event id).
 */
@Injectable()
export class TicketLiveSubscriber implements OnModuleInit {
  private readonly logger = new Logger(TicketLiveSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly bus: ProjectEventBus,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent);
  }

  private readonly handleTicketEvent = (payload: unknown): void => {
    try {
      const event = toLiveEvent(payload);
      if (event) this.bus.publish(event);
    } catch (err) {
      this.logger.warn(`Live ticket event dropped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
