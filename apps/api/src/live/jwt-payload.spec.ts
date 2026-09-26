import { decodeJwtPayload, tokenExpiryMs } from './jwt-payload';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: unknown): string => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

describe('decodeJwtPayload', () => {
  it('decodes the payload segment', () => {
    expect(decodeJwtPayload(token({ sub: 'u1', exp: 1700000000 }))).toEqual({ sub: 'u1', exp: 1700000000 });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['two segments', 'a.b'],
    ['a non-JSON payload', 'a.bm90LWpzb24.c'],
    ['an array payload', token([1, 2])],
    ['a primitive payload', token(42)],
  ])('returns null for %s', (_label, value) => {
    expect(decodeJwtPayload(value as string | null)).toBeNull();
  });
});

describe('tokenExpiryMs', () => {
  it('converts exp seconds to milliseconds', () => {
    expect(tokenExpiryMs({ exp: 1700000000 })).toBe(1700000000000);
  });

  it('returns null without a numeric exp', () => {
    expect(tokenExpiryMs({})).toBeNull();
    expect(tokenExpiryMs({ exp: '1700000000' })).toBeNull();
  });
});
