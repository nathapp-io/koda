import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxEvent as OutboxEventModel, PrismaClient } from '@prisma/client';
import { OutboxEventDomain, OutboxEventInput, OUTBOX_BACKOFF_MS } from './domain/outbox-event.domain';

@Injectable()
export class PrismaOutboxRepository extends AbstractPrismaRepository<OutboxEventDomain, OutboxEventModel, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<OutboxEventModel, string> {
    return (client as unknown as PrismaClient).outboxEvent as unknown as PrismaModelDelegate<OutboxEventModel, string>;
  }

  protected toDomain(m: OutboxEventModel): OutboxEventDomain {
    return {
      id: m.id,
      projectId: m.projectId,
      eventType: m.eventType,
      eventId: m.eventId,
      payload: m.payload,
      status: m.status,
      attempts: m.attempts,
      lastError: m.lastError,
      nextAttemptAt: m.nextAttemptAt,
      processedAt: m.processedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  protected toPersistenceCreate(d: OutboxEventDomain): Omit<OutboxEventModel, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      projectId: d.projectId,
      eventType: d.eventType,
      eventId: d.eventId,
      payload: d.payload,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError ?? null,
      nextAttemptAt: d.nextAttemptAt ?? null,
      processedAt: d.processedAt ?? null,
    };
  }

  protected toPersistenceUpdate(patch: Partial<OutboxEventDomain>): Partial<Omit<OutboxEventModel, 'id' | 'createdAt' | 'updatedAt'>> {
    const data: Partial<Omit<OutboxEventModel, 'id' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.projectId !== undefined) data.projectId = patch.projectId;
    if (patch.eventType !== undefined) data.eventType = patch.eventType;
    if (patch.eventId !== undefined) data.eventId = patch.eventId;
    if (patch.payload !== undefined) data.payload = patch.payload;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.attempts !== undefined) data.attempts = patch.attempts;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    if (patch.nextAttemptAt !== undefined) data.nextAttemptAt = patch.nextAttemptAt;
    if (patch.processedAt !== undefined) data.processedAt = patch.processedAt;
    return data;
  }

  async enqueue(event: OutboxEventInput): Promise<OutboxEventDomain> {
    const model = await this.prisma.client.outboxEvent.create({
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
    const models = await this.prisma.client.outboxEvent.findMany({
      where: {
        status: 'pending',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return models.map((m) => this.toDomain(m));
  }

  async findByStatus(status: string, limit: number): Promise<OutboxEventDomain[]> {
    const models = await this.prisma.client.outboxEvent.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return models.map((m) => this.toDomain(m));
  }

  async claimForProcessing(id: string): Promise<number> {
    const result = await this.prisma.client.outboxEvent.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'processing' },
    });
    return result.count;
  }

  async markCompleted(id: string): Promise<void> {
    await this.prisma.client.outboxEvent.update({
      where: { id },
      data: {
        status: 'completed',
        processedAt: new Date(),
        lastError: null,
      },
    });
  }

  async markFailed(id: string, error: string, nextAttempts: number, nextStatus: string): Promise<void> {
    // nextAttempts is the post-increment attempt count; OUTBOX_BACKOFF_MS expects the
    // pre-increment count (matching OutboxService.retry()'s schedule of 1s, 4s, 16s).
    const nextAttemptAt = nextStatus === 'pending' ? new Date(Date.now() + OUTBOX_BACKOFF_MS(nextAttempts - 1)) : null;

    await this.prisma.client.outboxEvent.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        lastError: error,
        status: nextStatus,
        nextAttemptAt,
      },
    });
  }

  async markDeadLetter(id: string, reason: string): Promise<OutboxEventDomain> {
    const model = await this.prisma.client.outboxEvent.update({
      where: { id },
      data: {
        status: 'dead_letter',
        lastError: reason,
      },
    });
    return this.toDomain(model);
  }

  async retryEvent(id: string): Promise<void> {
    await this.prisma.client.outboxEvent.update({
      where: { id },
      data: {
        status: 'pending',
        lastError: null,
        nextAttemptAt: null,
      },
    });
  }

  async incrementAttemptsAndRequeue(id: string, nextAttempts: number): Promise<OutboxEventDomain> {
    const model = await this.prisma.client.outboxEvent.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        status: 'pending',
        nextAttemptAt: null,
      },
    });
    return this.toDomain(model);
  }

  async requeueStaleProcessing(staleThreshold: Date): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: {
        status: 'processing',
        updatedAt: { lt: staleThreshold },
      },
      data: { status: 'pending', nextAttemptAt: null },
    });
  }
}
