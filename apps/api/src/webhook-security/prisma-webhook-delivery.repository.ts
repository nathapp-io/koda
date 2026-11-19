import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';

/**
 * US-002: the `WebhookDelivery` rows the replay guard writes are dedup records, not source of truth,
 * so after the configured horizon they are deleted to keep the table bounded. Module-private: only
 * `WebhookDeliveryRetentionProcessor` reads it, and nothing outside `WebhookSecurityModule` may
 * depend on the replay guard's storage.
 */
@Injectable()
export class PrismaWebhookDeliveryRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /**
   * One statement, strict `receivedAt < before`: a delivery received exactly at the cutoff is kept.
   * Returns the number of rows deleted, so the processor can record an entry only when it purged
   * something. The client is the transaction-aware proxy, so a caller inside `txManager.run` deletes
   * inside that transaction (the retention purge relies on it: a rejected audit record rolls the
   * delete back).
   */
  async deleteReceivedBefore(before: Date): Promise<number> {
    const { count } = await this.prisma.client.webhookDelivery.deleteMany({
      where: { receivedAt: { lt: before } },
    });
    return count;
  }
}
