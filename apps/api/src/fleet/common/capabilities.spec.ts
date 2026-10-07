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

const TG_FAILED = { ok: false, plugin: 'telegram', code: 'TELEGRAM_NOT_CONFIGURED' };

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
    ['#207: interaction with an extra key', { ...valid, interaction: { ...TG_FAILED, message: 'x' } }],
    ['#207: interaction ok as a string', { ...valid, interaction: { ok: 'no', plugin: null } }],
    ['#207: interaction null', { ...valid, interaction: null }],
    ['#207: interaction without plugin', { ...valid, interaction: { ok: true } }],
    ['#207: an empty plugin name', { ...valid, interaction: { ok: true, plugin: '' } }],
    ['#207: a 65-character plugin name', { ...valid, interaction: { ok: true, plugin: 'p'.repeat(65) } }],
    ['#207: a lowercase code', { ...valid, interaction: { ok: false, plugin: 'telegram', code: 'not_configured' } }],
    ['#207: a profile interaction with an extra key', { ...valid, profiles: { native: { ...valid.profiles.native, interaction: { ...TG_FAILED, extra: 1 } } } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCapabilities(raw)).toThrow(ValidationAppException);
  });

  it('#207: keeps a valid base and per-profile interaction result, and leaves them absent when absent', () => {
    const raw = {
      ...valid,
      interaction: TG_FAILED,
      profiles: { native: { ...valid.profiles.native, interaction: { ok: true, plugin: null } } },
    };
    expect(parseCapabilities(raw)).toEqual(raw);
    const plain = parseCapabilities(valid);
    expect('interaction' in plain).toBe(false);
    expect('interaction' in plain.profiles['native']).toBe(false);
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

  describe('approvals (S1.5 §3, plan D271)', () => {
    it('keeps { relay: true }', () => {
      expect(parseCapabilitiesCore({ ...valid, approvals: { relay: true } }).approvals).toEqual({ relay: true });
    });
    it('omits approvals when absent', () => {
      expect(parseCapabilitiesCore(valid)).not.toHaveProperty('approvals');
    });
    it.each([[{ relay: false }], [{ relay: 'yes' }], [{ relay: true, extra: 1 }], [true], [{}]])('refuses approvals %p', (approvals) => {
      expect(() => parseCapabilitiesCore({ ...valid, approvals })).toThrow(/approvals/);
    });
  });

  describe('configJobs (fleet S3 §3)', () => {
    it('keeps configJobs: true', () => {
      expect(parseCapabilitiesCore({ ...valid, configJobs: true }).configJobs).toBe(true);
    });
    it('omits configJobs when absent (an older runner)', () => {
      expect(parseCapabilitiesCore(valid)).not.toHaveProperty('configJobs');
    });
    it.each([[false], ['yes'], [1], [{}]])('refuses configJobs %p', (configJobs) => {
      expect(() => parseCapabilitiesCore({ ...valid, configJobs })).toThrow(CapabilityValidationError);
    });
  });
});
