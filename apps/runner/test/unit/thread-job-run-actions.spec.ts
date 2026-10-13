import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import { createGit, type Git } from '../../src/executor/git';
import { RepoMutex } from '../../src/supervisor/repo-mutex';
import { repoDirFor } from '../../src/paths/safe-segment';
import { threadWorktreeDir } from '../../src/thread/thread-paths';
import { git, isolateGit } from '../helpers/git-fixture';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { assignFor } from '../helpers/assign';
import { waitFor } from '../helpers/wait';

const root = join(import.meta.dir, `.thread-action-${crypto.randomUUID()}`);
const homeDir = join(root, 'home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-action-job';
const leaseEpoch = 1;
const tuning = { threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0, threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000, logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10_000 };
const threadBase = { threadId: 'thread-1', feature: 'divide', resume: false, instructions: 'help', backend: { kind: 'native' as const, model: 'minimax/MiniMax-M3' }, skills: [], initialMessage: null };

function setup(action: 'PUBLISH' | 'DISCARD', overrides: { publish?: (input: Record<string, unknown>) => Promise<unknown>; discard?: (input: Record<string, unknown>) => Promise<unknown>; title?: string; git?: Git; mutex?: RepoMutex } = {}) {
  const journal = Journal.open(':memory:');
  const thread: ThreadAssign = { ...threadBase, action, ...(overrides.title === undefined ? {} : { title: overrides.title }) };
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/main', thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const calls: string[] = [];
  const observed: Record<string, unknown> = {};
  const host = {
    sessions: { async open() { calls.push('sessions.open'); throw new Error('should not open'); } },
    credentials: { async acquire() { calls.push('credentials.acquire'); return { ok: true as const, credentials: { helper: 'unused', binDir: null } }; }, async release() {} },
    git: overrides.git ?? { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { calls.push('prepareWorktree'); throw new Error('should not prepare'); },
    async ensureSkills() { calls.push('ensureSkills'); throw new Error('should not fetch skills'); },
    ...(overrides.publish ? { async publish(input: Record<string, unknown>) { observed.publish = input; calls.push('publish'); return overrides.publish?.(input) ?? Promise.resolve({ ok: false, reason: 'unexpected' }); } } : {}),
    ...(overrides.discard ? { async discard(input: Record<string, unknown>) { observed.discard = input; calls.push('discard'); return overrides.discard?.(input) ?? Promise.resolve({ ok: false, reason: 'unexpected' }); } } : {}),
  };
  const logs = { register(input: Record<string, unknown>) { observed.registered = input; }, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = { journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'), sleep: async () => undefined, mutex: overrides.mutex ?? { acquire: async () => () => undefined }, logs, host, tuning };
  return { journal, calls, observed, run: () => import('../../src/thread/thread-job-run').then(({ ThreadJobRun }) => new ThreadJobRun(deps as never, jobId, leaseEpoch)) };
}
const states = (journal: Journal) => journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state').map((event) => event.payload as { to: string; reason?: string });

async function realWorktree(): Promise<{ repoDir: string; worktree: string }> {
  isolateGit();
  const repoDir = repoDirFor(workspaceRoot, 'acme', 'app');
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, 'init', '-q', '-b', 'main');
  await git(repoDir, 'config', 'user.name', 'Thread Fixture');
  await git(repoDir, 'config', 'user.email', 'thread-fixture@example.test');
  await Bun.write(join(repoDir, 'README.md'), 'seed\n');
  await git(repoDir, 'add', 'README.md');
  await git(repoDir, 'commit', '-q', '-m', 'seed');
  const worktree = threadWorktreeDir(homeDir, 'thread-1');
  await mkdir(join(homeDir, 'threads', 'thread-1'), { recursive: true });
  await git(repoDir, 'worktree', 'add', '--detach', worktree, 'HEAD');
  return { repoDir, worktree };
}
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Thread action jobs (US-007)', () => {
  test('PUBLISH performs only the action, streams one result, and transitions through UPLOADING', async () => {
    const ctx = setup('PUBLISH', { title: 'Divide brainstorm', publish: async () => ({ ok: true, sha: 'bbb', paths: ['docs/a.md'], ignored: [], specPresent: true }) });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    expect(ctx.calls).toEqual(['publish']);
    expect(ctx.observed.publish).toMatchObject({ worktree: join(homeDir, 'threads', 'thread-1', 'wt'), feature: 'divide', title: 'Divide brainstorm' });
    const lines = (await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'published', sha: 'bbb', paths: ['docs/a.md'], ignored: [], specPresent: true });
    expect(states(ctx.journal)).toEqual([{ to: 'RUNNING' }, { to: 'UPLOADING' }, { to: 'COMPLETED', reason: 'published' }]);
    ctx.journal.close();
  });

  test('DISCARD calls host with assignment context and emits discarded result', async () => {
    const ctx = setup('DISCARD', { discard: async () => ({ ok: true, tipSha: 'ccc' }) });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    expect(ctx.calls).toEqual(['discard']);
    expect(ctx.observed.discard).toMatchObject({ homeDir, threadId: 'thread-1', feature: 'divide', baseRef: 'refs/heads/main' });
    const line = JSON.parse((await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8')).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ type: 'discarded', tipSha: 'ccc' });
    expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'discarded' });
    ctx.journal.close();
  });

  test('default PUBLISH commits the thread worktree document onto the feature ref (AC-13)', async () => {
    const { worktree } = await realWorktree();
    await mkdir(join(worktree, 'docs'), { recursive: true });
    await Bun.write(join(worktree, 'docs/a.md'), 'thread document\n');
    const ctx = setup('PUBLISH', { git: createGit(), mutex: new RepoMutex(), title: 'Divide brainstorm' });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    const committed = await git(repoDirFor(workspaceRoot, 'acme', 'app'), 'show', 'refs/heads/feat/divide:docs/a.md');
    expect(committed).toBe('thread document');
    expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'published' });
    ctx.journal.close();
  });

  test('default DISCARD removes an untracked document from the thread worktree (AC-14)', async () => {
    const { worktree } = await realWorktree();
    await mkdir(join(worktree, 'docs'), { recursive: true });
    await Bun.write(join(worktree, 'docs/a.md'), 'unpublished\n');
    const ctx = setup('DISCARD', { git: createGit(), mutex: new RepoMutex() });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    expect(await Bun.file(join(worktree, 'docs/a.md')).exists()).toBe(false);
    expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'discarded' });
    ctx.journal.close();
  });

  test('default PUBLISH reports repo_busy immediately while the repo mutex is held (AC-15)', async () => {
    const { worktree } = await realWorktree();
    await mkdir(join(worktree, 'docs'), { recursive: true });
    await Bun.write(join(worktree, 'docs/a.md'), 'thread document\n');
    const mutex = new RepoMutex();
    const release = await mutex.acquire('acme/app');
    const ctx = setup('PUBLISH', { git: createGit(), mutex });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    try {
      await (await ctx.run()).start('prepare');
      expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'publish_failed' });
      const line = JSON.parse((await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8')).trim()) as Record<string, unknown>;
      expect(line).toMatchObject({ type: 'publish_failed', reason: 'repo_busy' });
      expect(mutex.isLocked('acme/app')).toBe(true);
      expect(await git(repoDirFor(workspaceRoot, 'acme', 'app'), 'show-ref', '--verify', 'refs/heads/feat/divide').catch(() => '')).toBe('');
    } finally {
      release();
      ctx.journal.close();
    }
  });

  test('a running publish is not cancelled while its git operation is pending', async () => {
    let resolvePublish!: (value: { ok: true; sha: string; paths: string[]; ignored: string[]; specPresent: boolean }) => void;
    const pending = new Promise<{ ok: true; sha: string; paths: string[]; ignored: string[]; specPresent: boolean }>((resolve) => { resolvePublish = resolve; });
    const ctx = setup('PUBLISH', { publish: async () => pending });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = await ctx.run();
    const starting = run.start('prepare');
    await waitFor(() => ctx.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    expect(run.requestCancel()).toBe(true);
    expect(ctx.journal.getJob(jobId, leaseEpoch)?.state).toBe('RUNNING');
    resolvePublish({ ok: true, sha: 'bbb', paths: [], ignored: [], specPresent: false });
    await starting;
    expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'published' });
    ctx.journal.close();
  });

  test('an oversized successful alternate-host publish completes with publish_failed and one result line', async () => {
    const oversized = { ok: true, sha: 'a'.repeat(64), paths: Array.from({ length: 2_000 }, (_, index) => `docs/${index}-${'x'.repeat(40)}.md`), ignored: [], specPresent: false };
    const ctx = setup('PUBLISH', { publish: async () => oversized });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    const lines = (await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'publish_failed', reason: 'git_error' });
    expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'publish_failed' });
    ctx.journal.close();
  });

  test('a failed action is still completed with its result-line reason', async () => {
    const ctx = setup('PUBLISH', { publish: async () => ({ ok: false, reason: 'repo_busy' }) });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    const line = JSON.parse((await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8')).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ type: 'publish_failed', reason: 'repo_busy' });
    expect(states(ctx.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'publish_failed' });
    ctx.journal.close();
  });

  test('thread commands to action jobs reject with no_session', async () => {
    const ctx = setup('PUBLISH', { publish: async () => ({ ok: false, reason: 'repo_busy' }) });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = await ctx.run();
    const starting = run.start('prepare');
    await waitFor(() => ctx.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    expect(run.command('THREAD_INPUT', { messageId: 'm2', text: 'x' })).toEqual({ result: 'rejected', detail: 'no_session' });
    await starting;
    ctx.journal.close();
  });
});
