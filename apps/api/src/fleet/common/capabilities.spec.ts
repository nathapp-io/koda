import { ValidationAppException } from '@nathapp/nestjs-common';
import { CapabilityValidationError, parseCapabilitiesCore } from './capabilities-core';
import { parseCapabilities } from './capabilities';

const cred = (over: Record<string, unknown> = {}) => ({ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false, ...over });

const valid = {
  nax: { version: '0.83.0', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: { native: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [cred()],
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
    ['the pre-3a credential shape {providerId, kind}', { ...valid, credentials: [{ providerId: 'x', kind: 'api-key' }] }],
    ['a credential with a key field', { ...valid, credentials: [cred({ key: 'sk-1' })] }],
    ['a credential without available', { ...valid, credentials: [{ providerId: 'x', stored: null, ambient: false }] }],
    ['a credential without stored (stored is required: an object or null)', { ...valid, credentials: [{ providerId: 'x', available: true, ambient: false }] }],
    ['a credential with stored undefined', { ...valid, credentials: [cred({ stored: undefined })] }],
    ['a credential without ambient', { ...valid, credentials: [{ providerId: 'x', available: true, stored: null }] }],
    ['a string available flag', { ...valid, credentials: [cred({ available: 'yes' })] }],
    ['a stored kind of password', { ...valid, credentials: [cred({ stored: { kind: 'password', expired: false } })] }],
    ['a stored entry without expired', { ...valid, credentials: [cred({ stored: { kind: 'oauth' } })] }],
    ['a stored entry with a secret field', { ...valid, credentials: [cred({ stored: { kind: 'oauth', expired: false, secret: 's' } })] }],
    ['an exec status of maybe', { ...valid, credentials: [cred({ exec: 'maybe' })] }],
    ['unknown executor', { ...valid, executors: ['vm'] }],
    ['missing tools', { ...valid, tools: undefined }],
    ['no protocols (#161)', { ...valid, nax: { version: '1', protocols: [] } }],
    ['duplicate protocols', { ...valid, nax: { version: '1', protocols: ['native', 'native'] } }],
    ['a profile name with a slash', { ...valid, profiles: { 'a/b': valid.profiles.native } }],
    ['a 65-character profile name', { ...valid, profiles: { ['p'.repeat(65)]: valid.profiles.native } }],
    ['65 profiles', { ...valid, profiles: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, valid.profiles.native])) }],
    ['17 providers in a profile', { ...valid, profiles: { p: { protocol: 'native', providers: Array.from({ length: 17 }, (_, i) => `x${i}`), sandbox: false } } }],
    ['65 credentials', { ...valid, credentials: Array.from({ length: 65 }, (_, i) => cred({ providerId: `x${i}` })) }],
    ['an unparseable expiry', { ...valid, credentials: [cred({ stored: { kind: 'oauth', expires: 'soon', expired: false } })] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCapabilities(raw)).toThrow(ValidationAppException);
  });

  it('keeps a stored oauth credential with its expiry, an exec verdict and the ambient flag', () => {
    const raw = {
      ...valid,
      credentials: [
        cred({ providerId: 'claude', stored: { kind: 'oauth', expires: '2026-10-01T00:00:00.000Z', expired: false }, exec: 'declined', ambient: true }),
        cred({ providerId: 'env-only', available: true, stored: null, ambient: true }),
        cred({ providerId: 'broken', available: false, stored: null, exec: 'error' }),
      ],
    };
    expect(parseCapabilities(raw).credentials).toEqual(raw.credentials);
  });

  it('rejects a report larger than 64 KiB', () => {
    const profiles: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i += 1) profiles[`p${i}`] = { protocol: 'native', providers: ['x'.repeat(30)], sandbox: true };
    expect(() => parseCapabilities({ ...valid, profiles })).toThrow(ValidationAppException);
  });
});

/**
 * The validator itself carries no NestJS: the runner's merge gate imports this module so that proving a real report
 * passes does not depend on this app's dependency graph (apps/runner/test/live/nax-probe.live.spec.ts).
 */
describe('parseCapabilitiesCore', () => {
  it('returns the same clean copy as the NestJS wrapper', () => {
    expect(parseCapabilitiesCore({ ...valid, extra: 'dropped' })).toEqual(valid);
  });

  it('throws a plain Error carrying the reason, for every rejection the wrapper rejects', () => {
    expect(() => parseCapabilitiesCore({ ...valid, tools: undefined })).toThrow(CapabilityValidationError);
    expect(() => parseCapabilitiesCore({ ...valid, tools: undefined })).toThrow(/tools/);
    expect(() => parseCapabilitiesCore({ ...valid, executors: ['vm'] })).toThrow(/executors/);
    expect(() => parseCapabilitiesCore('x')).toThrow(CapabilityValidationError);
  });
});
