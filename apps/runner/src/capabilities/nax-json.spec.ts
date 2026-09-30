import { describe, expect, test } from 'bun:test';
import { parseAuthList, parseRequirements, parseSandboxProbe, parseTrustCheck, toProfileNeeds, unavailableCredential } from './nax-json';

// nax 0.83.1 `config --profile native-ds --json`, this machine, 2026-09-30 (`config` block elided).
const CONFIG_NATIVE = {
  profile: 'native-ds', profileChain: ['native-ds'], sources: { global: '/home/u/.nax/config.json', project: null },
  requirements: { agent: 'native', transport: 'native', protocol: 'hybrid', providers: ['openrouter', 'minimax', 'opencode-go', 'minimax'], sandbox: true },
  config: {},
};
const CONFIG_ACP = { ...CONFIG_NATIVE, requirements: { agent: 'opencode', transport: 'acp', protocol: 'hybrid', providers: [], sandbox: false } };

// SPEC-cli-json-output AuthListReport, exec source (with an account label and a helper error).
const AUTH_EXEC = {
  source: 'exec', helper: { command: ['/usr/local/bin/cred-helper', '--team', 'a'] },
  providers: [
    { providerId: 'anthropic', stored: null, exec: { status: 'served', account: 'team-a' }, ambient: false, available: true },
    { providerId: 'openai', stored: { kind: 'api-key', expired: false }, exec: { status: 'declined' }, ambient: false, available: true },
    { providerId: 'zai', stored: null, exec: { status: 'error', code: 'CREDENTIAL_HELPER_FAILED' }, ambient: false, available: false },
  ],
};
// nax 0.83.1 `auth list --json deepseek`, file source, this machine.
const AUTH_FILE = {
  source: 'file',
  providers: [
    { providerId: 'deepseek', stored: null, ambient: false, available: false },
    { providerId: 'openai-codex', stored: { kind: 'oauth', expired: false, expires: '2026-10-01T06:54:37.064Z' }, ambient: false, available: true },
  ],
};

describe('parseRequirements (design §3.2, D98)', () => {
  test('transport becomes the protocol; providers are deduplicated and sorted; sandbox is kept', () => {
    const r = parseRequirements(CONFIG_NATIVE);
    expect(r).toEqual({ transport: 'native', providers: ['minimax', 'opencode-go', 'openrouter'], sandbox: true });
    expect(toProfileNeeds(r as NonNullable<typeof r>)).toEqual({ protocol: 'native', providers: ['minimax', 'opencode-go', 'openrouter'], sandbox: true });
    expect(parseRequirements(CONFIG_ACP)).toEqual({ transport: 'acp', providers: [], sandbox: false });
  });
  test.each([
    ['no requirements', { profile: 'x' }],
    ['an unknown transport', { requirements: { ...CONFIG_NATIVE.requirements, transport: 'hybrid' } }],
    ['a non-boolean sandbox', { requirements: { ...CONFIG_NATIVE.requirements, sandbox: 'yes' } }],
    ['a non-string provider', { requirements: { ...CONFIG_NATIVE.requirements, providers: ['a', 7] } }],
    ['an empty provider id', { requirements: { ...CONFIG_NATIVE.requirements, providers: [''] } }],
    ['a 201-character provider id', { requirements: { ...CONFIG_NATIVE.requirements, providers: ['p'.repeat(201)] } }],
  ])('%s is null', (_what, report) => {
    expect(parseRequirements(report)).toBeNull();
  });
});

describe('parseAuthList (design §1.1, D99)', () => {
  test('exec becomes its status string; account labels, helper codes, source and helper are dropped', () => {
    expect(parseAuthList(AUTH_EXEC)).toEqual({
      skipped: 0,
      credentials: [
        { providerId: 'anthropic', available: true, stored: null, exec: 'served', ambient: false },
        { providerId: 'openai', available: true, stored: { kind: 'api-key', expired: false }, exec: 'declined', ambient: false },
        { providerId: 'zai', available: false, stored: null, exec: 'error', ambient: false },
      ],
    });
  });
  test('a file source has no exec key; an OAuth expiry is kept', () => {
    expect(parseAuthList(AUTH_FILE)?.credentials).toEqual([
      { providerId: 'deepseek', available: false, stored: null, ambient: false },
      { providerId: 'openai-codex', available: true, stored: { kind: 'oauth', expires: '2026-10-01T06:54:37.064Z', expired: false }, ambient: false },
    ]);
  });
  test('a malformed row is skipped and counted, the rest kept', () => {
    const report = {
      providers: [
        AUTH_FILE.providers[1],
        { providerId: 'a', stored: { kind: 'password', expired: false }, ambient: false, available: true },
        { providerId: 'b', stored: null, ambient: 'no', available: true },
        { providerId: 'c', stored: null, exec: { status: 'maybe' }, ambient: false, available: true },
        { providerId: 'd', stored: { kind: 'oauth', expired: false, expires: 'not a date' }, ambient: false, available: true },
        'e',
      ],
    };
    const parsed = parseAuthList(report);
    expect(parsed?.skipped).toBe(5);
    expect(parsed?.credentials.map((c) => c.providerId)).toEqual(['openai-codex']);
  });
  test('no providers array is null', () => {
    expect(parseAuthList({ source: 'file' })).toBeNull();
  });
  test('unavailableCredential is what a provider nax could not list looks like', () => {
    expect(unavailableCredential('zai')).toEqual({ providerId: 'zai', available: false, stored: null, ambient: false });
  });
});

describe('parseSandboxProbe (D100)', () => {
  test('available, and unavailable with nax\'s reason capped at 200 characters', () => {
    expect(parseSandboxProbe({ backend: 'srt', platform: 'darwin', available: true })).toEqual({ available: true });
    expect(parseSandboxProbe({ backend: 'srt', platform: 'linux', available: false, reason: 'sandbox could not run a command: bwrap: No permissions to create new namespace' }))
      .toEqual({ available: false, error: 'sandbox could not run a command: bwrap: No permissions to create new namespace' });
    expect(parseSandboxProbe({ available: false, reason: 'r'.repeat(300) })?.error).toHaveLength(200);
    expect(parseSandboxProbe({ available: false })).toEqual({ available: false, error: 'unavailable' });
  });
  test('no boolean available is null', () => {
    expect(parseSandboxProbe({ backend: 'srt' })).toBeNull();
  });
});

describe('parseTrustCheck (D103)', () => {
  test('reads trusted and root', () => {
    expect(parseTrustCheck({ root: '/w/acme/app', trusted: true, coveredBy: '/w' })).toEqual({ trusted: true, root: '/w/acme/app' });
    expect(parseTrustCheck({ root: '/w', trusted: false, coveredBy: null })).toEqual({ trusted: false, root: '/w' });
    expect(parseTrustCheck({ root: '/w' })).toBeNull();
  });
});
