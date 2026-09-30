import { describe, expect, test } from 'bun:test';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
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
  test('an untrusted clone is `project untrusted`, and nothing else is asked', async () => {
    const c = checker({ trusted: false });
    expect(await c.check()).toBe('project untrusted');
    expect(c.nax.calls).toHaveLength(1);
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
  test('a provider nax does not list is missing; one it lists as unusable is unavailable; a failed listing says so', async () => {
    const needs = { config: { fast: { transport: 'native' as const, providers: ['zai'], sandbox: false } } };
    expect(await checker({ ...needs, auth: json({ source: 'file', providers: [] }) }).check(['fast'])).toBe('capability mismatch: provider zai missing');
    expect(await checker(needs).check(['fast'])).toBe('capability mismatch: provider zai unavailable');
    expect(await checker({ ...needs, auth: naxError('CREDENTIAL_FILE_UNREADABLE') }).check(['fast'])).toBe('capability mismatch: auth list failed (CREDENTIAL_FILE_UNREADABLE)');
  });
  test('a sandbox chain on a machine whose sandbox is unavailable is `sandbox`', async () => {
    expect(await checker({ config: { safe: { transport: 'native', providers: [], sandbox: true } } }).check(['safe'])).toBe('capability mismatch: sandbox');
  });
});

describe('firstMismatch (placement order: protocol, providers, sandbox)', () => {
  test('a provider problem is reported before a sandbox problem; a machine that meets everything is null', () => {
    const requirements = { transport: 'native' as const, providers: ['zai'], sandbox: true };
    expect(firstMismatch(requirements, CAPS, [{ providerId: 'zai', available: false, stored: null, ambient: false }])).toBe('capability mismatch: provider zai unavailable');
    expect(firstMismatch(requirements, { ...CAPS, sandbox: { available: true, probedAt: 't' } }, [{ providerId: 'zai', available: true, stored: null, ambient: true }])).toBeNull();
  });
});
