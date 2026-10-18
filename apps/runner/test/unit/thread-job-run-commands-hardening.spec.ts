import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, SessionEvent } from '@nathapp/nax-agent';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';
import { startThreadRun } from '../helpers/thread-running';

// US-005 adversarial review findings: the window between the RUNNING transition and the open stream (a command
// there must be refused, never acked and dropped), and the synchronous command path that must never throw because
// `CommandHandler.handle` is awaited inline by the sync loop.
const jobId = 'thread-commands-hardening-1';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: { send?: (text: string) => AsyncGenerator<SessionEvent>; cancel?: () => void } = {}) {
  const root = join(import.meta.dir, `.thread-job-run-commands-hardening-${crypto.randomUUID()}`);
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  const sent: string[] = [];
  const calls: string[] = [];
  const session: AgentSession = {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send(text: string) {
      sent.push(text);
      calls.push('send');
      if (options.send === undefined) { yield completed; return; }
      yield* options.send(text);
    },
    answer: () => 'accepted',
    cancel: () => { calls.push('cancel'); options.cancel?.(); },
    close: async () => { calls.push('close'); },
  };
  const logs = {
    register() {}, wake() {},
    async drain() { return 'drained' as const; },
    stopJob() {},
  };
  const run = new ThreadJobRun({
    journal, log: createMemoryLogger(), now: () => new Date(clock.nowMs()), sleep: clock.sleep,
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
  return { journal, jobDir, run, sent, calls };
}

async function eventually(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    if (condition()) return true;
    await Bun.sleep(5);
  }
  return false;
}

const running = (context: ReturnType<typeof setup>) => startThreadRun(context, jobId, leaseEpoch);

afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

describe('ThreadJobRun commands review hardening (US-005)', () => {
  test('an input in the RUNNING-before-openStream window is refused, never acked and dropped', async () => {
    const context = setup();
    // The row is RUNNING (the transition has happened) while the run's stream is not open yet: `start` has not
    // reached the step that assigns the writer. An input here could not be streamed, so it must not be acked `ok`.
    context.journal.updateJob(jobId, leaseEpoch, { state: 'RUNNING' });
    expect(context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' })).toEqual({ result: 'rejected', detail: 'session_not_ready' });
    expect(context.sent).toEqual([]);
    context.journal.close();
  });

  test('the same input is accepted once the run reached RUNNING with its stream open', async () => {
    const context = setup();
    const { started } = await running(context);
    expect(context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' })).toEqual({ result: 'ok' });
    expect(await eventually(() => context.sent.includes('next'))).toBe(true);
    context.run.halt(); await started; context.journal.close();
  });

  test('a throwing session cancel does not escape the synchronous command path', async () => {
    const gate = deferred();
    const context = setup({
      send: async function* () { await gate.promise; yield completed; },
      cancel: () => { throw new Error('cancel broke'); },
    });
    const { started } = await running(context);
    context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' });
    expect(context.run.command('THREAD_STOP_TURN', {})).toEqual({ result: 'ok' });
    expect(context.calls).toContain('cancel');
    gate.resolve(); context.run.halt(); await started; context.journal.close();
  });
});
