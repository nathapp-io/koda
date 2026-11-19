import type { PrismaWebhookDeliveryRepository } from '../prisma-webhook-delivery.repository';

/** One accepted inbound delivery: the replay guard's dedup record (SEC-1). */
export interface WebhookDeliveryRecord {
  id: string;
  projectId: string;
  /** `github` | `ci`. */
  source: string;
  /** Sender-provided `X-GitHub-Delivery` / `X-CI-Delivery`. */
  deliveryId: string;
  receivedAt: Date;
}

/**
 * Review-1119 US-002 (B3): the delivery repository's port. Every repository is registered behind a
 * symbol token in its module, and this one is module-private like the rest of the replay guard's storage:
 * `WebhookSecurityModule` binds it with `useExisting` and never exports it. The retention processor still
 * injects the concrete class for its `deleteReceivedBefore` escape hatch.
 */
export type IWebhookDeliveryRepository = Pick<PrismaWebhookDeliveryRepository, 'deleteReceivedBefore'>;

export const WEBHOOK_DELIVERY_REPOSITORY = Symbol('WEBHOOK_DELIVERY_REPOSITORY');
