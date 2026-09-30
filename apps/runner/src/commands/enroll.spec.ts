import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_PROTOCOL_VERSION, type EnrollRequest, type RunnerCapabilities } from '@nathapp/fleet-protocol';
import { loadRunnerConfig, resolveHome, type RunnerConfig } from '../config/runner-config';
import { readIdentity } from '../identity/identity-store';
import { NaxUnavailableError } from '../nax/nax-cli';
import { NetworkError, ServerError } from '../sync/http';
import { makeTempDirs } from '../../test/helpers/tmp';
import { EnrollError, defaultRunnerName, enrollRunner, type EnrollDeps } from './enroll';

const PROBED: RunnerCapabilities = {
  nax: { version: '0.83.1', protocols: ['native'] }, sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false }, executors: ['host'],
};

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

function deps(over: Partial<EnrollDeps> & { enroll?: (body: EnrollRequest) => Promise<{ runnerId: string; apiKey: string }> } = {}) {
  const sent: EnrollRequest[] = [];
  const lines: string[] = [];
  const d: EnrollDeps = {
    env: {}, hostname: () => 'Mac-Mini.local', platform: 'darwin', arch: 'arm64', probe: () => ({ probe: async () => ({ capabilities: PROBED, warnings: [] }) }),
    now: () => new Date('2026-10-01T00:00:00.000Z'), log: (l) => { lines.push(l); },
    makeClient: () => ({ enroll: async (body) => { sent.push(body); return (over.enroll ?? (async () => ({ runnerId: 'r1', apiKey: 'kr_secret' })))(body); } }),
    ...over,
  };
  return { d, sent, lines };
}
async function opts(over: Record<string, unknown> = {}) {
  const dir = await tmp.make('enroll');
  return { home: resolveHome({}, join(dir, 'home')), server: 'https://koda.example.com', token: 'ke_token', labels: ['gpu'], insecureHttp: false, ...over } as Parameters<typeof enrollRunner>[0];
}

