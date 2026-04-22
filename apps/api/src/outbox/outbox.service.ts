import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface OutboxEventInput {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxEventData {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: string;
  status: string;
  retryCount: number;
  lastError: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_RETRIES = 3;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async enqueue(event: OutboxEventInput): Promise<OutboxEventData> {
    const createdEvent = await this.prisma.client.outboxEvent.create({
      data: {
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        eventType: event.eventType,
        payload: JSON.stringify(event.payload),
        status: 'pending',
      },
    });

    return this.mapToOutboxEventData(createdEvent);
  }

  async processPending(): Promise<void> {
    const pendingEvents = await this.prisma.client.outboxEvent.findMany({
      where: { status: 'pending' },
    });

    for (const event of pendingEvents) {
      try {
        // Process the event (placeholder for actual processing logic)
        await this.processEvent();

        // Mark as completed
        await this.prisma.client.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'completed',
            processedAt: new Date(),
          },
        });

        this.logger.log(`Outbox event ${event.id} processed successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error processing outbox event ${event.id}: ${errorMessage}`);

        // Mark as failed and update last error
        const failedEvent = await this.prisma.client.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'failed',
            lastError: errorMessage,
          },
        });

        // Call retry state machine: resets to 'pending' for retry or moves to 'dead_letter'
        await this.retry(this.mapToOutboxEventData(failedEvent));
      }
    }
  }

  async retry(event: OutboxEventData): Promise<OutboxEventData> {
    if (event.retryCount >= MAX_RETRIES) {
      // Move to dead letter
      const updated = await this.prisma.client.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'dead_letter',
          lastError: `Failed after ${MAX_RETRIES} retries`,
        },
      });

      this.logger.error(`Outbox event ${event.id} moved to dead_letter after ${MAX_RETRIES} retries`);
      return this.mapToOutboxEventData(updated);
    }

    // Increment retry count
    const updated = await this.prisma.client.outboxEvent.update({
      where: { id: event.id },
      data: {
        retryCount: event.retryCount + 1,
        status: 'pending',
      },
    });

    this.logger.log(`Outbox event ${event.id} retried (attempt ${updated.retryCount})`);
    return this.mapToOutboxEventData(updated);
  }

  private async processEvent(): Promise<void> {
    // Placeholder for actual event processing logic
    // This could dispatch to handlers based on event type
    // For now, just resolve successfully
  }

  private mapToOutboxEventData(event: OutboxEventData | Record<string, unknown>): OutboxEventData {
    return {
      id: String(event.id),
      aggregateId: String(event.aggregateId),
      aggregateType: String(event.aggregateType),
      eventType: String(event.eventType),
      payload: String(event.payload),
      status: String(event.status),
      retryCount: Number(event.retryCount),
      lastError: (event.lastError as string | null) ?? null,
      processedAt: (event.processedAt as Date | null) ?? null,
      createdAt: event.createdAt as Date,
      updatedAt: event.updatedAt as Date,
    };
  }
}
