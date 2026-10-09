import { createHash } from 'crypto';
import { generateInviteToken, hashInviteToken } from './invite-token';

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('invite token (S4b US-004)', () => {
  it('AC-1: generateInviteToken returns a 43-character base64url raw and its lowercase sha256 hex hash', () => {
    const { raw, hash } = generateInviteToken();

    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(sha256Hex(raw));
  });

  it('AC-1: hashInviteToken returns the 64-character lowercase sha256 hex digest of the raw token', () => {
    const raw = 'a-known-raw-invite-token';

    expect(hashInviteToken(raw)).toBe(sha256Hex(raw));
    expect(hashInviteToken(raw)).toHaveLength(64);
  });

  it('AC-1: generateInviteToken never repeats a raw token', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateInviteToken().raw));

    expect(seen.size).toBe(1000);
  });
});
