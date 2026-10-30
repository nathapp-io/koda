import { REDACTED_SECRET, redactSecret } from './redact-secret';

describe('redactSecret', () => {
  it('AC-1: redacts a non-empty secret', () => {
    expect(redactSecret('s')).toBe('<redacted>');
  });

  it('AC-1: redacts an empty string too, so a blank secret is still a secret', () => {
    expect(redactSecret('')).toBe('<redacted>');
  });

  it('AC-1: keeps null as null, which is a clearing patch rather than a secret', () => {
    expect(redactSecret(null)).toBeNull();
  });

  it('AC-1: keeps undefined as undefined, which is an absent field rather than a secret', () => {
    expect(redactSecret(undefined)).toBeUndefined();
  });

  it('AC-1: exposes the marker it answers', () => {
    expect(REDACTED_SECRET).toBe('<redacted>');
  });
});
