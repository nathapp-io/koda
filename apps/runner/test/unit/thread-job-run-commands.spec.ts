import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, SessionEvent } from '@nathapp/nax-agent';
import type { ThreadAssign, ThreadCommandType } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';

const jobId = 'thread-commands-1';
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
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10,
};
const completed = {
  type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1',
  at: new Date(0).toISOString(), status: 'completed',
} as never;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: {
  send?: (text: string) => AsyncGenerator<SessionEvent>;
  answer?: AgentSession['answer'];
  holdDrain?: boolean;
  holdOpen?: boolean;
} = {}) {
  const root = join(import.meta.dir, `.thread-job-run-commands-${crypto.randomUUID()}`);
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  const drainGate = deferred();
  const drainStarted = deferred();
  let drainHeld = options.holdDrain ?? false;
  const logs = {
    register() {}, wake() {},
    async drain() {
      drainStarted.resolve();
      if (drainHeld) await drainGate.promise;
      return 'drained' as const;
    },
    stopJob() {},
    waitDrain: () => drainStarted.promise,
    releaseDrain() { drainHeld = false; drainGate.resolve(); },
  };
  const openGate = deferred<void>();
  const openStarted = deferred<void>();
  const opened = deferred<{ ok: true; session: AgentSession; resumed: false }>();
  const calls: string[] = [];
  const answers: Array<{ requestId: string; answer: { text: string } }> = [];
  const sent: string[] = [];
  const session: AgentSession = {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send(text: string) {
      sent.push(text);
      calls.push('send');
      if (options.send === undefined) { yield completed; return; }
      yield* options.send(text);
    },
    answer: (requestId, answer) => {
      calls.push('answer');
      answers.push({ requestId, answer: answer as { text: string } });
      return options.answer?.(requestId, answer) ?? 'accepted';
    },
    cancel: () => { calls.push('cancel'); },
    close: async () => { calls.push('close'); },
  };
  const host = {
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
  };
  const run = new ThreadJobRun({
    journal, log: createMemoryLogger(), now: () => new Date(clock.nowMs()), sleep: clock.sleep,
    mutex: { acquire: async () => () => undefined }, logs, host, tuning,
  }, jobId, leaseEpoch);
  const context = { journal, clock, logs, session, sent, calls, answers, jobDir, run, openGate, openStarted: openStarted.promise, opened };
  return context;
}

function stateEvents(journal: Journal): Array<{ to: string; reason?: string }> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => event.payload as { to: string; reason?: string });
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    if (await condition()) return true;
    await Bun.sleep(5);
  }
  return false;
}

async function running(context: ReturnType<typeof setup>): Promise<{ started: Promise<void> }> {
  await mkdir(context.jobDir, { recursive: true });
  const started = context.run.start('prepare');
  const ready = await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
  expect(ready).toBe(true);
  await Bun.sleep(10);
  return { started };
}

afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

