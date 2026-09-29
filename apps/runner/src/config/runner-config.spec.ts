import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunnerCredential } from '@nathapp/fleet-protocol';
import { ConfigError, isLoopbackHost, parseRunnerConfig, resolveHome } from './runner-config';

const credential = { providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false };
const capabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [credential],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
};
const base = { serverUrl: 'https://koda.example.com', workspaceRoot: '/srv/koda-runner/work', capabilities };
const parse = (over: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) => parseRunnerConfig({ ...base, ...over }, env);

describe('parseRunnerConfig', () => {
  test('applies the defaults', () => {
    const c = parse();
    expect(c).toMatchObject({
      serverUrl: 'https://koda.example.com', allowInsecureHttp: false, workspaceRoot: '/srv/koda-runner/work', labels: [],
      naxCommand: ['nax'], naxHome: join(homedir(), '.nax'), jobRetentionDays: 7,
    });
    expect(c.capabilities.tools.gh).toBe(true);
  });
  test('naxHome follows NAX_GLOBAL_CONFIG_DIR, and an explicit value wins', () => {
    expect(parse({}, { NAX_GLOBAL_CONFIG_DIR: '/opt/nax' }).naxHome).toBe('/opt/nax');
    expect(parse({ naxHome: '/x/nax' }, { NAX_GLOBAL_CONFIG_DIR: '/opt/nax' }).naxHome).toBe('/x/nax');
  });
  test('normalises the server url and keeps a path prefix', () => {
    expect(parse({ serverUrl: 'https://koda.example.com/' }).serverUrl).toBe('https://koda.example.com');
    expect(parse({ serverUrl: 'https://koda.example.com/koda/' }).serverUrl).toBe('https://koda.example.com/koda');
  });
  test('requires https unless loopback or explicitly allowed', () => {
    expect(() => parse({ serverUrl: 'http://koda.internal' })).toThrow(ConfigError);
    expect(parse({ serverUrl: 'http://koda.internal', allowInsecureHttp: true }).serverUrl).toBe('http://koda.internal');
    for (const url of ['http://localhost:3101', 'http://127.0.0.1:3101', 'http://[::1]:3101']) expect(parse({ serverUrl: url }).serverUrl).toBe(url);
  });
  test.each([
    ['not a url', { serverUrl: 'nope' }],
    ['a non-http scheme', { serverUrl: 'ftp://x.example.com' }],
    ['credentials in the url', { serverUrl: 'https://u:p@koda.example.com' }],
    ['a query string', { serverUrl: 'https://koda.example.com/?a=1' }],
    ['a relative workspaceRoot', { workspaceRoot: 'work' }],
    ['a label with capitals', { labels: ['Linux'] }],
    ['21 labels', { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }],
    ['an empty naxCommand', { naxCommand: [] }],
    ['a non-string naxCommand entry', { naxCommand: ['nax', 1] }],
    ['retention 0', { jobRetentionDays: 0 }],
    ['retention 400', { jobRetentionDays: 400 }],
    ['a relative naxHome', { naxHome: 'nax' }],
    ['missing capabilities', { capabilities: undefined }],
    ['capabilities without protocols', { capabilities: { ...capabilities, nax: { version: '1', protocols: [] } } }],
    ['an unknown executor', { capabilities: { ...capabilities, executors: ['vm'] } }],
    ['tools not booleans', { capabilities: { ...capabilities, tools: { git: 'yes', gh: true, glab: false } } }],
    ['the pre-3a credential shape {providerId, kind}', { capabilities: { ...capabilities, credentials: [{ providerId: 'deepseek', kind: 'api-key' }] } }],
    ['a credential without stored', { capabilities: { ...capabilities, credentials: [{ providerId: 'deepseek', available: true, ambient: false }] } }],
    ['a credential with a key field', { capabilities: { ...capabilities, credentials: [{ ...credential, key: 'sk-1' }] } }],
    ['a string available flag', { capabilities: { ...capabilities, credentials: [{ ...credential, available: 'yes' }] } }],
    ['a stored kind of password', { capabilities: { ...capabilities, credentials: [{ ...credential, stored: { kind: 'password', expired: false } }] } }],
    ['an exec status of maybe', { capabilities: { ...capabilities, credentials: [{ ...credential, exec: 'maybe' }] } }],
    ['65 credentials', { capabilities: { ...capabilities, credentials: Array.from({ length: 65 }, (_, i) => ({ ...credential, providerId: `p${i}` })) } }],
    ['credentials that is not an array', { capabilities: { ...capabilities, credentials: {} } }],
  ])('rejects %s', (_label, over) => {
    expect(() => parse(over as Record<string, unknown>)).toThrow(ConfigError);
  });
  test('keeps a well-formed credentials block, including exec and an ambient-only entry', () => {
    const credentials: RunnerCredential[] = [
      { providerId: 'claude', available: true, stored: { kind: 'oauth', expires: '2026-10-01T00:00:00.000Z', expired: false }, exec: 'declined', ambient: true },
      { providerId: 'env-only', available: true, stored: null, ambient: true },
    ];
    expect(parse({ capabilities: { ...capabilities, credentials } }).capabilities.credentials).toEqual(credentials);
  });
  test('names the bad credential in the error, so the operator can find it in runner.json', () => {
    expect(() => parse({ capabilities: { ...capabilities, credentials: [credential, { providerId: 'x' }] } })).toThrow(/credentials\[1\]/);
  });
  test('rejects a non-object document', () => {
    expect(() => parseRunnerConfig('x', {})).toThrow(ConfigError);
  });
});

describe('isLoopbackHost', () => {
  test.each(['localhost', '127.0.0.1', '::1', '[::1]', '127.1.2.3'])('%s is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  test.each(['example.com', '10.0.0.1', '0.0.0.0', 'localhost.evil.com'])('%s is not', (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe('resolveHome', () => {
  test('override beats env beats the default', () => {
    expect(resolveHome({ KODA_RUNNER_HOME: '/a' }, '/b').dir).toBe('/b');
    expect(resolveHome({ KODA_RUNNER_HOME: '/a' }).dir).toBe('/a');
    expect(resolveHome({}).dir).toBe(join(homedir(), '.koda-runner'));
  });
  test('names the three files', () => {
    const h = resolveHome({}, '/h');
    expect([h.configPath, h.identityPath, h.journalPath]).toEqual(['/h/runner.json', '/h/identity.json', '/h/journal.db']);
  });
});
