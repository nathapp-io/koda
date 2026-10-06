import { describe, expect, test } from 'bun:test';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import type { NaxCli } from '../nax/nax-cli';
import { FakeNaxCli, json, naxError, type NaxAnswers } from '../../test/helpers/fake-nax-cli';
import { NaxJobCheck, firstMismatch } from './job-check';

const REPO = '/w/acme/app';
const CAPS: RunnerCapabilities = {
  nax: { version: '0.83.1', protocols: ['native'] }, sandbox: { available: false, error: 'bwrap', probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const DEEPSEEK = { providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true };
const NONE = { transport: 'native' as const, providers: [], sandbox: false };

function checker(answers: NaxAnswers) {
  const nax = new FakeNaxCli(answers);
  return { nax, check: (profiles: string[] = []) => new NaxJobCheck({ nax, capabilities: () => CAPS }).check({ profiles }, REPO) };
}

describe('NaxJobCheck (D104)', () => {
  test('no profiles: trust, then the clone\'s default config (no --profile); nothing needed means no auth listing', async () => {
    const c = checker({ config: { default: NONE } });
    expect(await c.check()).toBeNull();
    expect(c.nax.calls).toEqual([
      { args: ['trust', 'check', '--json', REPO], cwd: REPO },
      { args: ['config', '-d', REPO, '--json'], cwd: REPO },
    ]);
  });
  test('the chain is joined with commas; needed providers are checked against a fresh listing', async () => {
    const c = checker({ config: { 'fast,review': { transport: 'native', providers: ['deepseek'], sandbox: false } }, auth: [DEEPSEEK] });
    expect(await c.check(['fast', 'review'])).toBeNull();
    expect(c.nax.calls.map((call) => call.args)).toEqual([
      ['trust', 'check', '--json', REPO],
      ['config', '-d', REPO, '--profile', 'fast,review', '--json'],
      ['auth', 'list', '--json', 'deepseek'],
    ]);
  });
  test('an untrusted clone is `project untrusted`, and no credential listing is asked', async () => {
    const c = checker({ trusted: false });
    expect(await c.check()).toBe('project untrusted');
    expect(c.nax.calls.map((call) => call.args[0])).not.toContain('auth');
  });
  test('a failed trust check is `trust check failed: <code>`', async () => {
    expect(await checker({ trusted: naxError('TRUST_STORE_UNREADABLE') }).check()).toBe('trust check failed: TRUST_STORE_UNREADABLE');
  });
  test('a chain nax cannot resolve is `profile resolve failed (<code>)`', async () => {
    expect(await checker({}).check(['nope'])).toBe('capability mismatch: profile resolve failed (PROFILE_NOT_FOUND)');
    expect(await checker({ config: { default: json({ requirements: {} }) } }).check()).toBe('capability mismatch: profile resolve failed (NAX_OUTPUT_UNPARSEABLE)');
  });
  test('an acp chain on a machine without acp is `protocol acp`', async () => {
    expect(await checker({ config: { cross: { transport: 'acp', providers: [], sandbox: false } } }).check(['cross'])).toBe('capability mismatch: protocol acp');
  });
  test('D99: a provider nax does not list is unavailable, never missing — the same answer the probe gives', async () => {
    const needs = { config: { fast: { transport: 'native' as const, providers: ['zai'], sandbox: false } } };
    expect(await checker({ ...needs, auth: json({ source: 'file', providers: [] }) }).check(['fast'])).toBe('capability mismatch: provider zai unavailable');
    expect(await checker({ ...needs, auth: json({ source: 'file', providers: [{ providerId: 'zai', stored: null, ambient: 'no', available: true }] }) }).check(['fast']))
      .toBe('capability mismatch: provider zai unavailable');
  });
  test('a provider nax lists as unusable is unavailable; a failed listing says so', async () => {
    const needs = { config: { fast: { transport: 'native' as const, providers: ['zai'], sandbox: false } } };
    expect(await checker(needs).check(['fast'])).toBe('capability mismatch: provider zai unavailable');
    expect(await checker({ ...needs, auth: naxError('CREDENTIAL_FILE_UNREADABLE') }).check(['fast'])).toBe('capability mismatch: auth list failed (CREDENTIAL_FILE_UNREADABLE)');
  });
  test('a sandbox chain on a machine whose sandbox is unavailable is `sandbox`', async () => {
    expect(await checker({ config: { safe: { transport: 'native', providers: [], sandbox: true } } }).check(['safe'])).toBe('capability mismatch: sandbox');
  });
  test('the trust check and the chain resolve overlap, so a job is not serialized behind nax', async () => {
    const inner = new FakeNaxCli({ config: { default: NONE } });
    const started: string[] = [];
    let releaseTrust: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { releaseTrust = resolve; });
    const nax: NaxCli = {
      async run(args, options) {
        started.push(args[0] ?? '');
        if (args[0] === 'config') releaseTrust();   // only a concurrent chain resolve can unblock the trust check
        if (args[0] === 'trust') await pending;
        return inner.run(args, options);
      },
    };
    const check = new NaxJobCheck({ nax, capabilities: () => CAPS }).check({ profiles: [] }, REPO);
    const settled = await Promise.race([
      check,
      new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('the chain resolve never started while the trust check was pending')), 500); }),
    ]);
    expect(settled).toBeNull();
    expect(started).toEqual(['trust', 'config']);
  });
  test('#207: a chain whose interaction plugin cannot start is refused, before credentials are listed', async () => {
    const tg = { ...NONE, providers: ['deepseek'], interaction: { plugin: 'telegram', status: 'failed', code: 'TELEGRAM_NOT_CONFIGURED' } };
    const c = checker({ config: { fast: tg }, auth: [DEEPSEEK] });
    expect(await c.check(['fast'])).toBe('capability mismatch: interaction telegram (TELEGRAM_NOT_CONFIGURED)');
    expect(c.nax.calls.map((call) => call.args[0])).not.toContain('auth');
  });
  test('#207: the base config (no profiles) is checked the same way', async () => {
    const c = checker({ config: { default: { ...NONE, interaction: { plugin: null, status: 'failed' } } } });
    expect(await c.check()).toBe('capability mismatch: interaction unknown (INTERACTION_INIT_FAILED)');
  });
  test('#207: ok, skipped and absent results pass', async () => {
    expect(await checker({ config: { default: { ...NONE, interaction: { plugin: 'telegram', status: 'ok' } } } }).check()).toBeNull();
    expect(await checker({ config: { default: { ...NONE, interaction: { plugin: null, status: 'skipped' } } } }).check()).toBeNull();
    expect(await checker({ config: { default: NONE } }).check()).toBeNull();
  });
  test('#207: trust still comes first', async () => {
    const c = checker({ trusted: false, config: { default: { ...NONE, interaction: { plugin: 'telegram', status: 'failed', code: 'X' } } } });
    expect(await c.check()).toBe('project untrusted');
  });
  test('every call carries the job check timeout, not the probe 30s one', async () => {
    const nax = new FakeNaxCli({ config: { fast: { transport: 'native', providers: ['deepseek'], sandbox: false } }, auth: [DEEPSEEK] });
    await new NaxJobCheck({ nax, capabilities: () => CAPS, timeoutMs: 1_234 }).check({ profiles: ['fast'] }, REPO);
    expect(nax.calls.map((call) => call.timeoutMs)).toEqual([1_234, 1_234, 1_234]);
  });
});

describe('firstMismatch (placement order: protocol, providers, sandbox)', () => {
  test('a provider problem is reported before a sandbox problem; a machine that meets everything is null', () => {
    const requirements = { transport: 'native' as const, providers: ['zai'], sandbox: true };
    expect(firstMismatch(requirements, CAPS, [{ providerId: 'zai', available: false, stored: null, ambient: false }])).toBe('capability mismatch: provider zai unavailable');
    expect(firstMismatch(requirements, { ...CAPS, sandbox: { available: true, probedAt: 't' } }, [{ providerId: 'zai', available: true, stored: null, ambient: true }])).toBeNull();
  });
});
