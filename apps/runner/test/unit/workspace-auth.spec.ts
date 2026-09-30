// apps/runner/test/unit/workspace-auth.spec.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialServer } from '../../src/credentials/cred-server';
import { helperValue } from '../../src/credentials/job-files';
import { createGit, GitError, NO_CREDENTIALS_REASON, reasonFromError } from '../../src/executor/git';
import { commitAndPushPlan } from '../../src/executor/plan-commit';
import { cleanWorkspace, configureRepoHelper, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { startGitHttp } from '../helpers/git-http';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'koda-fleet[bot]', email: 'bot@koda.test' };
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
/** Not `sh()`: it trims, which would drop the leading empty entry. */
const helperList = async (repoDir: string): Promise<string[]> =>
  (await g.ok(['config', '--local', '--get-all', 'credential.helper'], { cwd: repoDir })).split('\n').slice(0, -1);

async function world() {
  const root = await tmp.make('auth');
  await makeOrigin(join(root, 'acme'), 'app', { files: { 'README.md': 'x', '.nax/config.json': '{}' } });
  const http = startGitHttp(root, { username: 'x-access-token', password: () => 'ghs_ws' });
  const cloneUrl = `${http.url}/acme/app.git`;
  const sock = join(root, 'c.sock');
  const server = await CredentialServer.listen(sock, async () => ({
    ok: true, username: 'x-access-token', token: 'ghs_ws', expiresAt: '2099-01-01T00:00:00Z', protocol: 'http', host: new URL(http.url).host,
  }));
  const helper = helperValue([process.execPath, MAIN], sock);
  const repoDir = join(root, 'ws', 'acme', 'app');
  return {
    root, http, cloneUrl, helper, repoDir,
    async close() { await server.close(); http.stop(); },
  };
}

describe('network git through the job helper (D85, D86, D89)', () => {
  test('clone authenticates through the helper and leaves the helper list ["", helper] in the clone', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      expect(await helperList(w.repoDir)).toEqual(['', w.helper]);
      expect(w.http.requests.some((r) => r.authorized && r.path.includes('git-upload-pack'))).toBe(true);
    } finally {
      await w.close();
    }
  });
  test('D89: without a helper the clone fails as `git auth failed`', async () => {
    const w = await world();
    try {
      const error = await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(reasonFromError(error)).toBe(NO_CREDENTIALS_REASON);
      expect(NO_CREDENTIALS_REASON).toBe('git auth failed');
    } finally {
      await w.close();
    }
  });
  test('fetch authenticates with the helper and fails without it', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      await cleanWorkspace(g, w.repoDir, w.helper);
      await expect(cleanWorkspace(g, w.repoDir)).rejects.toBeInstanceOf(GitError);   // the runner's own offline calls clear the helper list
    } finally {
      await w.close();
    }
  });
  test('D85: the clone\'s own config authenticates plain git, and its empty entry silences a global helper that would answer', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      const globalConfig = join(w.root, 'global.gitconfig');
      await writeFile(globalConfig, '[credential]\n\thelper = "!f() { echo username=x-access-token; echo password=wrong; }; f"\n');
      const before = w.http.requests.length;
      const proc = Bun.spawn(['git', 'fetch', 'origin'], { cwd: w.repoDir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig } });
      expect(await proc.exited).toBe(0);
      const during = w.http.requests.slice(before);
      expect(during.some((r) => r.authorized)).toBe(true);
      expect(during.some((r) => r.withAuth && !r.authorized)).toBe(false);   // the wrong password was never sent
    } finally {
      await w.close();
    }
  });
  test('configureRepoHelper replaces any earlier helper entries', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      await sh(w.repoDir, 'config', '--local', '--add', 'credential.helper', '!echo stale');
      await configureRepoHelper(g, w.repoDir, w.helper);
      expect(await helperList(w.repoDir)).toEqual(['', w.helper]);
    } finally {
      await w.close();
    }
  });
  test('the PLAN push authenticates through the helper; without it the reason is `git auth failed` and it is not retried', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      const refSha = await sh(w.repoDir, 'rev-parse', 'HEAD');
      await sh(w.repoDir, 'checkout', '-q', '--detach', refSha);
      const dir = join(w.repoDir, '.nax', 'features', 'f');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'prd.json'), JSON.stringify({ feature: 'f', branchName: 'feat/f', userStories: [{ id: 'US-001' }] }));
      const input = { git: g, repoDir: w.repoDir, jobDir: join(w.root, 'job'), feature: 'f', jobId: 'j1', branchName: 'feat/f', refSha, defaultBranch: 'main', identity, sleep: async () => undefined };
      let pushes = 0;
      const counting = { run: async (args: readonly string[], options: Parameters<typeof g.run>[1]) => { if (args[0] === 'push') pushes += 1; return g.run(args, options); }, ok: g.ok };
      expect(await commitAndPushPlan({ ...input, git: counting })).toEqual({ ok: false, reason: NO_CREDENTIALS_REASON });
      expect(pushes).toBe(1);
      const pushed = await commitAndPushPlan({ ...input, credentialHelper: w.helper });
      expect(pushed).toMatchObject({ ok: true, branch: 'feat/f' });
      expect(await sh(join(w.root, 'acme', 'app.git'), 'rev-parse', 'feat/f')).toBe((pushed as { sha: string }).sha);
    } finally {
      await w.close();
    }
  });
});
