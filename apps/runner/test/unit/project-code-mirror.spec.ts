import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectRepoAssign } from '@nathapp/fleet-protocol';
import { createGit, type Git } from '../../src/executor/git';
import { PathError } from '../../src/paths/safe-segment';
import { RepoMutex } from '../../src/supervisor/repo-mutex';
import { git, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

beforeAll(isolateGit);
const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

async function fixture() {
  const store = await import('../../src/thread/project-code/mirror-store');
  const prune = await import('../../src/thread/project-code/mirror-prune');
  const base = await tmp.make('project-code');
  const origin = await makeOrigin(base, 'origin', { files: { 'hello.txt': 'first\n' } });
  const repo: ProjectRepoAssign = { repoId: 'r1', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url };
  const input = { git: createGit(), mutex: new RepoMutex(), homeDir: base, repo, credentialHelper: null, timeoutMs: 5000, nowMs: () => 10000, allowFileProtocol: true, pinId: 'j1' };
  const dir = store.projectCodeDirFor(base, repo.repoId);
  const refresh = (over: Partial<typeof input> = {}) => store.refreshMirror({ ...input, ...over });
  const pruneMirror = (active: string[], nowMs = 11000, ttlMs = 5000, gitAdapter = input.git, mutex = input.mutex) => prune.pruneProjectCode({ homeDir: base, git: gitAdapter, mutex, nowMs, ttlMs, activeJobIds: new Set(active) });
  return { base, origin, repo, input, dir, refresh, pruneMirror, store };
}

test('AC-1: creates a shallow bare mirror at the main tip', async () => {
  const f = await fixture();
  expect(f.dir).toBe(join(f.base, 'project-code', 'r1.git'));
  expect(await f.refresh()).toEqual({ ok: true, sha: await git(f.origin.dir, 'rev-parse', 'main') });
  expect(await git(f.dir, 'rev-parse', '--is-bare-repository')).toBe('true');
  expect(await git(f.dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
});

test('AC-2: fetches a new tip without losing the first blob', async () => {
  const f = await fixture();
  const first = await f.refresh();
  if (!first.ok) throw new Error('refresh failed');
  const sha = await pushCommit(f.base, f.origin.url, 'main', 'hello.txt', 'second\n');
  expect(await f.refresh({ pinId: 'j2' })).toEqual({ ok: true, sha });
  expect(await git(f.dir, 'cat-file', 'blob', `${first.sha}:hello.txt`)).toBe('first');
});

test('AC-3: pins the sha and records the injected current time', async () => {
  const f = await fixture();
  const result = await f.refresh();
  if (!result.ok) throw new Error('refresh failed');
  expect(await git(f.dir, 'rev-parse', 'refs/koda/pins/j1')).toBe(result.sha);
  expect(Number(await readFile(join(f.dir, 'koda-last-used'), 'utf8'))).toBe(10000);
});

test('AC-4: file transport is refused by default', async () => {
  const f = await fixture();
  expect(await f.store.refreshMirror({ ...f.input, allowFileProtocol: undefined })).toEqual({ ok: false, reason: 'fetch failed' });
});

test('AC-5: a nonzero fetch at its timeout returns fetch timeout', async () => {
  const f = await fixture();
  let clock = 0;
  const adapter: Git = { ...f.input.git, run: async (args, options) => {
    if (args.includes('fetch')) { clock = 5000; return { code: 137, stdout: '', stderr: '' }; }
    return f.input.git.run(args, options);
  } };
  expect(await f.refresh({ git: adapter, nowMs: () => clock })).toEqual({ ok: false, reason: 'fetch timeout' });
});

test('AC-6: holds the project-code mutex for every git call, with safe fetch options', async () => {
  const f = await fixture();
  const events: string[] = [];
  const mutex = { acquire: async (key: string) => { events.push(key); return () => { events.push('release'); }; } };
  const adapter: Git = { ...f.input.git, run: async (args, options) => {
    events.push('git');
    if (args.includes('fetch')) {
      expect(args).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'protocol.file.allow=always', 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', f.origin.url, '+refs/heads/main:refs/koda/tip']);
      expect(options).toMatchObject({ cwd: f.dir, env: { GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: 5000, credentialHelper: null });
    }
    return f.input.git.run(args, options);
  } };
  expect((await f.store.refreshMirror({ ...f.input, git: adapter, mutex })).ok).toBe(true);
  expect(events[0]).toBe('project-code:r1');
  expect(events.at(-1)).toBe('release');
  expect(events.filter((e) => e === 'git').length).toBeGreaterThanOrEqual(4);
});

test('AC-7: rejects unsafe repo and pin ids before invoking git', async () => {
  const f = await fixture();
  let calls = 0;
  const adapter: Git = { ...f.input.git, run: async () => { calls++; throw new Error('unexpected git'); } };
  await expect(f.refresh({ git: adapter, repo: { ...f.repo, repoId: '../x' } })).rejects.toBeInstanceOf(PathError);
  await expect(f.refresh({ git: adapter, pinId: '../x' })).rejects.toBeInstanceOf(PathError);
  expect(calls).toBe(0);
});

async function twoPins() {
  const f = await fixture();
  const first = await f.refresh();
  if (!first.ok) throw new Error('refresh failed');
  await pushCommit(f.base, f.origin.url, 'main', 'hello.txt', 'second\n');
  await f.refresh({ pinId: 'j2' });
  return { ...f, first };
}

test('AC-8: gc preserves the older active job pin and blob', async () => {
  const f = await twoPins();
  await f.pruneMirror(['j1']);
  expect(await git(f.dir, 'cat-file', 'blob', `${f.first.sha}:hello.txt`)).toBe('first');
  expect(await git(f.dir, 'for-each-ref', '--format=%(refname)', 'refs/koda/pins/')).toBe('refs/koda/pins/j1');
});

test('AC-9: removes inactive pins and runs gc for a recent mirror', async () => {
  const f = await twoPins();
  const calls: string[][] = [];
  const adapter: Git = { ...f.input.git, run: async (args, options) => { calls.push([...args]); return f.input.git.run(args, options); } };
  await f.pruneMirror([], 11000, 5000, adapter);
  expect(await git(f.dir, 'for-each-ref', '--format=%(refname)', 'refs/koda/pins/')).toBe('');
  expect(calls).toContainEqual(['gc', '--prune=now', '-q']);
  expect(existsSync(f.dir)).toBe(true);
});

test('AC-10: deletes an old mirror with no live pin', async () => {
  const f = await fixture();
  await f.refresh();
  await f.pruneMirror([], 20000);
  expect(existsSync(f.dir)).toBe(false);
});

test('AC-11: retains an old mirror with a live job pin', async () => {
  const f = await fixture();
  await f.refresh();
  await f.pruneMirror(['j1'], 20000);
  expect(await git(f.dir, 'rev-parse', 'refs/koda/pins/j1')).toBe(await git(f.origin.dir, 'rev-parse', 'main'));
});

test('AC-12: prune holds each mirror mutex through its git calls', async () => {
  const f = await fixture();
  await f.refresh();
  await f.refresh({ repo: { ...f.repo, repoId: 'r2' } });
  const events: string[] = [];
  const mutex = new RepoMutex();
  const acquire = mutex.acquire.bind(mutex);
  mutex.acquire = async (key) => { events.push(key); const release = await acquire(key); return () => { events.push('release'); release(); }; };
  const adapter: Git = { ...f.input.git, run: async (args, options) => { events.push('git'); return f.input.git.run(args, options); } };
  await f.pruneMirror(['j1'], 11000, 5000, adapter, mutex);
  expect(events[0]).toMatch(/^project-code:r[12]$/);
  expect(events.at(-1)).toBe('release');
  expect(events.filter((e) => e.startsWith('project-code:')).sort()).toEqual(['project-code:r1', 'project-code:r2']);
  expect(events.filter((e) => e === 'release')).toHaveLength(2);
  expect(events.filter((e) => e === 'git').length).toBeGreaterThan(0);
});

test('missing last-used falls back to directory mtime', async () => {
  const f = await fixture();
  await f.refresh();
  await git(f.dir, 'update-ref', '-d', 'refs/koda/pins/j1');
  await rm(join(f.dir, 'koda-last-used'));
  await utimes(f.dir, new Date(1000), new Date(1000));
  await f.pruneMirror([], 20000);
  expect(existsSync(f.dir)).toBe(false);
});

test('malformed last-used refuses pruning rather than deleting data', async () => {
  const f = await fixture();
  await f.refresh();
  await writeFile(join(f.dir, 'koda-last-used'), 'invalid');
  await expect(f.pruneMirror([], 20000)).rejects.toThrow();
  expect(existsSync(f.dir)).toBe(true);
});
