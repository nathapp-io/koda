import { afterAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, SessionEvent } from '@nathapp/nax-agent';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun, type ThreadOpenInput, type ThreadPublishResult } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';
import { startThreadRun } from '../helpers/thread-running';

const roots: string[] = [];
const thread: ThreadAssign = {
  threadId: 'thread-1', action: 'SESSION', feature: 'divide', title: 'Divide brainstorm', resume: false,
  instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [], initialMessage: null,
};
const tuning = { threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0, threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000, logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10, threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0 };
const turnEnd = { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function setup(options: { send?: () => AsyncGenerator<SessionEvent>; publish?: (input: Record<string, unknown>) => Promise<ThreadPublishResult>; stale?: boolean; title?: string; noTitle?: boolean } = {}) {
  const root = join(import.meta.dir, `.thread-publish-${crypto.randomUUID()}`); roots.push(root);
  const workspaceRoot = join(root, 'workspace'); const jobDir = join(workspaceRoot, '.jobs', 'thread-publish-1');
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z')); const journal = Journal.open(':memory:');
  const assignedThread: ThreadAssign = options.noTitle ? (({ title: _title, ...rest }) => rest)(thread) : { ...thread, ...(options.title === undefined ? {} : { title: options.title }) };
  const assign = assignFor('THREAD', { jobId: 'thread-publish-1', ref: 'refs/heads/base', approvalTimeoutSec: 30, thread: assignedThread });
  journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir });
  const lines: string[] = []; const logs = { register(job: { threadPath: string }) { lines.push(job.threadPath); }, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const calls: unknown[] = []; const sent: string[] = []; const gate = deferred<void>();
  const session: AgentSession = { id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send(text: string) { sent.push(text); if (options.send) yield* options.send(); else yield turnEnd; },
    answer: () => 'accepted', cancel() {}, async close() {} };
  const host = {
    sessions: { async open(input: ThreadOpenInput) { calls.push(input); return { ok: true as const, session, resumed: false }; } },
    credentials: { async acquire() { return { ok: true as const, credentials: { helper: '/cred', binDir: null } }; }, async release() {} },
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir: join(root, 'home'), workspaceRoot,
    async prepareWorktree() { return { ok: true as const, worktree: join(root, 'worktree'), tipSha: 'a'.repeat(40), stale: options.stale }; },
    async ensureSkills() { return { ok: true as const }; },
    publish: async (input: Record<string, unknown>) => { calls.push(input); await gate.promise; return options.publish ? options.publish(input) : { ok: true as const, sha: 'bbb', paths: ['docs/a.md'], ignored: [], specPresent: false }; },
  };
  const run = new ThreadJobRun({ journal, log: createMemoryLogger(), now: () => new Date(clock.nowMs()), sleep: clock.sleep, mutex: { acquire: async () => () => undefined }, logs, host, tuning }, 'thread-publish-1', 1);
  return { root, jobDir, clock, journal, run, session, host, calls, sent, lines, gate };
}
const started = (ctx: ReturnType<typeof setup>) => startThreadRun(ctx, 'thread-publish-1', 1);
async function stream(ctx: ReturnType<typeof setup>) { const file = ctx.lines[0]; return (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>); }
afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

test('US-006 AC-1: opened tool set includes write_doc', async () => {
  const ctx = setup(); const { started: startedRun } = await started(ctx); const open = ctx.calls[0] as { tools?: readonly { name: string; run(input: unknown): Promise<unknown> }[] };
  expect((open.tools ?? []).map((tool) => tool.name)).toContain('write_doc');
  ctx.run.halt(); await startedRun; ctx.journal.close();
});

test('US-006 AC-2: running write_doc writes and announces docs/a.md', async () => {
  const ctx = setup(); const { started: startedRun } = await started(ctx); const open = ctx.calls[0] as { tools?: readonly { name: string; run(input: unknown): Promise<unknown> }[] };
  const tools = open.tools ?? []; await mkdir(join(ctx.root, 'worktree'), { recursive: true });
  const writerTool = tools.find((tool) => tool.name === 'write_doc');
  expect(writerTool).toBeDefined();
  if (writerTool === undefined) throw new Error('write_doc tool missing');
  const result = await writerTool.run({ path: 'docs/a.md', content: 'hi' });
  expect(result).toMatchObject({ content: 'wrote docs/a.md (2 bytes)' });
  expect(await stream(ctx)).toContainEqual(expect.objectContaining({ type: 'write_doc', path: 'docs/a.md', bytes: 2 }));
  ctx.run.halt(); await startedRun; ctx.journal.close();
});

