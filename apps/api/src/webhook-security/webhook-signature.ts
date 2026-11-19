import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

export function signatureV1(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function signatureV2(secret: string, timestamp: string, deliveryId: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;
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
