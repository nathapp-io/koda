import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { createMemoryLogger } from '../logger';
import { CapabilityReporter, StaticCapabilityProbe, hashCapabilities, stableStringify, type CapabilityProbe } from './capability-probe';

const stat = (over: Partial<StaticCapabilities> = {}): StaticCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false }, executors: ['host'], ...over,
});
let clock = new Date('2026-10-01T00:00:00.000Z');
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const noMeta = { setMeta: () => undefined };

describe('StaticCapabilityProbe', () => {
  test('reports the configured block, stamps sandbox.probedAt with the probe time (D41), and has no warnings', async () => {
    clock = new Date('2026-10-01T00:00:00.000Z');
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const first = await probe.probe();
    expect(first).toEqual({ capabilities: { ...stat(), sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' } }, warnings: [] });
    clock = new Date('2026-10-01T00:10:00.000Z');
    expect((await probe.probe()).capabilities.sandbox.probedAt).toBe('2026-10-01T00:10:00.000Z');
  });
  test('returns a copy: mutating a report does not change the next one', async () => {
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const a = (await probe.probe()).capabilities;
    a.tools.gh = false;
    expect((await probe.probe()).capabilities.tools.gh).toBe(true);
  });
  test('a sandbox error string is carried through', async () => {
    const report = await new StaticCapabilityProbe(stat({ sandbox: { available: false, error: 'bwrap missing' } }), () => clock).probe();
    expect(report.capabilities.sandbox).toEqual({ available: false, error: 'bwrap missing', probedAt: clock.toISOString() });
  });
});

describe('hashCapabilities', () => {
  test('ignores key order and sandbox.probedAt, and changes with anything else, the sandbox error included (D100)', async () => {
    const a = (await new StaticCapabilityProbe(stat(), () => new Date(1)).probe()).capabilities;
    const b = (await new StaticCapabilityProbe(stat(), () => new Date(99_999)).probe()).capabilities;
    expect(hashCapabilities(a)).toBe(hashCapabilities(b));
    expect(hashCapabilities({ ...a, tools: { glab: false, gh: true, git: true } })).toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, tools: { ...a.tools, glab: true } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, sandbox: { ...a.sandbox, available: false } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, sandbox: { ...a.sandbox, error: 'x' } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('stableStringify sorts keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });
});

describe('CapabilityReporter', () => {
  test('sends until marked, stays quiet for unchanged content, reports a change again; refresh says whether the hash changed', async () => {
    const meta: Record<string, string> = {};
    let current = stat();
    const probe: CapabilityProbe = { probe: async () => new StaticCapabilityProbe(current, () => clock).probe() };
    const reporter = new CapabilityReporter(probe, { setMeta: (k, v) => { meta[k] = v; } });
    expect(reporter.report()).toBeNull();
    expect(reporter.latest()).toBeNull();
    expect(await reporter.refresh()).toBe(true);
    const first = reporter.report();
    expect(first?.capabilities.nax.version).toBe('0.83.0');
    expect(reporter.latest()?.nax.version).toBe('0.83.0');
    expect(reporter.report()?.hash).toBe(first?.hash as string);
    reporter.markSent(first?.hash as string);
    expect(meta['last_capabilities_hash']).toBe(first?.hash as string);
    expect(reporter.report()).toBeNull();
    clock = new Date('2026-10-02T00:00:00.000Z');
    expect(await reporter.refresh()).toBe(false);
    expect(reporter.report()).toBeNull();
    current = stat({ tools: { git: true, gh: false, glab: false } });
    expect(await reporter.refresh()).toBe(true);
    expect(reporter.report()?.hash).not.toBe(first?.hash);
  });

  test('D102: refreshes are serialised; calls during a running probe share one queued probe', async () => {
    let runs = 0;
    const gates: Array<() => void> = [];
    const probe: CapabilityProbe = {
      probe: async () => {
        runs += 1;
        await new Promise<void>((resolve) => { gates.push(resolve); });
        return new StaticCapabilityProbe(stat(), () => clock).probe();
      },
    };
    const reporter = new CapabilityReporter(probe, noMeta);
    const first = reporter.refresh();
    await settle();
    const second = reporter.refresh();
    const third = reporter.refresh();
    expect(second).toBe(third);
    expect(runs).toBe(1);
    gates.shift()?.();
    expect(await first).toBe(true);
    await settle();
    expect(runs).toBe(2);
    gates.shift()?.();
    expect(await second).toBe(false);
    expect(runs).toBe(2);
  });

  test('Review focus 3: a probe that throws rejects refresh and keeps the last report; the next refresh works', async () => {
    let fail = false;
    const probe: CapabilityProbe = {
      probe: async () => {
        if (fail) throw new Error('nax gone');
        return new StaticCapabilityProbe(stat(), () => clock).probe();
      },
    };
    const reporter = new CapabilityReporter(probe, noMeta);
    await reporter.refresh();
    fail = true;
    await expect(reporter.refresh()).rejects.toThrow('nax gone');
    expect(reporter.latest()?.nax.version).toBe('0.83.0');
    fail = false;
    expect(await reporter.refresh()).toBe(false);
  });

  test('D102: warnings are logged when the set changes, not on every probe', async () => {
    const log = createMemoryLogger();
    let warnings = ['profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED'];
    const probe: CapabilityProbe = { probe: async () => ({ ...(await new StaticCapabilityProbe(stat(), () => clock).probe()), warnings }) };
    const reporter = new CapabilityReporter(probe, noMeta, log);
    await reporter.refresh();
    await reporter.refresh();
    warnings = [];
    await reporter.refresh();
    warnings = ['x'];
    await reporter.refresh();
    expect(log.lines.filter((l) => l.level === 'warn').map((l) => l.fields['detail'])).toEqual(['profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED', 'x']);
  });
});
