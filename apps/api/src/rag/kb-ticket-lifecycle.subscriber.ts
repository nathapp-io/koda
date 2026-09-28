import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { RagService } from './rag.service';
import { PrismaRagRepository } from './prisma-rag.repository';

/**
 * M15: removes a ticket's KB document when the ticket is soft-deleted.
 *
 * Every ticket_event subscriber receives every action, so this handler acts on
 * TICKET_DELETED only. The outbox is at-least-once and a retry re-runs every
 * handler; deleteBySource is idempotent. A missing or soft-deleted project has
 * no reachable KB, so the event completes instead of failing on every retry.
 */
@Injectable()
export class KbTicketLifecycleSubscriber implements OnModuleInit {
  private readonly logger = new Logger(KbTicketLifecycleSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly ragService: RagService,
    private readonly ragRepository: PrismaRagRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent.bind(this));
  }

  async handleTicketEvent(payload: unknown): Promise<void> {
    const event = (payload ?? {}) as { action?: unknown; ticketId?: unknown; projectId?: unknown; id?: unknown };
    if (event.action !== 'TICKET_DELETED') return;
    if (typeof event.ticketId !== 'string' || typeof event.projectId !== 'string') {
      this.logger.warn(`TICKET_DELETED event ${String(event.id)} has no ticketId/projectId; skipping KB cleanup`);
      return;
    }

    const project = await this.ragRepository.findProjectById(event.projectId);
    if (!project || project.deletedAt !== null) return;

    await this.ragService.deleteBySource(event.projectId, event.ticketId);
  }
}
