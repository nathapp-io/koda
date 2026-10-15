import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  const pruneMirror = (active: string[], nowMs = 11000, ttlMs = 5000, gitAdapter = input.git, mutex = input.mutex, current?: () => ReadonlySet<string>) =>
    prune.pruneProjectCode({ homeDir: base, git: gitAdapter, mutex, nowMs, ttlMs, activeJobIds: new Set(active), ...(current ? { currentActiveJobIds: current } : {}) });
  return { base, origin, repo, input, dir, refresh, pruneMirror, prune, store };
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

test('B4: an operational probe failure never deletes or reinitializes a live mirror', async () => {
  const f = await fixture();
  const first = await f.refresh({ pinId: 'j1' });
  if (!first.ok) throw new Error('refresh failed');
  // What a broken machine (a malformed global git config, an unreadable object store) looks like to the probe: a
  // nonzero exit that says nothing about this mirror. Re-initializing here would throw away the pin j1's session reads.
  const brokenProbe: Git = { ...f.input.git, run: async (args, options) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-bare-repository') {
      return { code: 128, stdout: '', stderr: 'fatal: bad config line 1 in file /home/wk/.gitconfig' };
    }
    return f.input.git.run(args, options);
  } };

  expect(await f.refresh({ git: brokenProbe, pinId: 'j2' })).toEqual({ ok: false, reason: 'fetch failed' });
  expect(existsSync(f.dir)).toBe(true);
  expect(await git(f.dir, 'rev-parse', 'refs/koda/pins/j1')).toBe(first.sha);
  // The prune must not read the same failure as proof that the mirror is junk: it keeps the mirror and its pin, and
  // the failure reaches the daemon's `project code prune failed` warning.
  await expect(f.pruneMirror(['j1'], 11000, 5000, brokenProbe)).rejects.toThrow(/bad config/);
  expect(existsSync(f.dir)).toBe(true);
  expect(await git(f.dir, 'cat-file', 'blob', `${first.sha}:hello.txt`)).toBe('first');
});

test('B4: a real-git probe under a malformed global config preserves the mirror and its pin', async () => {
  const f = await fixture();
  const first = await f.refresh({ pinId: 'j1' });
  if (!first.ok) throw new Error('refresh failed');
  const configPath = join(f.base, 'broken.gitconfig');
  await writeFile(configPath, '[oops\n');
  const savedConfig = process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_GLOBAL'] = configPath;
  try {
    // The probe really fails on this machine, on a healthy mirror, before it can look at the repository at all.
    const probe = await f.input.git.run(['rev-parse', '--is-bare-repository'], { cwd: f.dir });
    expect(probe.code).not.toBe(0);
    expect(probe.stderr).toContain('bad config');
    await expect(f.pruneMirror(['j1'])).rejects.toThrow(/bad config/);
    expect(existsSync(f.dir)).toBe(true);
  } finally {
    process.env['GIT_CONFIG_GLOBAL'] = savedConfig;
  }
  expect(await git(f.dir, 'rev-parse', 'refs/koda/pins/j1')).toBe(first.sha);
  expect(await git(f.dir, 'cat-file', 'blob', `${first.sha}:hello.txt`)).toBe('first');
});

test('B2: a failed initialization leaves no half-made mirror and the next refresh recovers', async () => {
  const f = await fixture();
  let inits = 0;
  const adapter: Git = { ...f.input.git, run: async (args, options) => {
    if (args[0] === 'init') { inits++; return { code: 1, stdout: '', stderr: 'fatal: interrupted' }; }
    return f.input.git.run(args, options);
  } };
  expect(await f.refresh({ git: adapter })).toEqual({ ok: false, reason: 'fetch failed' });
  expect(inits).toBe(1);
  // A directory git never finished initializing must not survive: every later refresh would fetch into it and fail.
  expect(existsSync(f.dir)).toBe(false);
  expect(await f.refresh()).toEqual({ ok: true, sha: await git(f.origin.dir, 'rev-parse', 'main') });
  expect(await git(f.dir, 'rev-parse', '--is-bare-repository')).toBe('true');
});

test('B2: a directory left by an interrupted init is reinitialized instead of poisoning the mirror', async () => {
  const f = await fixture();
  await mkdir(f.dir, { recursive: true });
  await writeFile(join(f.dir, 'HEAD'), 'ref: refs/heads/main\n');   // what a killed `git init --bare` can leave behind
  const result = await f.refresh();
  if (!result.ok) throw new Error('refresh failed');
  expect(result.sha).toBe(await git(f.origin.dir, 'rev-parse', 'main'));
  expect(await git(f.dir, 'rev-parse', '--is-bare-repository')).toBe('true');
  expect(await git(f.dir, 'cat-file', 'blob', `${result.sha}:hello.txt`)).toBe('first');
});

test('B2: prune removes a directory that is not a repository and the next session recreates it', async () => {
  const f = await fixture();
  await mkdir(f.dir, { recursive: true });
  await writeFile(join(f.dir, 'junk'), 'not a git directory\n');
  await f.pruneMirror([]);   // must not throw at for-each-ref, or it blocks every other mirror's prune too
  expect(existsSync(f.dir)).toBe(false);
  expect(await f.refresh()).toEqual({ ok: true, sha: await git(f.origin.dir, 'rev-parse', 'main') });
});

test('B1: a pin created after the snapshot but before the lock keeps its content through gc', async () => {
  const f = await fixture();
  // The session that the daemon's pre-lock snapshot does not know about: it pins the tip of the moment.
  const older = await f.refresh({ pinId: 'j9' });
  if (!older.ok) throw new Error('refresh failed');
  // A later session moves the tip, so only j9's pin keeps the older commit reachable.
  const newer = await pushCommit(f.base, f.origin.url, 'main', 'hello.txt', 'second\n');
  await f.refresh({ pinId: 'j2' });
  expect(newer).not.toBe(older.sha);

  const events: string[] = [];
  const mutex = new RepoMutex();
  const acquire = mutex.acquire.bind(mutex);
  const ordered = { acquire: async (key: string) => { const release = await acquire(key); events.push(`lock:${key}`); return () => { release(); }; } };
  const liveIds = new Set(['j2', 'j9']);   // the journal as it stands now; the snapshot below was taken before j9 existed
  await f.prune.pruneProjectCode({
    homeDir: f.base, git: f.input.git, mutex: ordered, nowMs: 11000, ttlMs: 5000,
    activeJobIds: new Set(['j2']), currentActiveJobIds: () => { events.push('ids'); return liveIds; },
  });

  expect(await git(f.dir, 'cat-file', 'blob', `${older.sha}:hello.txt`)).toBe('first');
  expect(await git(f.dir, 'for-each-ref', '--format=%(refname)', 'refs/koda/pins/')).toBe('refs/koda/pins/j2\nrefs/koda/pins/j9');
  // The live read must happen while the mirror's mutex is held, so no session can pin between it and the deletions.
  expect(events.indexOf('ids')).toBeGreaterThan(events.indexOf('lock:project-code:r1'));
});
