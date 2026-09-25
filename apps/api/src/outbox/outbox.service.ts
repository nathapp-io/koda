import { Injectable } from '@nestjs/common';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { OutboxEventDomain, OutboxEventInput } from './domain/outbox-event.domain';

export type { OutboxEventInput };

export type OutboxEventData = OutboxEventDomain;

const clampLimit = (limit: number): number => Math.max(Math.floor(limit), 0);

/**
 * Transitional (Track 1 slice 2). Producers still call enqueue(), which records
 * through @nathapp/nestjs-outbox. Tasks 4-5 move every producer to the
 * package's record() inside its write's transaction. Task 6 replaces the admin
 * methods with OutboxAdminService and deletes this class.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly outbox: NathappOutboxService,
    private readonly outboxRepo: PrismaOutboxRepository,
  ) {}

  async enqueue(event: OutboxEventInput): Promise<void> {
    await this.outbox.record({
      type: event.eventType,
      payload: event.payload,
      metadata: { projectId: event.projectId, eventId: event.eventId },
    });
  }

  async getPendingEvents(limit = 100): Promise<OutboxEventData[]> {
    return this.outboxRepo.findByStatus('pending', clampLimit(limit));
  }

  async getEventsByStatus(status: string, limit = 100): Promise<OutboxEventData[]> {
    return this.outboxRepo.findByStatus(status, clampLimit(limit));
  }

  async retryEvent(eventId: string): Promise<void> {
    await this.outboxRepo.resetForRetry(eventId, new Date());
  }
}
