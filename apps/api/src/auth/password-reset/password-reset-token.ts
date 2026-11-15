import { createHash, randomBytes } from 'crypto';

export function hashPasswordResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generatePasswordResetToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashPasswordResetToken(raw) };
}
