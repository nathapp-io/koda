import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient, WebhookDelivery as WebhookDeliveryModel } from '../generated/prisma/client';
import { WebhookDeliveryRecord } from './domain/webhook-delivery.domain';

/**
 * US-002: the `WebhookDelivery` rows the replay guard writes are dedup records, not source of truth,
 * so after the configured horizon they are deleted to keep the table bounded. Module-private: only
 * `WebhookDeliveryRetentionProcessor` reads it, and nothing outside `WebhookSecurityModule` may
 * depend on the replay guard's storage.
 *
 * A row is written once and never updated; the only write this repository adds is the retention
 * delete, which is why `toPersistenceUpdate` throws instead of accepting a patch.
 */
@Injectable()
export class PrismaWebhookDeliveryRepository extends AbstractPrismaRepository<
  WebhookDeliveryRecord,
  WebhookDeliveryModel,
  string
> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<WebhookDeliveryModel, string> {
    const delegate = (client as unknown as Record<string, unknown>).webhookDelivery;
    return delegate as PrismaModelDelegate<WebhookDeliveryModel, string>;
  }

  protected toDomain(m: WebhookDeliveryModel): WebhookDeliveryRecord {
    return {
      id: m.id,
      projectId: m.projectId,
      source: m.source,
      deliveryId: m.deliveryId,
      receivedAt: m.receivedAt,
    };
  }

  protected toPersistenceCreate(d: WebhookDeliveryRecord) {
    return { projectId: d.projectId, source: d.source, deliveryId: d.deliveryId, receivedAt: d.receivedAt };
  }

  /** A delivery is recorded once by the replay guard and deleted by age; it is never patched. */
  protected toPersistenceUpdate(): never {
    throw new Error('webhook deliveries are never updated');
  }

  /**
   * One statement, strict `receivedAt < before`: a delivery received exactly at the cutoff is kept.
   * Returns the number of rows deleted, so the processor can record an entry only when it purged
   * something. `prisma.client` is the transaction-aware proxy, so a caller inside `txManager.run`
   * deletes inside that transaction — the retention purge relies on it: a rejected audit record rolls
   * the delete back.
   */
  async deleteReceivedBefore(before: Date): Promise<number> {
    const { count } = await this.prisma.client.webhookDelivery.deleteMany({
      where: { receivedAt: { lt: before } },
    });
    return count;
  }
}
