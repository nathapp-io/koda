import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { CredentialBroker } from '../../src/credentials/broker';
import { requestCredential } from '../../src/credentials/git-credential';
import { socketPathFor } from '../../src/credentials/socket-dir';
import { TokenCache } from '../../src/credentials/token-cache';
import { createGit } from '../../src/executor/git';
import { HostExecutor } from '../../src/executor/host-executor';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { jobDirFor } from '../../src/paths/safe-segment';
import { installFakeGh } from '../helpers/fake-gh';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { startGitHttp } from '../helpers/git-http';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const TOKEN = 'ghs_hostexec';
const PRD = JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'US-001' }] });
const savedPath = process.env['PATH'];
beforeAll(() => { isolateGit(); process.env['FAKE_NAX_STEP_MS'] = '10'; });
afterAll(() => {
  for (const key of ['FAKE_NAX_STEP_MS', 'FAKE_NAX_GH', 'FAKE_NAX_ENV_DUMP', 'FAKE_GH_LOG']) delete process.env[key];
  process.env['PATH'] = savedPath;
  return tmp.cleanup();
});

async function world(command: 'RUN' | 'PLAN' = 'RUN') {
  const base = await tmp.make('hxa');
  const origin = await makeOrigin(join(base, 'remotes', 'acme'), 'app', {
    files: { 'README.md': 'x', 'docs/spec.md': '# spec\n', '.nax/config.json': '{}', '.nax/features/feat/prd.json': PRD },
  });
  const http = startGitHttp(join(base, 'remotes'), { username: 'x-access-token', password: () => TOKEN });
  const socketDir = join(base, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const tokens = new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 });
  const broker = new CredentialBroker({
    tokens, socketDir, runnerId: 'r1', selfCommand: [process.execPath, MAIN], nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms),
    timing: { waitMs: 5_000, serveWaitMs: 5_000, pollMs: 5 },
  });
  const workspaceRoot = join(base, 'ws');
  const assign: AssignPayload = {
    jobId: 'cjob1', command, repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: `${http.url}/acme/app.git` },
    ref: 'main', feature: 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [], maxCostUsd: '5', bashMode: 'raw',
    gitIdentity: { name: 'koda-fleet[bot]', email: 'bot@x' },
  };
  const row = Journal.open(':memory:').insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, assign.jobId) }).row;
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'naxhome') }, git: createGit(), log: createMemoryLogger(),
    nowMs: () => Date.now(), sleep: async () => undefined, credentials: broker,
  });
  const grant = (): void => {
    tokens.want(row.jobId, row.leaseEpoch);
    tokens.apply([{ jobId: row.jobId, leaseEpoch: 1 }], [{ jobId: row.jobId, token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), username: 'x-access-token' }], [], Date.now());
  };
  return { base, origin, http, tokens, broker, row, ex, grant, repoDir: join(workspaceRoot, 'acme', 'app'), sock: socketPathFor(socketDir, 'r1', row.jobId, 1) };
}

describe('HostExecutor with the credential broker (design §3.1)', () => {
  test('RUN end to end over authenticated HTTP: clone through the helper, nax with shims first and no token, finish push and gh through the broker', async () => {
    const w = await world();
    try {
      w.grant();
      expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
      expect((await stat(w.row.jobDir)).mode & 0o777).toBe(0o700);                              // D93
      const fake = await installFakeGh(w.base);
      const dump = join(w.base, 'nax-env.json');
      process.env['PATH'] = `${fake.binDir}${delimiter}${savedPath ?? ''}`;
      Object.assign(process.env, { FAKE_NAX_GH: '1', FAKE_NAX_ENV_DUMP: dump, FAKE_GH_LOG: fake.logPath });
      const handle = await w.ex.spawn(w.row);
      await waitFor(() => !w.ex.isAlive(handle.pid), { timeoutMs: 30_000 });
      const status = JSON.parse(await readFile(join(w.row.jobDir, 'nax-out', 'status.json'), 'utf8'));
      expect(status.postRun.finish).toMatchObject({ result: 'opened', url: 'https://example.test/koda/pull/7' });
      const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
      expect(env['PATH'].split(delimiter)[0]).toBe(join(w.row.jobDir, 'bin'));                  // D88
      expect(JSON.stringify(env)).not.toContain(TOKEN);                                          // no token in nax's environment
      const gh = JSON.parse((await readFile(fake.logPath, 'utf8')).trim().split('\n').at(-1) ?? '{}');
      expect(gh).toMatchObject({ ghToken: TOKEN, argv: expect.arrayContaining(['pr', 'create', '--head', 'feat/feat']) });
      expect(await sh(w.origin.dir, 'rev-parse', 'feat/feat')).toBe(await sh(w.repoDir, 'rev-parse', 'HEAD'));
      expect(w.http.requests.some((r) => r.authorized && r.path.includes('git-receive-pack'))).toBe(true);
      await w.ex.cleanup(w.row);
      expect(await requestCredential(w.sock)).toEqual({ ok: false, reason: 'unavailable' });   // D90
    } finally {
      await w.broker.closeAll();
      w.http.stop();
    }
  });
  test('D82: a token error ends prepare with `git token: <reason>` before anything is cloned', async () => {
    const w = await world();
    try {
      w.tokens.want(w.row.jobId, 1);
      w.tokens.apply([{ jobId: w.row.jobId, leaseEpoch: 1 }], [], [{ jobId: w.row.jobId, reason: 'app_permissions_insufficient' }], Date.now());
      expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'git token: app_permissions_insufficient' });
      await expect(stat(w.repoDir)).rejects.toThrow();
    } finally {
      await w.broker.closeAll();
      w.http.stop();
    }
  });
  test('PLAN: the plan commit is pushed through the helper', async () => {
    const w = await world('PLAN');
    try {
      w.grant();
      expect((await w.ex.prepare(w.row)).ok).toBe(true);
      const handle = await w.ex.spawn(w.row);
      await waitFor(() => !w.ex.isAlive(handle.pid), { timeoutMs: 30_000 });
      const pushed = await w.ex.finishPlan(w.row);
      expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
      expect(await sh(w.origin.dir, 'log', '-1', '--format=%s', 'feat/feat')).toBe('chore(plan): feat PRD via koda job cjob1');
    } finally {
      await w.broker.closeAll();
      w.http.stop();
    }
  });
});
