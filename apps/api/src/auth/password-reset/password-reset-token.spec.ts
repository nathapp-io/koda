import { createHash } from 'crypto';
import { generatePasswordResetToken, hashPasswordResetToken } from './password-reset-token';

describe('password reset tokens', () => {
  it('generates 32 random bytes encoded base64url and stores only the sha256 digest', () => {
    const token = generatePasswordResetToken();
    expect(Buffer.from(token.raw, 'base64url')).toHaveLength(32);
    expect(token.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.hash).toBe(createHash('sha256').update(token.raw).digest('hex'));
    expect(hashPasswordResetToken(token.raw)).toBe(token.hash);
    expect(generatePasswordResetToken().raw).not.toBe(token.raw);
  });
});
