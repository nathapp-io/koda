import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit, type Git, type GitOptions, type GitResult } from '../../src/executor/git';
import { assertCloneUrl, cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { PathError } from '../../src/paths/safe-segment';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const g = createGit();

/** A git that answers success and records what it was asked, so a policy decision can be read off the call. */
interface RecordingGit extends Git { readonly calls: { args: readonly string[]; options: GitOptions }[] }
function recordingGit(): RecordingGit {
  const calls: { args: readonly string[]; options: GitOptions }[] = [];
  const record = (args: readonly string[], options: GitOptions): GitResult => {
    calls.push({ args, options });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run: async (args, options) => record(args, options), ok: async (args, options) => (record(args, options), '') };
}

describe('assertCloneUrl', () => {
  test('accepts an https URL without any option', () => expect(() => assertCloneUrl('https://github.com/a/b.git')).not.toThrow());
  test.each(['http://127.0.0.1:1234/a/b.git', 'file:///tmp/x.git'])('accepts %s only behind the test-only option', (u) => {
    expect(() => assertCloneUrl(u)).toThrow(PathError);
    expect(() => assertCloneUrl(u, { allowLocalCloneUrls: true })).not.toThrow();
  });
  test.each([
    'https://github.com:443/acme/app.git',
    'https://GitHub.com:443/acme/app.git',
    'https://[::1]:443/acme/app.git',
  ])('accepts an explicit HTTPS default port: %s', (url) => {
    expect(() => assertCloneUrl(url)).not.toThrow();
  });
  test.each([
    'https://github.com:/acme/app.git',
    'https://github.com:0443/acme/app.git',
    'https://github.com%3a443/acme/app.git',
    'https://github.com:443\\@evil.test/acme/app.git',
  ])('still rejects an ambiguous authority: %s', (url) => {
    expect(() => assertCloneUrl(url)).toThrow(PathError);
  });
  test('AC-1: a plain-http loopback URL is refused without the option', () => {
    expect(() => assertCloneUrl('http://127.0.0.1:1234/a/b.git')).toThrow(new PathError('invalid cloneUrl'));
  });
  test('AC-2: a file URL is refused without the option', () => {
    expect(() => assertCloneUrl('file:///tmp/x.git')).toThrow(new PathError('invalid cloneUrl'));
  });
  test('AC-3: a file URL is admitted by the test-only option', () => {
    expect(() => assertCloneUrl('file:///tmp/x.git')).toThrow(new PathError('invalid cloneUrl'));
    expect(() => assertCloneUrl('file:///tmp/x.git', { allowLocalCloneUrls: true })).not.toThrow();
  });
  test('AC-4: another transport is refused even with the test-only option', () => {
    expect(() => assertCloneUrl('ssh://host/a.git', { allowLocalCloneUrls: true })).toThrow(new PathError('invalid cloneUrl'));
  });
  test.each(['ext::sh -c id', '-oProxyCommand=x', 'git://x/a.git', 'ssh://git@x/a.git', '/local/path', '', 'https://x/a b.git'])('rejects %j', (u) => {
    expect(() => assertCloneUrl(u)).toThrow();
  });
  test.each(['ext::sh -c id', 'git://x/a.git', 'ssh://git@x/a.git', '/local/path', '', 'file:///a b.git', '-file:///x.git'])('rejects %j even with the option', (u) => {
    expect(() => assertCloneUrl(u, { allowLocalCloneUrls: true })).toThrow(PathError);
  });
  test.each([
    'https:/github.com/a/b.git',                     // one slash: git reads a local path
    'https:github.com:a/b.git',                      // git reads an ssh-style remote on host `https`
    'https:///github.com/a/b.git',                   // empty authority: git and WHATWG disagree on the host
    'https://github.com\\@evil.test/a/b.git',         // WHATWG host github.com; git dials evil.test
    'https://github.com/a/b\\c.git',
  ])('post-review B1: rejects %j, which git would read as another transport or host', (u) => {
    expect(() => assertCloneUrl(u)).toThrow(new PathError('invalid cloneUrl'));
    expect(() => assertCloneUrl(u, { allowLocalCloneUrls: true })).toThrow(new PathError('invalid cloneUrl'));
  });
  test('post-review B1: keeps the canonical https form the API sends', () => {
    for (const u of [
      'https://github.com/acme/app.git',
      'https://gitlab.example.test:8443/group/app.git',
      'https://GitHub.com/acme/app.git',
      'https://gitlab.example.test/group/%E9%A1%B9%E7%9B%AE.git',
      'https://gitlab.example.test/group/项目.git',         // a forge may hand back an unencoded path; only the host is policy
    ]) {
      expect(() => assertCloneUrl(u)).not.toThrow();
    }
  });
});

describe('ensureClone', () => {
  test('AC-6: a file URL without the option rejects before any git call', async () => {
    const git = recordingGit();
    const error = await ensureClone(git, { repoDir: join(await tmp.make('ws'), 'w', 'r'), cloneUrl: 'file:///tmp/x.git', identity }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PathError);
    expect((error as PathError).message).toBe('invalid cloneUrl');
    expect(git.calls).toEqual([]);
  });
  test('AC-7: an https clone for a missing clone carries fileProtocol never', async () => {
    const git = recordingGit();
    const repoDir = join(await tmp.make('ws'), 'w', 'r');
    await ensureClone(git, { repoDir, cloneUrl: 'https://github.com/acme/app.git', identity });
    expect(git.calls.filter(({ args }) => args[0] === 'clone').map(({ args, options }) => [args, options.fileProtocol])).toEqual([
      [['clone', '--', 'https://github.com/acme/app.git', repoDir], 'never'],
    ]);
  });
  test('post-review B1: the clone carries the https-only transport allow-list', async () => {
    const git = recordingGit();
    const repoDir = join(await tmp.make('ws'), 'w', 'r');
    await ensureClone(git, { repoDir, cloneUrl: 'https://github.com/acme/app.git', identity });
    expect(git.calls.filter(({ args }) => args[0] === 'clone').map(({ options }) => options.env)).toEqual([{ GIT_ALLOW_PROTOCOL: 'https' }]);
  });
  test('post-review B1: the clone admits the local transports only with the option', async () => {
    const git = recordingGit();
    const repoDir = join(await tmp.make('ws'), 'w', 'r');
    await ensureClone(git, { repoDir, cloneUrl: 'file:///tmp/x.git', identity, allowLocalCloneUrls: true });
    expect(git.calls.filter(({ args }) => args[0] === 'clone').map(({ options }) => options.env)).toEqual([{ GIT_ALLOW_PROTOCOL: 'http:https:file' }]);
  });
  test('AC-8: with the option a real git leaves a clone of a local origin', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'acme', 'app');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity, allowLocalCloneUrls: true });
    expect((await stat(join(repoDir, '.git'))).isDirectory()).toBe(true);
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('1');
  });
  test('clones once, sets the commit identity, and reuses the clone', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'origin', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'acme', 'app');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity, allowLocalCloneUrls: true });
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('1');
    expect(await sh(repoDir, 'config', 'user.name')).toBe(identity.name);
    expect(await sh(repoDir, 'config', 'user.email')).toBe(identity.email);
    await writeFile(join(repoDir, 'marker'), 'kept');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity: { name: 'other', email: 'o@x' }, allowLocalCloneUrls: true });
    expect(await readFile(join(repoDir, 'marker'), 'utf8')).toBe('kept');
    expect(await sh(repoDir, 'config', 'user.name')).toBe('other');
  });
  test('repoints origin when the clone url changed (D46)', async () => {
    const base = await tmp.make('ws');
    const a = await makeOrigin(base, 'a', { files: { 'x': '1' } });
    const b = await makeOrigin(base, 'b', { files: { 'x': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: a.url, identity, allowLocalCloneUrls: true });
    await ensureClone(g, { repoDir, cloneUrl: b.url, identity, allowLocalCloneUrls: true });
    expect(await sh(repoDir, 'remote', 'get-url', 'origin')).toBe(b.url);
  });
  test('removes a directory that has no .git (a crashed clone) and clones again', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'junk'), 'x');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity, allowLocalCloneUrls: true });
    expect(await stat(join(repoDir, '.git'))).toBeDefined();
    await expect(stat(join(repoDir, 'junk'))).rejects.toThrow();
  });
  test('a clone that fails surfaces a GitError (unreachable origin)', async () => {
    const base = await tmp.make('ws');
    await expect(ensureClone(g, { repoDir: join(base, 'w', 'r'), cloneUrl: `file://${join(base, 'missing.git')}`, identity, allowLocalCloneUrls: true })).rejects.toThrow(/git clone failed/);
  });
});

