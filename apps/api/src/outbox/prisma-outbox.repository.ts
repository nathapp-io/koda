import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxEvent as OutboxEventModel, PrismaClient } from '@prisma/client';
import { OutboxEventDomain } from './domain/outbox-event.domain';

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
      type: m.type,
      eventId: m.eventId,
      payload: m.payload,
      headers: m.headers,
      status: m.status,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt,
      leaseUntil: m.leaseUntil,
      owner: m.owner,
      lastError: m.lastError,
      publishedAt: m.publishedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  protected toPersistenceCreate(d: OutboxEventDomain): Omit<OutboxEventModel, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      projectId: d.projectId,
      type: d.type,
      eventId: d.eventId,
      payload: d.payload,
      headers: d.headers ?? null,
      status: d.status,
      attempts: d.attempts,
      nextAttemptAt: d.nextAttemptAt,
      leaseUntil: d.leaseUntil ?? null,
      owner: d.owner ?? null,
      lastError: d.lastError ?? null,
      publishedAt: d.publishedAt ?? null,
    };
  }

  protected toPersistenceUpdate(patch: Partial<OutboxEventDomain>): Partial<Omit<OutboxEventModel, 'id' | 'createdAt' | 'updatedAt'>> {
    const data: Partial<Omit<OutboxEventModel, 'id' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.projectId !== undefined) data.projectId = patch.projectId;
    if (patch.type !== undefined) data.type = patch.type;
    if (patch.eventId !== undefined) data.eventId = patch.eventId;
    if (patch.payload !== undefined) data.payload = patch.payload;
    if (patch.headers !== undefined) data.headers = patch.headers;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.attempts !== undefined) data.attempts = patch.attempts;
    if (patch.nextAttemptAt !== undefined) data.nextAttemptAt = patch.nextAttemptAt;
    if (patch.leaseUntil !== undefined) data.leaseUntil = patch.leaseUntil;
    if (patch.owner !== undefined) data.owner = patch.owner;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    if (patch.publishedAt !== undefined) data.publishedAt = patch.publishedAt;
    return data;
  }

  async findById(id: string): Promise<OutboxEventDomain | null> {
    const model = await this.prisma.client.outboxEvent.findUnique({ where: { id } });
    return model ? this.toDomain(model) : null;
  }

  async findByStatus(status: string, limit: number): Promise<OutboxEventDomain[]> {
    const models = await this.prisma.client.outboxEvent.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return models.map((m) => this.toDomain(m));
  }

  async countByStatus(status: string): Promise<number> {
    return this.prisma.client.outboxEvent.count({ where: { status } });
  }

  /** Admin retry: back to pending, due now, lease and error cleared. Returns rows changed. */
  async resetForRetry(id: string, now: Date): Promise<number> {
    const result = await this.prisma.client.outboxEvent.updateMany({
      where: { id, status: { in: ['dead', 'pending'] } },
      data: { status: 'pending', attempts: 0, nextAttemptAt: now, owner: null, leaseUntil: null, lastError: null },
    });
    return result.count;
  }

  /** Writes the latest fan-out failure for the admin view. A missing row is a no-op. */
  async recordLastError(id: string, message: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id },
      data: { lastError: message },
    });
  }

  /**
   * Retention purge (issue #135): delete terminal rows whose last change predates
   * the cutoff. updatedAt is the terminal-transition time — markPublished/markDead
   * are a terminal row's last writes — and an admin retry bumps it, giving a
   * retried row a fresh retention window. Returns rows deleted.
   */
  async deleteTerminalBefore(statuses: string[], before: Date): Promise<number> {
    const result = await this.prisma.client.outboxEvent.deleteMany({
      where: { status: { in: statuses }, updatedAt: { lt: before } },
    });
    return result.count;
  }
}
