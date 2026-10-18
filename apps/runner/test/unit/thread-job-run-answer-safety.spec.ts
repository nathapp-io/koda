import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, SessionEvent } from '@nathapp/nax-agent';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger, type MemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';
import { startThreadRun } from '../helpers/thread-running';

// US-005 adversarial review finding: nax-agent's `answer` is not a total function — `pending-asks.js` throws an
// `AgentSessionError` for a request id the session never issued (and for a reply of the wrong kind), documented as
// "only a never-issued id or a kind mismatch throws". `command` is awaited inline by the sync loop, so the answer
// must be caught and answered as an outcome rather than thrown.
const jobId = 'thread-answer-safety-1';
const leaseEpoch = 1;
const roots: string[] = [];
const thread: ThreadAssign = {
  threadId: 'thread-1', action: 'SESSION', feature: 'brainstorm-x', resume: false,
  instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [],
  initialMessage: null,
};
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10, threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0,
};
const completed = { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never;

function setup(options: { answer?: AgentSession['answer'] } = {}) {
  const root = join(import.meta.dir, `.thread-job-run-answer-safety-${crypto.randomUUID()}`);
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const journal = Journal.open(':memory:');
  const log: MemoryLogger = createMemoryLogger();
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  const session: AgentSession = {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send() { yield completed; },
    answer: options.answer ?? (() => 'accepted'),
    cancel: () => undefined,
    close: async () => undefined,
  };
  const logs = {
    register() {}, wake() {},
    async drain() { return 'drained' as const; },
    stopJob() {},
  };
  const run = new ThreadJobRun({
    journal, log, now: () => new Date(clock.nowMs()), sleep: clock.sleep,
    mutex: { acquire: async () => () => undefined }, logs,
    host: {
      sessions: { async open() { return { ok: true as const, session, resumed: false }; } },
      credentials: {
        async acquire() { return { ok: true as const, credentials: { helper: '/job/git-cred', binDir: null } }; },
        async release() {},
      },
      git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
      homeDir: join(root, 'runner-home'), workspaceRoot,
      async prepareWorktree() { return { ok: true as const, worktree: join(root, 'prepared-worktree'), tipSha: 'b'.repeat(40) }; },
      async ensureSkills() { return { ok: true as const }; }, skillOrigin: 'file:///fixture/skills',
    },
    tuning,
  }, jobId, leaseEpoch);
  return { journal, jobDir, log, run };
}

const running = (context: ReturnType<typeof setup>) => startThreadRun(context, jobId, leaseEpoch);

afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

describe('ThreadJobRun answer review hardening (US-005)', () => {
  test('a throwing session answer is answered as an outcome, never thrown out of command', async () => {
    const context = setup({ answer: () => { throw new Error('No request "q1" was issued by this session'); } });
    const { started } = await running(context);
    expect(context.run.command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).toEqual({ result: 'rejected', detail: 'unknown' });
    expect(context.log.lines.some((line) => line.level === 'warn' && line.message === 'thread session answer failed')).toBe(true);
    // The refusal is not fatal: the row is still RUNNING and the session may take another turn.
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('RUNNING');
    context.run.halt(); await started; context.journal.close();
  });

  test('an accepted answer is still acknowledged once the guard is in place', async () => {
    const context = setup({ answer: () => 'accepted' });
    const { started } = await running(context);
    expect(context.run.command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).toEqual({ result: 'ok' });
    context.run.halt(); await started; context.journal.close();
  });
});
