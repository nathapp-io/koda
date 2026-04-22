import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface OutboxEventInput {
  projectId: string;
  eventType: string;
  eventId: string;
  payload: unknown;
}

export interface OutboxEventData {
  id: string;
  projectId: string;
  eventType: string;
  eventId: string;
  payload: string;
  status: string;
  attempts: number;
  lastError: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_RETRIES = 3;
const PROCESSING_STALE_MS = 60_000;
const BACKOFF_MS = (attempt: number) => Math.pow(2, attempt * 2) * 1000;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async enqueue(event: OutboxEventInput): Promise<OutboxEventData> {
    const createdEvent = await this.prisma.client.outboxEvent.create({
      data: {
        projectId: event.projectId,
        eventType: event.eventType,
        eventId: event.eventId,
        payload: JSON.stringify(event.payload),
        status: 'pending',
      },
    });

    return this.mapToOutboxEventData(createdEvent);
  }

  async getPendingEvents(limit = 100): Promise<OutboxEventData[]> {
    const events = await this.prisma.client.outboxEvent.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return events.map(this.mapToOutboxEventData);
  }

  async getEventsByStatus(status: string, limit = 100): Promise<OutboxEventData[]> {
    const events = await this.prisma.client.outboxEvent.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return events.map(this.mapToOutboxEventData);
  }

  async processPending(limit = 50): Promise<void> {
    await this.requeueStaleProcessingEvents();

    const pendingEvents = await this.prisma.client.outboxEvent.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    for (const event of pendingEvents) {
      // Claim event to reduce duplicate processing across concurrent workers.
      const claimResult = await this.prisma.client.outboxEvent.updateMany({
        where: { id: event.id, status: 'pending' },
        data: { status: 'processing' },
      });
      if (claimResult.count === 0) {
        continue;
      }

      try {
        await this.processEvent(this.mapToOutboxEventData(event));
        await this.markCompleted(event.id);

        this.logger.log(`Outbox event ${event.id} processed successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error processing outbox event ${event.id}: ${errorMessage}`);
        await this.markFailed(event.id, errorMessage, Number(event.attempts ?? 0));
      }
    }
  }

  async retry(event: OutboxEventData): Promise<OutboxEventData> {
    if (event.attempts >= MAX_RETRIES) {
      return this.markDeadLetter(event.id, `Failed after ${MAX_RETRIES} retries`);
    }

    const updated = await this.prisma.client.outboxEvent.update({
      where: { id: event.id },
      data: {
        attempts: event.attempts + 1,
        status: 'pending',
      },
    });

    this.logger.log(`Outbox event ${event.id} retried (attempt ${updated.attempts})`);
    return this.mapToOutboxEventData(updated);
  }

  async markCompleted(eventId: string): Promise<void> {
    await this.prisma.client.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: 'completed',
        processedAt: new Date(),
        lastError: null,
      },
    });
  }

  async markFailed(eventId: string, error: string, currentAttempts: number): Promise<void> {
    const nextAttempts = currentAttempts + 1;
    const nextStatus = nextAttempts >= MAX_RETRIES ? 'dead_letter' : 'pending';

    await this.prisma.client.outboxEvent.update({
      where: { id: eventId },
      data: {
        attempts: nextAttempts,
        lastError: error,
        status: nextStatus,
      },
    });

    if (nextStatus === 'dead_letter') {
      this.logger.error(`Outbox event ${eventId} moved to dead_letter: ${error}`);
    }
  }

  async markDeadLetter(eventId: string, reason: string): Promise<OutboxEventData> {
    const updated = await this.prisma.client.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: 'dead_letter',
        lastError: reason,
      },
    });

    this.logger.error(`Outbox event ${eventId} moved to dead_letter: ${reason}`);
    return this.mapToOutboxEventData(updated);
  }

  async retryEvent(eventId: string): Promise<void> {
    await this.prisma.client.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: 'pending',
        lastError: null,
      },
    });
  }

  private async requeueStaleProcessingEvents(): Promise<void> {
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_MS);

    await this.prisma.client.outboxEvent.updateMany({
      where: {
        status: 'processing',
        updatedAt: { lt: staleThreshold },
      },
      data: { status: 'pending' },
    });
  }

  private async processEvent(_event: OutboxEventData): Promise<void> {
    // Placeholder for actual event processing logic
    // This could dispatch to handlers based on event type
    // For now, just resolve successfully
  }

  private mapToOutboxEventData(event: OutboxEventData | Record<string, unknown>): OutboxEventData {
    return {
      id: String(event.id),
      projectId: String(event.projectId),
      eventType: String(event.eventType),
      eventId: String(event.eventId),
      payload: String(event.payload),
      status: String(event.status),
      attempts: Number(
        (event.attempts as number | undefined)
          ?? (event as { retryCount?: number }).retryCount
          ?? 0,
      ),
      lastError: (event.lastError as string | null) ?? null,
      processedAt: (event.processedAt as Date | null) ?? null,
      createdAt: event.createdAt as Date,
      updatedAt: event.updatedAt as Date,
    };
  }
}
