import { createHmac, randomBytes } from 'crypto';
import { RUNNER_KEY_PREFIX } from '../../auth/guards/runner-route.decorator';

export const ENROLLMENT_TOKEN_PREFIX = 'ke_';

/** Same scheme as agent keys (agents.service.ts): HMAC-SHA256 under API_KEY_SECRET. */
export function hashSecret(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function generate(prefix: string, secret: string): { raw: string; hash: string } {
  if (!secret) throw new Error('API_KEY_SECRET is not configured');
  const raw = `${prefix}${randomBytes(32).toString('hex')}`;
  return { raw, hash: hashSecret(secret, raw) };
}

export const generateRunnerKey = (secret: string) => generate(RUNNER_KEY_PREFIX, secret);
export const generateEnrollmentToken = (secret: string) => generate(ENROLLMENT_TOKEN_PREFIX, secret);
