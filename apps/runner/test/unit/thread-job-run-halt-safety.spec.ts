import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// US-005 adversarial review findings on halt: (1) a session that `open` resolves after the halt is closed
// unawaited — it must never block `start`; (2) a close already in progress writes no stream line once a halt
// lands, even when the halt arrives while the close is waiting out a turn.
const jobId = 'thread-halt-safety-1';
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: {
  send?: (text: string) => AsyncGenerator<SessionEvent>;
  holdOpen?: boolean;
  closeHangs?: boolean;
} = {}) {
  const root = join(import.meta.dir, `.thread-job-run-halt-safety-${crypto.randomUUID()}`);
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  const calls: string[] = [];
  const session: AgentSession = {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send(text: string) {
      calls.push('send');
      if (options.send === undefined) { yield completed; return; }
      yield* options.send(text);
    },
    answer: () => 'accepted',
    cancel: () => { calls.push('cancel'); },
    close: async () => {
      calls.push('close');
      if (options.closeHangs) await new Promise<void>(() => undefined);
    },
  };
  const openGate = deferred();
  const openStarted = deferred();
  const opened = deferred<{ ok: true; session: AgentSession; resumed: false }>();
  // The registrations that are still shipping: a run that leaves one behind ships a stream it no longer owns.
  let active = 0;
  const logCalls: string[] = [];
  const logs = {
    logCalls,
    activeRegistrations: (): number => active,
    register() { logCalls.push('register'); active += 1; },
    wake() {},
    async drain() { return 'drained' as const; },
    stopJob(jobId: string) { logCalls.push('stopJob'); active = Math.max(0, active - 1); },
  };
  const run = new ThreadJobRun({
    journal, log: createMemoryLogger(), now: () => new Date(clock.nowMs()), sleep: clock.sleep,
    mutex: { acquire: async () => () => undefined }, logs,
    host: {
      sessions: {
        async open() {
          if (options.holdOpen) {
            openStarted.resolve();
            await openGate.promise;
            return opened.promise;
          }
          return { ok: true as const, session, resumed: false };
        },
      },
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
  return { journal, jobDir, run, calls, clock, logs, openGate, openStarted: openStarted.promise, opened, session };
}

function stateEvents(journal: Journal): Array<{ to: string; reason?: string }> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => event.payload as { to: string; reason?: string });
}

async function streamLines(context: ReturnType<typeof setup>): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(context.jobDir, 'thread-events.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const running = (context: ReturnType<typeof setup>) => startThreadRun(context, jobId, leaseEpoch);

afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

describe('ThreadJobRun halt review hardening (US-005)', () => {
  test('a halt during a pending open closes the resolved session unawaited, so a hung close never blocks start', async () => {
    const context = setup({ holdOpen: true, closeHangs: true });
    await mkdir(context.jobDir, { recursive: true });
    const started = context.run.start('prepare');
    await context.openStarted;
    expect(context.run.requestCancel()).toBe(true);
    context.run.halt();
    context.openGate.resolve();
    context.opened.resolve({ ok: true, session: context.session, resumed: false });
    // `start` must resolve: the close the halted run left behind is never awaited, so a close that never returns
    // cannot hold the run in the supervisor's map.
    expect(await Promise.race([started.then(() => 'resolved'), Bun.sleep(500).then(() => 'hung')])).toBe('resolved');
    expect(context.calls).toContain('close');
    context.journal.close();
  });

  test('a halt during the close\'s turn wait writes no session_closed line and no transition', async () => {
    const gate = deferred();
    const context = setup({ send: async function* () { await gate.promise; yield completed; } });
    const { started } = await running(context);
    context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' });
    context.run.command('THREAD_CLOSE', {});   // the close cancels the held turn and starts waiting it out
    context.run.halt();                        // the halt lands while that close is in flight
    gate.resolve();
    await started;
    await Bun.sleep(25);                       // let the close's continuations run
    expect((await streamLines(context)).some((line) => line.type === 'session_closed')).toBe(false);
    expect(stateEvents(context.journal).filter((event) => event.to !== 'RUNNING')).toEqual([]);
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).toBeNull();
    context.journal.close();
  });
});

describe('ThreadJobRun stream startup boundaries (US-004)', () => {
  test('US-004 AC-4: a halt while the stream is being created closes the session once and writes nothing after it', async () => {
    const context = setup();
    await mkdir(context.jobDir, { recursive: true });
    let delivered = false;
    // The halt lands at the RUNNING notification, while the stream is still being created.
    context.journal.onWrite(() => {
      if (delivered || context.journal.getJob(jobId, leaseEpoch)?.state !== 'RUNNING') return;
      delivered = true;
      context.run.halt();
    });
    await context.run.start('prepare');
    // The session is closed once, and the run writes no terminal transition.
    expect(context.calls.filter((call) => call === 'close').length).toBe(1);
    expect(stateEvents(context.journal).filter((event) => event.to !== 'RUNNING')).toEqual([]);
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).toBeNull();
    // No log registration is left active: the halted run registers no stream at all.
    expect(context.logs.logCalls.filter((call) => call === 'register')).toEqual([]);
    expect(context.logs.activeRegistrations()).toBe(0);
    // No timer-driven event follows the halt.
    const stamped = context.journal.pendingEvents(jobId, leaseEpoch, 100).length;
    context.clock.advance(tuning.threadHeartbeatMs * 2 + tuning.threadIdleMs);
    await Bun.sleep(50);
    expect(context.journal.pendingEvents(jobId, leaseEpoch, 100).length).toBe(stamped);
    context.journal.close();
  });

  test('US-004 AC-5: a stream that never opens fails the run once, with no CANCELLED of its own', async () => {
    const context = setup();
    // The job directory cannot be created, so the stream setup fails.
    await mkdir(join(context.jobDir, '..'), { recursive: true });
    await writeFile(context.jobDir, 'not a directory');
    let delivered = false;
    // The cancel is pending while the stream setup fails.
    context.journal.onWrite(() => {
      if (delivered || context.journal.getJob(jobId, leaseEpoch)?.state !== 'RUNNING') return;
      delivered = true;
      context.run.requestCancel();
    });
    await context.run.start('prepare');
    expect(stateEvents(context.journal).map((event) => event.to)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(stateEvents(context.journal).filter((event) => event.to === 'CANCELLED')).toEqual([]);
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).not.toBeNull();
    // The session is released and no log registration is left active.
    expect(context.calls.filter((call) => call === 'close').length).toBe(1);
    expect(context.logs.activeRegistrations()).toBe(0);
    expect(context.logs.logCalls).toContain('stopJob');
    // No recurring heartbeat and no unhandled rejection.
    const stamped = context.journal.pendingEvents(jobId, leaseEpoch, 100).length;
    context.clock.advance(tuning.threadHeartbeatMs * 2 + tuning.threadIdleMs);
    await Bun.sleep(50);
    expect(context.journal.pendingEvents(jobId, leaseEpoch, 100).length).toBe(stamped);
    context.journal.close();
  });
});
