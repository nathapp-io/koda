import { Injectable, Logger } from '@nestjs/common';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { OutboxEventDomain, OutboxEventInput } from './domain/outbox-event.domain';

export type { OutboxEventInput };

export type OutboxEventData = OutboxEventDomain;

const MAX_RETRIES = 3;
const PROCESSING_STALE_MS = 60_000;
const BACKOFF_MS = (attempt: number) => Math.pow(2, attempt * 2) * 1000;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly outboxRepo: PrismaOutboxRepository,
    private readonly fanOutRegistry: OutboxFanOutRegistry,
  ) {}

  async enqueue(event: OutboxEventInput): Promise<OutboxEventData> {
    return this.outboxRepo.enqueue(event);
  }

  async getPendingEvents(limit = 100): Promise<OutboxEventData[]> {
    const take = Math.max(Math.floor(limit), 0);
    return this.outboxRepo.findPending(take);
  }

  async getEventsByStatus(status: string, limit = 100): Promise<OutboxEventData[]> {
    const take = Math.max(Math.floor(limit), 0);
    return this.outboxRepo.findByStatus(status, take);
  }

  async processPending(limit = 50): Promise<void> {
    const take = Math.max(Math.floor(limit), 0);
    if (take === 0) {
      return;
    }
    await this.requeueStaleProcessingEvents();

    const pendingEvents = await this.outboxRepo.findPending(take);

    for (const event of pendingEvents) {
      const claimedCount = await this.outboxRepo.claimForProcessing(event.id);
      if (claimedCount === 0) {
        continue;
      }

      try {
        await this.processEvent(event as unknown as Record<string, unknown>);
        await this.markCompleted(event.id);

        this.logger.log(`Outbox event ${event.id} processed successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error processing outbox event ${event.id}: ${errorMessage}`);
        await this.markFailed(event.id, errorMessage, Number(event.attempts ?? 0));
      }
    }
  }

  async processEvent(event: Record<string, unknown>): Promise<void> {
    const parsedPayload = JSON.parse(String(event.payload ?? '{}'));
    await this.fanOutRegistry.dispatch({
      eventType: String(event.eventType),
      payload: parsedPayload,
    });
    const failureCount = typeof this.fanOutRegistry.consumeLastDispatchFailureCount === 'function'
      ? this.fanOutRegistry.consumeLastDispatchFailureCount()
      : 0;
    if (failureCount > 0) {
      throw new Error(`One or more fan-out handlers failed for ${String(event.eventType)}`);
    }
  }

  async retry(event: OutboxEventData): Promise<OutboxEventData> {
    if (event.attempts >= MAX_RETRIES) {
      return this.markDeadLetter(event.id, `Failed after ${MAX_RETRIES} retries`);
    }

    await this.delay(BACKOFF_MS(event.attempts));

    const updated = await this.outboxRepo.incrementAttemptsAndRequeue(event.id, event.attempts + 1);

    this.logger.log(`Outbox event ${event.id} retried (attempt ${updated.attempts})`);
    return updated;
  }

  async markCompleted(eventId: string): Promise<void> {
    await this.outboxRepo.markCompleted(eventId);
  }

  async markFailed(eventId: string, error: string, currentAttempts: number): Promise<void> {
    const nextAttempts = currentAttempts + 1;
    const nextStatus = nextAttempts >= MAX_RETRIES ? 'dead_letter' : 'pending';

    await this.outboxRepo.markFailed(eventId, error, nextAttempts, nextStatus);

    if (nextStatus === 'dead_letter') {
      this.logger.error(`Outbox event ${eventId} moved to dead_letter: ${error}`);
    }
  }

  async markDeadLetter(eventId: string, reason: string): Promise<OutboxEventData> {
    const updated = await this.outboxRepo.markDeadLetter(eventId, reason);
    this.logger.error(`Outbox event ${eventId} moved to dead_letter: ${reason}`);
    return updated;
  }

  async retryEvent(eventId: string): Promise<void> {
    await this.outboxRepo.retryEvent(eventId);
  }

  private async requeueStaleProcessingEvents(): Promise<void> {
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_MS);
    await this.outboxRepo.requeueStaleProcessing(staleThreshold);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
