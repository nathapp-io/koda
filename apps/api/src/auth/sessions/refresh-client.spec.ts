import { createHash } from 'node:crypto';
import { refreshClientOf } from './refresh-client';

/** The hash the helper must produce, computed independently of it. */
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('refreshClientOf', () => {
  it('AC-1: hashes the User-Agent and keeps the presenting IP', () => {
    expect(refreshClientOf('Mozilla/5.0 X', '203.0.113.7')).toEqual({
      uaHash: sha256('Mozilla/5.0 X'),
      ip: '203.0.113.7',
    });
  });

  it('AC-2: hashes the empty string when the header is absent, and answers a null IP', () => {
    expect(refreshClientOf(undefined, undefined)).toEqual({ uaHash: sha256(''), ip: null });
    // Never the literal "empty hash": a legacy token's null usedUaHash is what must not match.
    expect(refreshClientOf(undefined, undefined).uaHash).not.toBe('');
  });

  it('AC-3: maps an empty IP to null', () => {
    expect(refreshClientOf('UA', '')).toEqual({ uaHash: sha256('UA'), ip: null });
  });

  it('answers lowercase sha256 hex, so two clients compare by exact equality', () => {
    expect(refreshClientOf('UA-1', '198.51.100.9').uaHash).toMatch(/^[0-9a-f]{64}$/);
    // The IP is not part of the hash: the same browser recovers from a different network.
    expect(refreshClientOf('UA-1', '198.51.100.9').uaHash).toBe(refreshClientOf('UA-1', '203.0.113.7').uaHash);
    expect(refreshClientOf('UA-1', undefined).uaHash).not.toBe(refreshClientOf('UA-2', undefined).uaHash);
  });
});
