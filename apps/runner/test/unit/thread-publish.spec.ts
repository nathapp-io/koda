import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createGit, type Git } from '../../src/executor/git';
import { RepoMutex } from '../../src/supervisor/repo-mutex';
import { publishThreadDocs } from '../../src/thread/thread-publish';
import { git, isolateGit } from '../helpers/git-fixture';

let root: string;
let repoDir: string;
const identity = { name: 'Thread Writer', email: 'thread@koda.test' };
const mutex = new RepoMutex();
const setupRepo = async () => {
  repoDir = join(root, 'repo');
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, 'init', '-q', '-b', 'main');
  await writeFile(join(repoDir, 'README.md'), 'seed\n');
  await git(repoDir, 'add', 'README.md');
  await git(repoDir, 'commit', '-q', '-m', 'seed');
};
const publish = (overrides: Partial<Parameters<typeof publishThreadDocs>[0]> = {}) => publishThreadDocs({
  git: createGit(), mutex, repoKey: 'r1', worktree: repoDir, feature: 'divide', threadId: 't1',
  title: 'Divide brainstorm', identity, ...overrides,
});
const write = async (path: string, content = 'doc\n') => {
  await mkdir(dirname(join(repoDir, path)), { recursive: true });
  await writeFile(join(repoDir, path), content);
};

beforeEach(async () => {
  isolateGit();
  root = await mkdtemp(join(tmpdir(), 'thread-publish-'));
  await setupRepo();
});
afterEach(async () => rm(root, { recursive: true, force: true }));

test('publishes an allowlisted spec and creates feature ref with titled trailer commit', async () => {
  await write('.nax/features/divide/spec.md');
  const result = await publish();
  expect(result).toMatchObject({ ok: true, paths: ['.nax/features/divide/spec.md'], ignored: [], specPresent: true });
  if (!result.ok) throw new Error('publish failed');
  expect(await git(repoDir, 'rev-parse', 'refs/heads/feat/divide')).toBe(result.sha);
  expect(await git(repoDir, 'show', '-s', '--format=%s', result.sha)).toBe('docs(divide): spec from koda thread "Divide brainstorm"');
  expect((await git(repoDir, 'show', '-s', '--format=%B', result.sha)).trim().split('\n').at(-1)).toBe('Koda-Thread: t1');
});

test('refuses publication results beyond the thread line budget before committing', async () => {
  for (let index = 0; index < 1_500; index += 1) await write(`src/${index}-${'x'.repeat(100)}.ts`);
  await write('docs/a.md');
  const result = await publish();
  expect(result).toMatchObject({ ok: false, reason: 'git_error', detail: 'publication result exceeds thread stream line limit' });
  expect(await git(repoDir, 'rev-parse', 'HEAD')).toBe(await git(repoDir, 'rev-parse', 'main'));
  expect(await git(repoDir, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/divide').then(() => true, () => false)).toBe(false);
});

test('publishes only allowlisted dirty files', async () => {
  await write('docs/a.md');
  await write('src/x.ts');
  const result = await publish();
  expect(result).toMatchObject({ ok: true, paths: ['docs/a.md'], ignored: ['src/x.ts'] });
  if (!result.ok) throw new Error('publish failed');
  expect(await git(repoDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.sha)).toBe('docs/a.md');
});

test('does not include unrelated pre-staged files in the publish commit', async () => {
  await write('docs/a.md');
  await write('src/staged.ts');
  await git(repoDir, 'add', 'src/staged.ts');
  const result = await publish();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('publish failed');
  expect(await git(repoDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.sha)).toBe('docs/a.md');
});

test('advances feat branch when it equals HEAD and refuses a moved branch', async () => {
  const head = await git(repoDir, 'rev-parse', 'HEAD');
  await git(repoDir, 'update-ref', 'refs/heads/feat/divide', head);
  await write('docs/a.md');
  const result = await publish();
  expect(result.ok).toBe(true);
  if (result.ok) expect(await git(repoDir, 'rev-parse', 'refs/heads/feat/divide')).toBe(result.sha);

  const first = await git(repoDir, 'rev-parse', 'HEAD');
  await git(repoDir, 'update-ref', 'refs/heads/feat/divide', first);
  await git(repoDir, 'commit', '--allow-empty', '-q', '-m', 'move');
  const movedTo = await git(repoDir, 'rev-parse', 'refs/heads/feat/divide');
  await write('docs/b.md');
  const refused = await publish();
  expect(refused).toEqual({ ok: false, reason: 'branch_moved' });
  expect(await git(repoDir, 'rev-parse', 'refs/heads/feat/divide')).toBe(movedTo);
  expect(mutex.isLocked('r1')).toBe(false);
});

test('reports git_error when the soft-reset rollback fails after update-ref fails', async () => {
  await write('docs/a.md');
  const real = createGit();
  const failingRollback: Git = {
    async run(args, options) {
      if (args[0] === 'update-ref') return { code: 1, stdout: '', stderr: 'branch compare failed' };
      if (args[0] === 'reset') return { code: 1, stdout: '', stderr: 'rollback failed' };
      return real.run(args, options);
    },
    async ok(args, options) { return real.ok(args, options); },
  };
  const result = await publish({ git: failingRollback });
  expect(result).toEqual({ ok: false, reason: 'git_error', detail: 'rollback failed' });
  expect(mutex.isLocked('r1')).toBe(false);
});

test('does not wait for a held mutex and releases the mutex after success', async () => {
  const release = await mutex.acquire('r1');
  expect(await publish()).toEqual({ ok: false, reason: 'repo_busy' });
  release();
  await write('docs/a.md');
  expect((await publish()).ok).toBe(true);
  expect(mutex.isLocked('r1')).toBe(false);
});

test('rejects missing and nested non-worktree directories', async () => {
  expect(await publish({ worktree: join(root, 'missing') })).toEqual({ ok: false, reason: 'no_worktree' });
  const nested = join(repoDir, 'nested');
  await mkdir(join(nested, '.git'), { recursive: true });
  expect(await publish({ worktree: nested })).toEqual({ ok: false, reason: 'no_worktree' });
});

test('never calls push or fetch', async () => {
  const real = createGit();
  const calls: string[][] = [];
  const recording: Git = {
    async run(args, options) { calls.push([...args]); return real.run(args, options); },
    async ok(args, options) { calls.push([...args]); return real.ok(args, options); },
  };
  await write('docs/a.md');
  expect((await publish({ git: recording })).ok).toBe(true);
  expect(calls.some(([command]) => command === 'push' || command === 'fetch')).toBe(false);
});

test('does not treat symlinks or deleted allowlisted files as publishable', async () => {
  await write('docs/deleted.md');
  await git(repoDir, 'add', 'docs/deleted.md');
  await git(repoDir, 'commit', '-q', '-m', 'add doc');
  await rm(join(repoDir, 'docs/deleted.md'));
  await mkdir(join(repoDir, 'docs'), { recursive: true });
  await symlink('README.md', join(repoDir, 'docs/link.md'));
  const result = await publish();
  expect(result).toMatchObject({ ok: true, paths: [], ignored: ['docs/deleted.md', 'docs/link.md'] });
  expect((await lstat(join(repoDir, 'docs/link.md'))).isSymbolicLink()).toBe(true);
});
