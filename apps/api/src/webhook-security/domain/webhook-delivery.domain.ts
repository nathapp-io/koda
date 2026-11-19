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
