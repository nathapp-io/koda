import { Injectable, Logger } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { IOutboxStore, OutboxRecord, OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxEvent as OutboxEventModel, Prisma, PrismaClient } from '@prisma/client';

/**
 * IOutboxStore on Prisma/Postgres for @nathapp/nestjs-outbox.
 *
 * save() writes through the client the package passes in: the active
 * transaction client inside txManager.run, the root client outside it (in
 * which case the row commits on its own). claimBatch() is one UPDATE ...
 * FOR UPDATE SKIP LOCKED statement (Prisma has no SKIP LOCKED). Every state
 * write is guarded by owner, so a relay whose lease expired cannot overwrite
 * a newer claim.
 */
@Injectable()
export class PrismaOutboxStore implements IOutboxStore {
  private readonly logger = new Logger(PrismaOutboxStore.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async save(record: OutboxRecord, client: unknown): Promise<void> {
    const projectId = record.metadata?.['projectId'];
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new ValidationAppException({ projectId: 'outbox record metadata.projectId is required' }, 'outbox');
    }
    const eventId = record.metadata?.['eventId'];
    const db = (client ?? this.prisma.client) as PrismaClient;
    await db.outboxEvent.create({
      data: {
        id: record.id,
        projectId,
        type: record.type,
        eventId: typeof eventId === 'string' && eventId.length > 0 ? eventId : record.id,
        payload: JSON.stringify(record.payload ?? null),
        headers: record.headers ? JSON.stringify(record.headers) : null,
        status: record.status,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        createdAt: record.createdAt,
      },
    });
  }

  async claimBatch(limit: number, leaseMs: number, now: Date, owner: string): Promise<OutboxRecord[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.prisma.client.$queryRaw<OutboxEventModel[]>(Prisma.sql`
      UPDATE "OutboxEvent"
      SET "status" = 'processing', "owner" = ${owner}, "leaseUntil" = ${leaseUntil}, "updatedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "OutboxEvent"
        WHERE ("status" = 'pending' AND "nextAttemptAt" <= ${now})
           OR ("status" = 'processing' AND "leaseUntil" < ${now})
        ORDER BY "nextAttemptAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
    // RETURNING order is unspecified.
    return [...rows]
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .map((row) => this.toRecord(row));
  }

  async markPublished(id: string, publishedAt: Date, owner: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, owner, status: OutboxStatus.PROCESSING },
      data: { status: OutboxStatus.PUBLISHED, publishedAt, owner: null, leaseUntil: null, lastError: null },
    });
  }

  async markRetry(id: string, attempts: number, nextAttemptAt: Date, owner: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, owner, status: OutboxStatus.PROCESSING },
      data: { status: OutboxStatus.PENDING, attempts, nextAttemptAt, owner: null, leaseUntil: null },
    });
  }

  async markDead(id: string, attempts: number, owner: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, owner, status: OutboxStatus.PROCESSING },
      data: { status: OutboxStatus.DEAD, attempts, owner: null, leaseUntil: null },
    });
  }

  private toRecord(row: OutboxEventModel): OutboxRecord {
    return {
      id: row.id,
      type: row.type,
      payload: this.parseJson(row.id, row.payload),
      status: row.status as OutboxStatus,
      attempts: row.attempts,
      createdAt: row.createdAt,
      nextAttemptAt: row.nextAttemptAt,
      leaseUntil: row.leaseUntil ?? undefined,
      owner: row.owner ?? undefined,
      publishedAt: row.publishedAt ?? undefined,
      headers: row.headers ? (this.parseJson(row.id, row.headers) as Record<string, string>) : undefined,
      metadata: { projectId: row.projectId, eventId: row.eventId },
    };
  }

  /** A malformed row must not fail the whole claim: hand the raw text on and let its handlers fail. */
  private parseJson(id: string, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.logger.warn(`Outbox event ${id} has unparseable JSON; passing it on as raw text`);
      return text;
    }
  }
}
