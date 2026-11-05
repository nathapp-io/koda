import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncRequest } from '@nathapp/fleet-protocol';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon } from '../../src/daemon/daemon';
import { createMemoryLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import { FakeExecutor } from '../helpers/fake-executor';
import { FakeNaxCli } from '../helpers/fake-nax-cli';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
afterEach(() => tmp.cleanup());

/** A binary-style argv: what `selfCommand()` hands the daemon on a compiled install. */
const SELF = ['/opt/koda/bin/koda-runner'];
const HELPER = [...SELF, 'provider-cred'];

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ ret: 0, data }), { status: 200, headers: { 'content-type': 'application/json' } });

/** The daemon's own fetch seam: /me and /sync answer, so a start needs no listening server; sync bodies are recorded. */
function daemonFetch(syncs: SyncRequest[]): FetchFn {
  return async (url, init) => {
    if (url.endsWith('/me')) return envelope({ id: 'r1', name: 'box', labels: [], capacity: 2, enabled: true });
    if (url.endsWith('/sync')) {
      if (init?.body !== undefined && init.body !== null) syncs.push(JSON.parse(String(init.body)) as SyncRequest);
      return envelope({ jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
    }
    return envelope({ content: 'unexpected', isError: true });
  };
}

/** A nax-mode runner (no capabilities block, so the probe asks nax) whose nax home holds `config`. */
async function runDaemon(socketName: string, config: unknown | null) {
  const base = await tmp.make('vault-wiring');
  const naxHome = join(base, 'naxhome');
  const configPath = join(naxHome, 'config.json');
  await mkdir(naxHome, { recursive: true });
  if (config !== null) await writeFile(configPath, JSON.stringify(config));
  const before = config === null ? null : await readFile(configPath, 'utf8');
  // A unix socket path is capped at 100 bytes, so the daemon gets the shortest temp directory that still fits.
  const socketDir = join(tmpdir(), socketName);
  const runnerConfig = parseRunnerConfig({
    serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(base, 'ws'), naxHome, jobRetentionDays: 1, socketDir,
  }, {});
  const identity = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: runnerConfig.serverUrl, name: 'box', enrolledAt: '2026-10-01T00:00:00.000Z' };
  const syncs: SyncRequest[] = [];
  const daemon = await startDaemon({
    home: resolveHome({}, join(base, 'home')), config: runnerConfig, identity, selfCommand: SELF, log: createMemoryLogger(),
    fetchFn: daemonFetch(syncs), nax: new FakeNaxCli({ version: '0.83.1' }),
    tuning: { syncMinGapMs: 5, statusPollMs: 5, syncTimeoutMs: 2_000, ackPollMs: 5 }, executorFactory: () => new FakeExecutor(),
  });
  try {
    await waitFor(() => syncs.length >= 1);
    return {
      capabilities: syncs[0]?.capabilities,
      /** the probe reads this file; a daemon start must never write it. */
      before,
      after: config === null ? null : await readFile(configPath, 'utf8').catch(() => null),
    };
  } finally {
    await daemon.stop();
    await rm(socketDir, { recursive: true, force: true });
  }
}

describe('provider vault capability wiring (C10 US-010)', () => {
  test("AC-6: the daemon's vaultHelper reports providerVault when config.json names koda's helper", async () => {
    const auth = { source: 'exec', exec: { command: HELPER, timeoutMs: 60_000 }, onChange: 'warn' };
    const { capabilities, before, after } = await runDaemon('kvw1', { agent: { x: 1 }, auth });
    expect(capabilities).toMatchObject({ providerVault: true });
    expect(after).toBe(before);   // the daemon only reads nax's config
  });

  test('AC-7: the daemon omits providerVault when config.json names another helper — and reports it for the same runner when the file names koda\'s', async () => {
    const other = (await runDaemon('kvw2', { auth: { source: 'exec', exec: { command: ['/usr/local/bin/vault-helper'], timeoutMs: 60_000 }, onChange: 'warn' } })).capabilities;
    expect(other).toBeDefined();
    expect(other === undefined ? null : 'providerVault' in other).toBe(false);
    const koda = (await runDaemon('kvw3', { auth: { source: 'exec', exec: { command: HELPER, timeoutMs: 60_000 }, onChange: 'warn' } })).capabilities;
    expect(koda?.providerVault).toBe(true);
  });
});