describe('cleanWorkspace (design §2 step 2)', () => {
  test('AC-9: the fetch carries fileProtocol never', async () => {
    const git = recordingGit();
    await cleanWorkspace(git, '/work/acme/app');
    expect(git.calls.filter(({ args }) => args[0] === 'fetch').map(({ args, options }) => [args, options.fileProtocol])).toEqual([
      [['fetch', '--prune', 'origin'], 'never'],
    ]);
  });
  test('post-review B1: the fetch carries the https-only transport allow-list', async () => {
    const git = recordingGit();
    await cleanWorkspace(git, '/work/acme/app');
    expect(git.calls.filter(({ args }) => args[0] === 'fetch').map(({ options }) => options.env)).toEqual([{ GIT_ALLOW_PROTOCOL: 'https' }]);
  });
  test('with the option the fetch is allowed a local transport', async () => {
    const git = recordingGit();
    await cleanWorkspace(git, '/work/acme/app', null, { allowLocalCloneUrls: true });
    expect(git.calls.filter(({ args }) => args[0] === 'fetch').map(({ options }) => options.fileProtocol)).toEqual(['always']);
  });
  test('discards tracked edits and untracked files, keeps ignored files, prunes deleted remote branches', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1', '.gitignore': 'checkpoint.jsonl\n' }, branches: [{ name: 'gone', files: { 'g': '1' } }] });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity, allowLocalCloneUrls: true });
    await writeFile(join(repoDir, 'a.txt'), 'modified');
    await writeFile(join(repoDir, 'untracked.txt'), 'u');
    await mkdir(join(repoDir, 'nested', 'deep'), { recursive: true });
    await writeFile(join(repoDir, 'nested', 'deep', 'f'), 'f');
    await writeFile(join(repoDir, 'checkpoint.jsonl'), 'resume-me');
    await sh(origin.dir, 'branch', '-D', 'gone');
    await cleanWorkspace(g, repoDir, null, { allowLocalCloneUrls: true });
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('1');
    await expect(stat(join(repoDir, 'untracked.txt'))).rejects.toThrow();
    await expect(stat(join(repoDir, 'nested'))).rejects.toThrow();
    expect(await readFile(join(repoDir, 'checkpoint.jsonl'), 'utf8')).toBe('resume-me');
    expect(await sh(repoDir, 'branch', '-r')).not.toContain('origin/gone');
  });
  test('never moves the checked-out branch (reset --hard HEAD), and picks up new origin commits only as remote refs', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity, allowLocalCloneUrls: true });
    const before = await sh(repoDir, 'rev-parse', 'HEAD');
    const advanced = await pushCommit(base, origin.url, 'main', 'b.txt', '2');
    await cleanWorkspace(g, repoDir, null, { allowLocalCloneUrls: true });
    expect(await sh(repoDir, 'rev-parse', 'HEAD')).toBe(before);
    expect(await sh(repoDir, 'rev-parse', 'origin/main')).toBe(advanced);
  });
  test('removes stale worktree metadata', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity, allowLocalCloneUrls: true });
    const wt = join(base, 'stale-worktree-7c1e9a');
    await sh(repoDir, 'worktree', 'add', '-q', '--detach', wt);
    expect(await sh(repoDir, 'worktree', 'list')).toContain('stale-worktree-7c1e9a');
    await rm(wt, { recursive: true, force: true });
    await cleanWorkspace(g, repoDir, null, { allowLocalCloneUrls: true });
    expect(await sh(repoDir, 'worktree', 'list')).not.toContain('stale-worktree-7c1e9a');
  });
});