describe('helpers', () => {
  test.each([['Mac-Mini.local', 'mac-mini-local'], ['BOX_1', 'box-1'], ['---x', 'x'], ['', 'runner'], ['a'.repeat(100), 'a'.repeat(63)]])('defaultRunnerName(%j) = %j', (h, n) => {
    expect(defaultRunnerName(h)).toBe(n);
    expect(n).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});

describe('enrollRunner', () => {
  test('writes runner.json (without a capabilities block) and identity.json (0600), sends the probed capabilities and protocol version, and never stores the token', async () => {
    const o = await opts();
    const { d, sent } = deps();
    expect(await enrollRunner(o, d)).toEqual({ runnerId: 'r1', name: 'mac-mini-local' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      enrollmentToken: 'ke_token', name: 'mac-mini-local', os: 'darwin', arch: 'arm64', protocolVersion: FLEET_PROTOCOL_VERSION, labels: ['gpu'],
      capabilities: PROBED,
    });
    expect(sent[0].bootId).toMatch(/^[0-9a-f-]{36}$/);
    const identity = await readIdentity(o.home.identityPath);
    expect(identity).toMatchObject({ runnerId: 'r1', apiKey: 'kr_secret', serverUrl: 'https://koda.example.com', name: 'mac-mini-local', enrolledAt: '2026-10-01T00:00:00.000Z' });
    expect((await stat(o.home.identityPath)).mode & 0o777).toBe(0o600);
    const config = await loadRunnerConfig(o.home.configPath, {});
    expect(config).toMatchObject({ serverUrl: 'https://koda.example.com', labels: ['gpu'], workspaceRoot: join(o.home.dir, 'workspace') });
    expect(JSON.parse(await readFile(o.home.configPath, 'utf8')).capabilities).toBeUndefined();
    expect(await readFile(o.home.configPath, 'utf8')).not.toContain('ke_token');
    expect(await readFile(o.home.identityPath, 'utf8')).not.toContain('ke_token');
  });
  test('honours --name, --workspace and --insecure-http for a non-loopback http server', async () => {
    const o = await opts({ server: 'http://koda.vpn:3101', insecureHttp: true, name: 'lab-1', workspace: join(await tmp.make('ws'), 'w') });
    const { d } = deps();
    expect((await enrollRunner(o, d)).name).toBe('lab-1');
    const config = await loadRunnerConfig(o.home.configPath, {});
    expect(config).toMatchObject({ allowInsecureHttp: true, serverUrl: 'http://koda.vpn:3101' });
  });
  test('refuses http on a non-loopback host without --insecure-http, before any request', async () => {
    const o = await opts({ server: 'http://koda.vpn:3101' });
    const { d, sent } = deps();
    await expect(enrollRunner(o, d)).rejects.toBeInstanceOf(EnrollError);
    expect(sent).toEqual([]);
  });
  test('refuses when already enrolled, naming the file to delete', async () => {
    const o = await opts();
    const { d } = deps();
    await enrollRunner(o, d);
    await expect(enrollRunner(o, d)).rejects.toThrow(/already enrolled.*identity\.json/s);
  });
  test('an existing runner.json is kept, and options it would have taken are named as ignored (D72)', async () => {
    const o = await opts({ labels: ['gpu'], workspace: join(await tmp.make('ws'), 'elsewhere'), insecureHttp: true });
    const { d, lines } = deps();
    await Bun.$`mkdir -p ${o.home.dir}`;
    const original = JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(o.home.dir, 'w'), labels: ['edited'],
      capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: true }, executors: ['host'] },
    });
    await writeFile(o.home.configPath, original);
    await enrollRunner(o, d);
    expect(await readFile(o.home.configPath, 'utf8')).toBe(original);
    const warning = lines.find((l) => /ignored/.test(l)) ?? '';
    for (const flag of ['--labels', '--workspace', '--insecure-http']) expect(warning).toContain(flag);
    expect(warning).toContain(o.home.configPath);
    const quiet = await opts({ labels: [], insecureHttp: false });
    const q = deps();
    await Bun.$`mkdir -p ${quiet.home.dir}`;
    await writeFile(quiet.home.configPath, original);
    await enrollRunner(quiet, q.d);
    expect(q.lines.some((l) => /ignored/.test(l))).toBe(false);
  });
  test('keeps an existing runner.json (hand-edited capabilities survive) and refuses a different --server', async () => {
    const o = await opts();
    const { d } = deps();
    await Bun.$`mkdir -p ${o.home.dir}`;
    await writeFile(o.home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(o.home.dir, 'w'), labels: ['edited'],
      capabilities: { nax: { version: '0.83.0', protocols: ['native', 'acp'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: true }, executors: ['host'] },
    }));
    await enrollRunner(o, d);
    expect(JSON.parse(await readFile(o.home.configPath, 'utf8')).labels).toEqual(['edited']);
    const other = await opts({ server: 'https://other.example.com' });
    await Bun.$`mkdir -p ${other.home.dir}`;
    await writeFile(other.home.configPath, await readFile(o.home.configPath, 'utf8'));
    await expect(enrollRunner(other, deps().d)).rejects.toThrow(/differs from/);
  });
  test('a missing server (no runner.json, no --server) is an error', async () => {
    await expect(enrollRunner(await opts({ server: undefined }), deps().d)).rejects.toThrow(/--server/);
  });
  test.each([
    [new ServerError(401, 'x', null), /invalid, used or expired/],
    [new ServerError(409, 'x', null), /already exists.*--name/s],
    [new ServerError(426, 'Unsupported protocol version 2', null), /does not support/],
    [new ServerError(400, 'bad capabilities', null), /rejected the request: bad capabilities/],
    [new NetworkError('ECONNREFUSED'), /cannot reach the server/],
  ])('maps %p to a readable EnrollError and writes no identity', async (failure, message) => {
    const o = await opts();
    const { d } = deps({ enroll: async () => { throw failure; } });
    await expect(enrollRunner(o, d)).rejects.toThrow(message);
    expect(await readIdentity(o.home.identityPath)).toBeNull();
  });
  test('an unsupported platform or architecture is refused', async () => {
    await expect(enrollRunner(await opts(), deps({ platform: 'win32' }).d)).rejects.toThrow(/unsupported platform/);
    await expect(enrollRunner(await opts(), deps({ arch: 'ia32' }).d)).rejects.toThrow(/unsupported platform/);
  });
  test('D97: a probe that fails (nax missing or older than 0.83.1) is an EnrollError; nothing is sent and no identity is written', async () => {
    const o = await opts();
    const { d, sent } = deps({ probe: () => ({ probe: async () => { throw new NaxUnavailableError('koda-runner needs nax 0.83.1 or newer (found 0.80.0)'); } }) });
    await expect(enrollRunner(o, d)).rejects.toThrow(/needs nax 0\.83\.1 or newer/);
    await expect(enrollRunner(o, d)).rejects.toBeInstanceOf(EnrollError);
    expect(sent).toEqual([]);
    expect(await readIdentity(o.home.identityPath)).toBeNull();
  });
  test('probe warnings are printed, and the probe gets the config just written (no capabilities block: nax mode)', async () => {
    const o = await opts();
    const seen: RunnerConfig[] = [];
    const { d, lines } = deps({
      probe: (config) => {
        seen.push(config);
        return { probe: async () => ({ capabilities: PROBED, warnings: ['profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED'] }) };
      },
    });
    await enrollRunner(o, d);
    expect(lines).toContain('warning: profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED');
    expect(seen[0]?.capabilities).toBeNull();
  });
});
