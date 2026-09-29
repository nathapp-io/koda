import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseCapabilities } from './capabilities';

const valid = {
  nax: { version: '0.83.0', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: { native: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [{ providerId: 'deepseek', kind: 'api-key' }],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
};

describe('parseCapabilities', () => {
  it('accepts a valid report and returns a clean copy', () => {
    const parsed = parseCapabilities({ ...valid, extra: 'dropped' });
    expect(parsed).toEqual(valid);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['unknown protocol', { ...valid, nax: { version: '1', protocols: ['ssh'] } }],
    ['string sandbox flag', { ...valid, sandbox: { available: 'yes', probedAt: 'x' } }],
    ['bad profile', { ...valid, profiles: { p: { protocol: 'native', providers: 'deepseek', sandbox: true } } }],
    ['credential with a key field', { ...valid, credentials: [{ providerId: 'x', kind: 'api-key', key: 'sk-1' }] }],
    ['unknown executor', { ...valid, executors: ['vm'] }],
    ['missing tools', { ...valid, tools: undefined }],
    ['no protocols (#161)', { ...valid, nax: { version: '1', protocols: [] } }],
    ['duplicate protocols', { ...valid, nax: { version: '1', protocols: ['native', 'native'] } }],
    ['a profile name with a slash', { ...valid, profiles: { 'a/b': valid.profiles.native } }],
    ['a 65-character profile name', { ...valid, profiles: { ['p'.repeat(65)]: valid.profiles.native } }],
    ['65 profiles', { ...valid, profiles: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, valid.profiles.native])) }],
    ['17 providers in a profile', { ...valid, profiles: { p: { protocol: 'native', providers: Array.from({ length: 17 }, (_, i) => `x${i}`), sandbox: false } } }],
    ['65 credentials', { ...valid, credentials: Array.from({ length: 65 }, (_, i) => ({ providerId: `x${i}`, kind: 'api-key' })) }],
    ['an unparseable expiry', { ...valid, credentials: [{ providerId: 'x', kind: 'oauth', expires: 'soon' }] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCapabilities(raw)).toThrow(ValidationAppException);
  });

  it('keeps a parseable credential expiry', () => {
    const raw = { ...valid, credentials: [{ providerId: 'claude', kind: 'oauth', expires: '2026-10-01T00:00:00.000Z' }] };
    expect(parseCapabilities(raw).credentials).toEqual(raw.credentials);
  });

  it('rejects a report larger than 64 KiB', () => {
    const profiles: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i += 1) profiles[`p${i}`] = { protocol: 'native', providers: ['x'.repeat(30)], sandbox: true };
    expect(() => parseCapabilities({ ...valid, profiles })).toThrow(ValidationAppException);
  });
});
