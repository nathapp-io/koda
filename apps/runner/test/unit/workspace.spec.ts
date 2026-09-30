import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../../src/executor/git';
import { assertCloneUrl, cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const g = createGit();

describe('assertCloneUrl', () => {
  test.each(['https://github.com/a/b.git', 'http://127.0.0.1:1234/a/b.git', 'file:///tmp/x.git'])('accepts %s', (u) => expect(() => assertCloneUrl(u)).not.toThrow());
  test.each(['ext::sh -c id', '-oProxyCommand=x', 'git://x/a.git', 'ssh://git@x/a.git', '/local/path', '', 'https://x/a b.git'])('rejects %j', (u) => {
    expect(() => assertCloneUrl(u)).toThrow();
  });
});

describe('ensureClone', () => {
  test('clones once, sets the commit identity, and reuses the clone', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'origin', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'acme', 'app');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('1');
    expect(await sh(repoDir, 'config', 'user.name')).toBe(identity.name);
    expect(await sh(repoDir, 'config', 'user.email')).toBe(identity.email);
    await writeFile(join(repoDir, 'marker'), 'kept');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity: { name: 'other', email: 'o@x' } });
    expect(await readFile(join(repoDir, 'marker'), 'utf8')).toBe('kept');
    expect(await sh(repoDir, 'config', 'user.name')).toBe('other');
  });
  test('repoints origin when the clone url changed (D46)', async () => {
    const base = await tmp.make('ws');
    const a = await makeOrigin(base, 'a', { files: { 'x': '1' } });
    const b = await makeOrigin(base, 'b', { files: { 'x': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: a.url, identity });
    await ensureClone(g, { repoDir, cloneUrl: b.url, identity });
    expect(await sh(repoDir, 'remote', 'get-url', 'origin')).toBe(b.url);
  });
  test('removes a directory that has no .git (a crashed clone) and clones again', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'junk'), 'x');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    expect(await stat(join(repoDir, '.git'))).toBeDefined();
    await expect(stat(join(repoDir, 'junk'))).rejects.toThrow();
  });
  test('a clone that fails surfaces a GitError (unreachable origin)', async () => {
    const base = await tmp.make('ws');
    await expect(ensureClone(g, { repoDir: join(base, 'w', 'r'), cloneUrl: `file://${join(base, 'missing.git')}`, identity })).rejects.toThrow(/git clone failed/);
  });
});

describe('cleanWorkspace (design §2 step 2)', () => {
  test('discards tracked edits and untracked files, keeps ignored files, prunes deleted remote branches', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1', '.gitignore': 'checkpoint.jsonl\n' }, branches: [{ name: 'gone', files: { 'g': '1' } }] });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    await writeFile(join(repoDir, 'a.txt'), 'modified');
    await writeFile(join(repoDir, 'untracked.txt'), 'u');
    await mkdir(join(repoDir, 'nested', 'deep'), { recursive: true });
    await writeFile(join(repoDir, 'nested', 'deep', 'f'), 'f');
    await writeFile(join(repoDir, 'checkpoint.jsonl'), 'resume-me');
    await sh(origin.dir, 'branch', '-D', 'gone');
    await cleanWorkspace(g, repoDir);
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
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    const before = await sh(repoDir, 'rev-parse', 'HEAD');
    const advanced = await pushCommit(base, origin.url, 'main', 'b.txt', '2');
    await cleanWorkspace(g, repoDir);
    expect(await sh(repoDir, 'rev-parse', 'HEAD')).toBe(before);
    expect(await sh(repoDir, 'rev-parse', 'origin/main')).toBe(advanced);
  });
  test('removes stale worktree metadata', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    const wt = join(base, 'stale-worktree-7c1e9a');
    await sh(repoDir, 'worktree', 'add', '-q', '--detach', wt);
    expect(await sh(repoDir, 'worktree', 'list')).toContain('stale-worktree-7c1e9a');
    await rm(wt, { recursive: true, force: true });
    await cleanWorkspace(g, repoDir);
    expect(await sh(repoDir, 'worktree', 'list')).not.toContain('stale-worktree-7c1e9a');
  });
});
