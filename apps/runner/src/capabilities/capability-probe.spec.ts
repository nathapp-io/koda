import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { CapabilityReporter, StaticCapabilityProbe, hashCapabilities, stableStringify } from './capability-probe';

const stat = (over: Partial<StaticCapabilities> = {}): StaticCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false }, executors: ['host'], ...over,
});
let clock = new Date('2026-10-01T00:00:00.000Z');

describe('StaticCapabilityProbe', () => {
  test('reports the configured block and stamps sandbox.probedAt with the probe time (D41)', async () => {
    clock = new Date('2026-10-01T00:00:00.000Z');
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const first = await probe.probe();
    expect(first).toEqual({ ...stat(), sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' } });
    clock = new Date('2026-10-01T00:10:00.000Z');
    expect((await probe.probe()).sandbox.probedAt).toBe('2026-10-01T00:10:00.000Z');
  });
  test('returns a copy: mutating a report does not change the next one', async () => {
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const a = await probe.probe();
    a.tools.gh = false;
    expect((await probe.probe()).tools.gh).toBe(true);
  });
  test('a sandbox error string is carried through', async () => {
    expect((await new StaticCapabilityProbe(stat({ sandbox: { available: false, error: 'bwrap missing' } }), () => clock).probe()).sandbox).toEqual({ available: false, error: 'bwrap missing', probedAt: clock.toISOString() });
  });
});

describe('hashCapabilities', () => {
  test('ignores key order and sandbox.probedAt, and changes with anything else', async () => {
    const a = await new StaticCapabilityProbe(stat(), () => new Date(1)).probe();
    const b = await new StaticCapabilityProbe(stat(), () => new Date(99_999)).probe();
    expect(hashCapabilities(a)).toBe(hashCapabilities(b));
    expect(hashCapabilities({ ...a, tools: { glab: false, gh: true, git: true } })).toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, tools: { ...a.tools, glab: true } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, sandbox: { ...a.sandbox, available: false } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('stableStringify sorts keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });
});

describe('CapabilityReporter', () => {
  test('sends until marked, stays quiet for unchanged content, and reports a change again', async () => {
    const meta: Record<string, string> = {};
    let current = stat();
    const probe = { probe: async () => new StaticCapabilityProbe(current, () => clock).probe() };
    const reporter = new CapabilityReporter(probe, { setMeta: (k, v) => { meta[k] = v; } });
    expect(reporter.report()).toBeNull();                       // nothing probed yet
    await reporter.refresh();
    const first = reporter.report();
    expect(first?.capabilities.nax.version).toBe('0.83.0');
    expect(reporter.report()?.hash).toBe(first?.hash as string);   // still not confirmed: keep sending
    reporter.markSent(first?.hash as string);
    expect(meta['last_capabilities_hash']).toBe(first?.hash as string);
    expect(reporter.report()).toBeNull();
    clock = new Date('2026-10-02T00:00:00.000Z');
    await reporter.refresh();
    expect(reporter.report()).toBeNull();                       // only probedAt moved
    current = stat({ tools: { git: true, gh: false, glab: false } });
    await reporter.refresh();
    expect(reporter.report()?.hash).not.toBe(first?.hash);
  });
});
