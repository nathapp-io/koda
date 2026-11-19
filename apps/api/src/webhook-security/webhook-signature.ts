import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * Longest delivery id a v2 delivery may carry, in UTF-8 bytes.
 *
 * `WebhookDelivery` is unique on (projectId, source, deliveryId) and Postgres caps one B-tree index
 * entry at 2704 bytes, while an HTTP header may be far longer. Without a limit a correctly signed v2
 * delivery with a huge id would authenticate and then fail the replay insert with a 5xx, so the CI
 * route refuses such an id before the replay guard (review B2). 255 bytes is far below the index cap
 * and above every real sender id (koda's own `X-Koda-Delivery-Id` is a hex content hash).
 */
export const MAX_DELIVERY_ID_BYTES = 255;

export function signatureV1(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * v2 over the body's exact bytes: `<timestamp>.<deliveryId>.` as UTF-8, then `body` unchanged.
 *
 * An inbound delivery signs the bytes it received, and decoding a body that is not valid UTF-8 first
 * would replace the invalid sequences and sign different text, so the buffer is hashed as it arrived
 * (review B1).
 */
export function signatureV2Bytes(secret: string, timestamp: string, deliveryId: string, body: Buffer): string {
  const prefix = Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8');
  return `sha256=${createHmac('sha256', secret).update(prefix).update(body).digest('hex')}`;
}

/** v2 over a body the sender also holds as text (the outbound handler posts a string body). */
export function signatureV2(secret: string, timestamp: string, deliveryId: string, body: string): string {
  return signatureV2Bytes(secret, timestamp, deliveryId, Buffer.from(body, 'utf8'));
}

export function signaturesMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);

  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

export function isFreshTimestamp(timestamp: string, nowMs: number): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) {
    return false;
  }

  const timestampSec = Number(timestamp);
  const nowSec = nowMs / 1000;
  return Number.isFinite(nowSec) && Math.abs(nowSec - timestampSec) <= WEBHOOK_TIMESTAMP_TOLERANCE_SEC;
}

/** Whether a received delivery id is present and short enough to record in the replay table. */
export function isAcceptableDeliveryId(deliveryId: string | undefined): deliveryId is string {
  return (
    deliveryId !== undefined &&
    deliveryId.length > 0 &&
    Buffer.byteLength(deliveryId, 'utf8') <= MAX_DELIVERY_ID_BYTES
  );
}
