import { randomBytes } from 'crypto';

/** M9: a new inbound-webhook signing secret (32 hex chars, 128 bits). */
export function generateWebhookSecret(): string {
  return randomBytes(16).toString('hex');
}