test('US-006 AC-3, AC-4, AC-5, AC-6: publish acknowledges, passes assignment and writes result', async () => {
  const ctx = setup(); const { started: startedRun } = await started(ctx);
  expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'ok' });
  await Bun.sleep(0);
  expect(ctx.calls.at(-1)).toMatchObject({ worktree: join(ctx.root, 'worktree'), feature: 'divide', threadId: 'thread-1', title: 'Divide brainstorm', repoKey: 'acme/app', identity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' } });
  ctx.gate.resolve(); await Bun.sleep(10);
  expect(await stream(ctx)).toContainEqual(expect.objectContaining({ type: 'published', sha: 'bbb', paths: ['docs/a.md'], ignored: [], specPresent: false }));
  ctx.run.halt(); await startedRun; ctx.journal.close();
});

test('US-006 AC-7, AC-8, AC-9, AC-10, AC-11: failure and publishing contention are handled', async () => {
  const ctx = setup({ publish: async () => ({ ok: false, reason: 'branch_moved' }) }); const { started: startedRun } = await started(ctx);
  expect(ctx.run.command('THREAD_INPUT', { messageId: 'm2', text: 'x' })).toEqual({ result: 'ok' });
  // This turn resolves immediately, so the command below observes the idle session.
  for (let i=0;i<20;i++) await Bun.sleep(2);
  expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'ok' });
  expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'rejected', detail: 'publishing' });
  expect(ctx.run.command('THREAD_INPUT', { messageId: 'm3', text: 'x' })).toEqual({ result: 'rejected', detail: 'publishing' });
  ctx.gate.resolve(); await Bun.sleep(10);
  expect(await stream(ctx)).toContainEqual(expect.objectContaining({ type: 'publish_failed', reason: 'branch_moved' }));
  expect(ctx.run.command('THREAD_INPUT', { messageId: 'm4', text: 'x' })).toEqual({ result: 'ok' });
  ctx.run.halt(); await startedRun; ctx.journal.close();
});

test('US-006 AC-11: synchronous publish throw writes git_error and accepts later input', async () => {
  const ctx = setup({ publish: () => { throw new Error('sync failure'); } }); const { started: startedRun } = await started(ctx);
  expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'ok' });
  ctx.gate.resolve(); await Bun.sleep(10);
  expect(await stream(ctx)).toContainEqual(expect.objectContaining({ type: 'publish_failed', reason: 'git_error' }));
  expect(ctx.run.command('THREAD_INPUT', { messageId: 'm5', text: 'x' })).toEqual({ result: 'ok' });
  ctx.run.halt(); await startedRun; ctx.journal.close();
});

test('US-006 AC-8: publish is rejected while a turn is running', async () => {
  const turn = deferred<void>(); const ctx = setup({ send: async function* () { await turn.promise; yield turnEnd; } }); const { started: startedRun } = await started(ctx);
  expect(ctx.run.command('THREAD_INPUT', { messageId: 'm2', text: 'x' })).toEqual({ result: 'ok' });
  expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'rejected', detail: 'turn_running' });
  turn.resolve(); ctx.run.halt(); await startedRun; ctx.journal.close();
});

test('US-006 AC-12, AC-13: close waits for pending publish and idle does not close during it', async () => {
  const ctx = setup(); const { started: startedRun } = await started(ctx); ctx.run.command('THREAD_PUBLISH', {});
  ctx.clock.advance(tuning.threadIdleMs * 2); await Bun.sleep(10);
  expect(ctx.journal.getJob('thread-publish-1',1)?.state).toBe('RUNNING');
  expect(ctx.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' }); ctx.gate.resolve();
  await startedRun; const got = await stream(ctx); expect(got.findIndex((line) => line.type === 'published')).toBeLessThan(got.findIndex((line) => line.type === 'session_closed'));
  expect(ctx.journal.getJob('thread-publish-1',1)?.state).toBe('COMPLETED'); ctx.journal.close();
});

test('US-006 AC-14, AC-15: stale is announced and idle closes after publish settles', async () => {
  const ctx = setup({ stale: true }); const { started: startedRun } = await started(ctx); expect(await stream(ctx)).toContainEqual(expect.objectContaining({ type: 'session_started', stale: true }));
  ctx.run.command('THREAD_PUBLISH', {}); ctx.gate.resolve(); await Bun.sleep(10); ctx.clock.advance(tuning.threadIdleMs); await startedRun;
  expect(ctx.journal.getJob('thread-publish-1',1)?.state).toBe('COMPLETED');
  expect(ctx.journal.pendingEvents('thread-publish-1',1,100).some((event) => event.type === 'state' && (event.payload as { reason?: string }).reason === 'idle')).toBe(true); ctx.journal.close();
});

test('US-006 AC-5: missing thread title falls back to feature', async () => {
  const ctx = setup({ noTitle: true }); const { started: startedRun } = await started(ctx); ctx.run.command('THREAD_PUBLISH', {});
  await Bun.sleep(0);
  expect(ctx.calls.at(-1)).toMatchObject({ title: 'divide' }); ctx.gate.resolve(); ctx.run.halt(); await startedRun; ctx.journal.close();
});
