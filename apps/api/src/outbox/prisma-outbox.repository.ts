import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { OutboxEventDomain, OutboxEventInput } from './domain/outbox-event.domain';

@Injectable()
export class PrismaOutboxRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client.outboxEvent;
  }

  private toDomain(m: {
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
  }): OutboxEventDomain {
    return {
      id: m.id,
      projectId: m.projectId,
      eventType: m.eventType,
      eventId: m.eventId,
      payload: m.payload,
      status: m.status,
      attempts: m.attempts,
      lastError: m.lastError,
      processedAt: m.processedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  async enqueue(event: OutboxEventInput): Promise<OutboxEventDomain> {
    const model = await this.db.create({
      data: {
        projectId: event.projectId,
        eventType: event.eventType,
        eventId: event.eventId,
        payload: JSON.stringify(event.payload),
        status: 'pending',
      },
    });
    return this.toDomain(model);
  }

  async findPending(limit: number): Promise<OutboxEventDomain[]> {
    const models = await this.db.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return models.map((m) => this.toDomain(m));
  }

  async findByStatus(status: string, limit: number): Promise<OutboxEventDomain[]> {
    const models = await this.db.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return models.map((m) => this.toDomain(m));
  }

  async claimForProcessing(id: string): Promise<number> {
    const result = await this.db.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'processing' },
    });
    return result.count;
  }

  async markCompleted(id: string): Promise<void> {
    await this.db.update({
      where: { id },
      data: {
        status: 'completed',
        processedAt: new Date(),
        lastError: null,
      },
    });
  }

  async markFailed(id: string, error: string, nextAttempts: number, nextStatus: string): Promise<void> {
    await this.db.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        lastError: error,
        status: nextStatus,
      },
    });
  }

  async markDeadLetter(id: string, reason: string): Promise<OutboxEventDomain> {
    const model = await this.db.update({
      where: { id },
      data: {
        status: 'dead_letter',
        lastError: reason,
      },
    });
    return this.toDomain(model);
  }

  async retryEvent(id: string): Promise<void> {
    await this.db.update({
      where: { id },
      data: {
        status: 'pending',
        lastError: null,
      },
    });
  }

  async incrementAttemptsAndRequeue(id: string, nextAttempts: number): Promise<OutboxEventDomain> {
    const model = await this.db.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        status: 'pending',
      },
    });
    return this.toDomain(model);
  }

  async requeueStaleProcessing(staleThreshold: Date): Promise<void> {
    await this.db.updateMany({
      where: {
        status: 'processing',
        updatedAt: { lt: staleThreshold },
      },
      data: { status: 'pending' },
    });
  }
}
