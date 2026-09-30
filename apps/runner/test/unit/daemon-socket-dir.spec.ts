import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { SocketDirError } from '../../src/credentials/socket-dir';
import { startDaemon } from '../../src/daemon/daemon';
import type { RunnerIdentityFile } from '../../src/identity/identity-store';
import { createMemoryLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const identity: RunnerIdentityFile = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: 'http://127.0.0.1:9', name: 'n', enrolledAt: '2026-10-01T00:00:00.000Z' };
const capabilities = { nax: { version: '0.0.0-fake', protocols: ['native'] }, sandbox: { available: true }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'] };

describe('the daemon refuses an unsafe socket directory (D78)', () => {
  test.each(['symlink', 'world-readable'])('Review focus 5: a %s socketDir stops the start before the server is called', async (kind) => {
    const base = await tmp.make('dsd');
    const real = join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    let socketDir = real;
    if (kind === 'symlink') {
      socketDir = join(base, 'link');
      await symlink(real, socketDir);
    } else {
      await chmod(real, 0o755);
    }
    const config = parseRunnerConfig({ serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(base, 'ws'), socketDir, capabilities }, {});
    let calls = 0;
    const fetchFn: FetchFn = async () => { calls += 1; throw new TypeError('not reached'); };
    await expect(startDaemon({ home: resolveHome({}, join(base, 'home')), config, identity, fetchFn, log: createMemoryLogger() })).rejects.toThrow(SocketDirError);
    expect(calls).toBe(0);
  });
});
