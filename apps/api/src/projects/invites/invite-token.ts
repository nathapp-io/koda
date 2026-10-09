import { createHash, randomBytes } from 'crypto';

/**
 * Fleet S4b US-004: 32 random bytes as a 43-character base64url string. The raw token is shown once
 * (create/resend response and the invite email); only its sha256 hex digest is stored.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashInviteToken(raw) };
}

/** The lowercase sha256 hex digest of the raw token — the only value persisted. */
export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