describe('ThreadJobRun commands and cancellation (US-005)', () => {
  test('US-005 AC-1: THREAD_INPUT sends its text to the session', async () => {
    const context = setup(); const { started } = await running(context);
    expect(context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' })).toEqual({ result: 'ok' });
    expect(await eventually(() => context.sent.includes('next'))).toBe(true);
    context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-2: a second back-to-back input is rejected while the first turn runs', async () => {
    const gate = deferred<void>();
    const context = setup({ send: async function* () { await gate.promise; yield completed; } });
    const { started } = await running(context);
    const first = context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'one' });
    const second = context.run.command('THREAD_INPUT', { messageId: 'm3', text: 'two' });
    expect([first, second]).toEqual([{ result: 'ok' }, { result: 'rejected', detail: 'turn_running' }]);
    gate.resolve(); context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-3: an unsafe input message id is rejected', async () => {
    const context = setup(); const { started } = await running(context);
    expect(context.run.command('THREAD_INPUT', { messageId: '../m', text: 'x' })).toEqual({ result: 'rejected', detail: 'invalid payload' });
    context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-4: input acknowledges while the turn is still delivering events', async () => {
    const gate = deferred<void>();
    const context = setup({ send: async function* () { yield { type: 'thinking_delta', text: 'held' } as SessionEvent; await gate.promise; yield completed; } });
    const { started } = await running(context);
    expect(context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' })).toEqual({ result: 'ok' });
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('RUNNING');
    gate.resolve(); context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-5: THREAD_ANSWER forwards the request id and answer text', async () => {
    const context = setup(); const { started } = await running(context);
    expect(context.run.command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).toEqual({ result: 'ok' });
    expect(context.answers).toEqual([{ requestId: 'q1', answer: { text: 'yes' } }]);
    context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-6: an accepted answer is acknowledged', async () => {
    const context = setup({ answer: () => 'accepted' }); const { started } = await running(context);
    expect(context.run.command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).toEqual({ result: 'ok' });
    context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-7: an expired answer is rejected with its status', async () => {
    const context = setup({ answer: () => 'expired' }); const { started } = await running(context);
    expect(context.run.command('THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).toEqual({ result: 'rejected', detail: 'expired' });
    context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-8: stopping a held turn cancels its session', async () => {
    const gate = deferred<void>();
    const context = setup({ send: async function* () { await gate.promise; yield completed; } });
    const { started } = await running(context);
    context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' });
    expect(context.run.command('THREAD_STOP_TURN', {})).toEqual({ result: 'ok' });
    expect(context.calls).toContain('cancel');
    gate.resolve(); context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-9: stopping a turn leaves the thread RUNNING after the turn ends', async () => {
    const gate = deferred<void>();
    const context = setup({ send: async function* () { await gate.promise; yield completed; } });
    const { started } = await running(context);
    context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' });
    context.run.command('THREAD_STOP_TURN', {}); gate.resolve();
    expect(await eventually(() => context.calls.includes('send') && context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING')).toBe(true);
    context.run.halt(); await started; context.journal.close();
  });

  test('US-005 AC-10: THREAD_CLOSE completes the job with reason closed', async () => {
    const context = setup(); const { started } = await running(context);
    expect(context.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' });
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'closed' });
    await started; context.journal.close();
  });

  test('US-005 AC-11: closing during a turn cancels before closing the session', async () => {
    const gate = deferred<void>();
    const context = setup({ send: async function* () { await gate.promise; yield completed; } });
    const { started } = await running(context);
    context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' });
    context.run.command('THREAD_CLOSE', {});
    gate.resolve();
    expect(await eventually(() => context.calls.includes('close'))).toBe(true);
    expect(context.calls.indexOf('cancel')).toBeLessThan(context.calls.indexOf('close'));
    await started; context.journal.close();
  });

  test('US-005 AC-12: input is rejected while idle close is draining', async () => {
    const context = setup({ holdDrain: true }); const { started } = await running(context);
    context.clock.advance(tuning.threadIdleMs);
    expect(await Promise.race([context.logs.waitDrain().then(() => true), Bun.sleep(500).then(() => false)])).toBe(true);
    expect(context.run.command('THREAD_INPUT', { messageId: 'm2', text: 'next' })).toEqual({ result: 'rejected', detail: 'session_closed' });
    context.logs.releaseDrain(); await started; context.journal.close();
  });

  test('US-005 AC-13: cancel during idle drain does not replace the idle close reason', async () => {
    const context = setup({ holdDrain: true }); const { started } = await running(context);
    context.clock.advance(tuning.threadIdleMs);
    expect(await Promise.race([context.logs.waitDrain().then(() => true), Bun.sleep(500).then(() => false)])).toBe(true);
    expect(context.run.requestCancel()).toBe(true);
    context.logs.releaseDrain(); await started;
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'idle' });
    context.journal.close();
  });

  test('US-005 AC-14: cancel during session open ends before start as CANCELLED', async () => {
    const context = setup({ holdOpen: true });
    await mkdir(context.jobDir, { recursive: true });
    const started = context.run.start('prepare');
    await context.openStarted;
    context.run.requestCancel(); context.openGate.resolve();
    context.opened.resolve({ ok: true, session: context.session, resumed: false });
    await started;
    expect(stateEvents(context.journal)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    context.journal.close();
  });

  test('US-005 AC-15: session returned after a pending open is closed after cancellation', async () => {
    const context = setup({ holdOpen: true });
    await mkdir(context.jobDir, { recursive: true });
    const started = context.run.start('prepare');
    await context.openStarted;
    context.run.requestCancel(); context.openGate.resolve();
    context.opened.resolve({ ok: true, session: context.session, resumed: false });
    await started;
    expect(context.calls).toContain('close');
    context.journal.close();
  });
});
