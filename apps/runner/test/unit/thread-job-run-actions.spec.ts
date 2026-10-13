import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
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

function setup(action: 'PUBLISH' | 'DISCARD', overrides: { publish?: (input: Record<string, unknown>) => Promise<unknown>; discard?: (input: Record<string, unknown>) => Promise<unknown> } = {}) {
  const journal = Journal.open(':memory:');
  const thread: ThreadAssign = { ...threadBase, action };
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/main', thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const calls: string[] = [];
  const observed: Record<string, unknown> = {};
  const host = {
    sessions: { async open() { calls.push('sessions.open'); throw new Error('should not open'); } },
    credentials: { async acquire() { calls.push('credentials.acquire'); return { ok: true as const, credentials: { helper: 'unused', binDir: null } }; }, async release() {} },
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { calls.push('prepareWorktree'); throw new Error('should not prepare'); },
    async ensureSkills() { calls.push('ensureSkills'); throw new Error('should not fetch skills'); },
    ...(overrides.publish ? { async publish(input: Record<string, unknown>) { observed.publish = input; calls.push('publish'); return overrides.publish?.(input) ?? Promise.resolve({ ok: false, reason: 'unexpected' }); } } : {}),
    ...(overrides.discard ? { async discard(input: Record<string, unknown>) { observed.discard = input; calls.push('discard'); return overrides.discard?.(input) ?? Promise.resolve({ ok: false, reason: 'unexpected' }); } } : {}),
  };
  const logs = { register(input: Record<string, unknown>) { observed.registered = input; }, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = { journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'), sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning };
  return { journal, calls, observed, run: () => import('../../src/thread/thread-job-run').then(({ ThreadJobRun }) => new ThreadJobRun(deps as never, jobId, leaseEpoch)) };
}
const states = (journal: Journal) => journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state').map((event) => event.payload as { to: string; reason?: string });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Thread action jobs (US-007)', () => {
  test('PUBLISH performs only the action, streams one result, and transitions through UPLOADING', async () => {
    const ctx = setup('PUBLISH', { publish: async () => ({ ok: true, sha: 'bbb', paths: ['docs/a.md'], ignored: [], specPresent: true }) });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    await (await ctx.run()).start('prepare');
    expect(ctx.calls).toEqual(['publish']);
    expect(ctx.observed.publish).toMatchObject({ worktree: join(homeDir, 'threads', 'thread-1', 'wt'), feature: 'divide', title: 'divide' });
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
