import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { AgentSession } from '@nathapp/nax-agent';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';

const jobId = 'thread-turns-1';
const leaseEpoch = 1;
const roots: string[] = [];
const thread: ThreadAssign = {
  threadId: 'thread-1', action: 'SESSION', feature: 'brainstorm-x', resume: false,
  instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [],
  initialMessage: { messageId: 'm1', text: 'hi' },
};
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10_000,
};
const completed = { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: {
  send?: (text: string) => AsyncGenerator<unknown>;
  holdDrain?: boolean;
  streamMaxBytes?: number;
  maxCostUsd?: string;
} = {}) {
  const root = join(import.meta.dir, `.thread-job-run-turns-${crypto.randomUUID()}`);
  roots.push(root);
  const homeDir = join(root, 'runner-home');
  const workspaceRoot = join(root, 'workspace');
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const worktree = join(root, 'prepared-worktree');
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', {
    jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread,
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
  });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  let drainHeld = options.holdDrain ?? false;
  const drainGate = deferred();
  const drainStarted = deferred();
  const logs = {
    register() {}, wake() {},
    async drain() {
      drainStarted.resolve();
      if (drainHeld) await drainGate.promise;
      return 'drained' as const;
    },
    stopJob() {},
    holdDrain() { drainHeld = true; },
    waitDrain() { return drainStarted.promise; },
    releaseDrain() { drainHeld = false; drainGate.resolve(); },
  };
  let cancelCalls = 0;
  let closeCalls = 0;
  const session: AgentSession = {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send(text: string) {
      if (options.send === undefined) { yield completed as never; return; }
      yield* options.send(text) as AsyncIterable<never>;
    },
    answer: () => 'accepted', cancel: () => { cancelCalls += 1; },
    close: async () => { closeCalls += 1; },
  };
  const host = {
    sessions: { async open() { return { ok: true as const, session, resumed: false }; } },
    credentials: { async acquire() { return { ok: true as const, credentials: { helper: '/job/git-cred', binDir: null } }; }, async release() {} },
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { return { ok: true as const, worktree, tipSha: 'b'.repeat(40) }; },
    async ensureSkills() { return { ok: true as const }; }, skillOrigin: 'file:///fixture/skills',
  };
  const deps = {
    journal, log: createMemoryLogger(), now: () => new Date(clock.nowMs()), sleep: clock.sleep,
    mutex: { acquire: async () => () => undefined }, logs,
    host,
    tuning: { ...tuning, ...(options.streamMaxBytes === undefined ? {} : { streamMaxBytes: options.streamMaxBytes }) },
  };
  return {
    journal, clock, logs, session, jobDir, cancelCalls: () => cancelCalls, closeCalls: () => closeCalls,
    run: new ThreadJobRun(deps, jobId, leaseEpoch),
  };
}

function stateEvents(journal: Journal): Array<{ to: string; reason?: string }> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => event.payload as { to: string; reason?: string });
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 300;
  while (Date.now() <= deadline) {
    if (await condition()) return true;
    await Bun.sleep(10);
  }
  return false;
}

async function running(context: ReturnType<typeof setup>): Promise<{ started: Promise<void> }> {
  await mkdir(context.jobDir, { recursive: true });
  const started = context.run.start('prepare');
  const streamCreated = await eventually(() => streamLines(context).then(() => true, () => false));
  expect(streamCreated).toBe(true);
  return { started };
}

async function streamLines(context: ReturnType<typeof setup>): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(context.jobDir, 'thread-events.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

describe('ThreadJobRun turns, idle, caps and failure (US-004)', () => {
  test('US-004 AC-1: a completed turn followed by the idle deadline completes with idle reason', async () => {
    const context = setup();
    const { started } = await running(context);
    await Bun.sleep(25);
    context.clock.advance(tuning.threadIdleMs);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal)).toEqual([{ to: 'RUNNING' }, { to: 'UPLOADING' }, { to: 'COMPLETED', reason: 'idle' }]);
    await started; context.journal.close();
  });

  test('US-004 AC-2: idle completion writes session_closed with idle reason as the final stream line', async () => {
    const context = setup();
    const { started } = await running(context);
    await Bun.sleep(25);
    context.clock.advance(tuning.threadIdleMs);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    const lines = await streamLines(context);
    expect(lines.at(-1)).toMatchObject({ type: 'session_closed', reason: 'idle' });
    await started; context.journal.close();
  });

  test('US-004 AC-3: an idle close remains RUNNING until held log drain is released', async () => {
    const context = setup({ holdDrain: true });
    const { started } = await running(context);
    await Bun.sleep(25);
    context.clock.advance(tuning.threadIdleMs);
    const drainStarted = await Promise.race([context.logs.waitDrain().then(() => true), Bun.sleep(300).then(() => false)]);
    const remainedRunning = context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING';
    context.logs.releaseDrain();
    await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED');
    expect(drainStarted && remainedRunning).toBe(true);
    await started; context.journal.close();
  });

  test('US-004 AC-4: the idle deadline does not upload while the current turn is still delivering events', async () => {
    const gate = deferred();
    const context = setup({ send: async function* () { await gate.promise; yield completed; } });
    const { started } = await running(context);
    context.clock.advance(tuning.threadIdleMs);
    await Bun.sleep(20);
    expect(stateEvents(context.journal).map((event) => event.to)).not.toContain('UPLOADING');
    gate.resolve(); context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-5: the heartbeat deadline persists a snapshot with heartbeatAt', async () => {
    const context = setup();
    const { started } = await running(context);
    context.clock.advance(tuning.threadHeartbeatMs);
    expect(await eventually(() => context.journal.pendingEvents(jobId, leaseEpoch, 100).some((event) => event.type === 'snapshot'))).toBe(true);
    const snapshot = context.journal.pendingEvents(jobId, leaseEpoch, 100).find((event) => event.type === 'snapshot');
    expect((snapshot?.payload as { heartbeatAt?: unknown }).heartbeatAt).toEqual(expect.any(String));
    context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-6: a timed_out turn leaves the job RUNNING', async () => {
    const context = setup({ send: async function* () { yield { ...completed, status: 'timed_out' }; } });
    const { started } = await running(context);
    await Bun.sleep(25);
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('RUNNING');
    context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-7: an errored turn does not close its session', async () => {
    const context = setup({ send: async function* () { yield { ...completed, status: 'errored' }; } });
    const { started } = await running(context);
    await Bun.sleep(25);
    expect(context.closeCalls()).toBe(0);
    context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-8: an interrupted turn leaves the job RUNNING', async () => {
    const context = setup({ send: async function* () { yield { ...completed, status: 'interrupted' }; } });
    const { started } = await running(context);
    await Bun.sleep(25);
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('RUNNING');
    context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-9: cumulative usage reaching the assigned budget cancels the session', async () => {
    const context = setup({ maxCostUsd: '1.00', send: async function* () {
      yield { type: 'usage', costUsd: 0.6 };
      yield { type: 'usage', costUsd: 0.5 };
      yield completed;
    } });
    const { started } = await running(context);
    expect(await eventually(() => context.cancelCalls() > 0)).toBe(true);
    expect(context.cancelCalls()).toBeGreaterThan(0);
    context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-10: cumulative usage reaching the assigned budget closes as cost_cap', async () => {
    const context = setup({ maxCostUsd: '1.00', send: async function* () {
      yield { type: 'usage', costUsd: 0.6 };
      yield { type: 'usage', costUsd: 0.5 };
      yield completed;
    } });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'cost_cap' });
    await started; context.journal.close();
  });

  test('US-004 AC-11: turn_end cost is not counted a second time after its usage event', async () => {
    const context = setup({ maxCostUsd: '1.00', send: async function* () {
      yield { type: 'usage', costUsd: 0.6 };
      yield { ...completed, costUsd: 0.6 };
    } });
    const { started } = await running(context);
    await Bun.sleep(25);
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('RUNNING');
    context.run.halt(); await started; context.journal.close();
  });

  test('US-004 AC-12: a session iterator failure transitions through UPLOADING to session_error', async () => {
    const context = setup({ send: async function* () { yield { type: 'thinking_delta', text: 'first event' }; throw new Error('session broke'); } });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'FAILED')).toBe(true);
    expect(stateEvents(context.journal)).toEqual([{ to: 'RUNNING' }, { to: 'UPLOADING' }, { to: 'FAILED', reason: 'session_error' }]);
    await started; context.journal.close();
  });

  test('US-004 AC-13: a session iterator failure writes session_failed as the final stream line', async () => {
    const context = setup({ send: async function* () { yield { type: 'thinking_delta', text: 'first event' }; throw new Error('session broke'); } });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'FAILED')).toBe(true);
    expect((await streamLines(context)).at(-1)).toMatchObject({ type: 'session_failed', reason: 'session_error' });
    await started; context.journal.close();
  });

  test('US-004 AC-14: a large first thinking delta closes the run at the stream cap', async () => {
    const context = setup({ streamMaxBytes: 6_000, send: async function* () {
      yield { type: 'thinking_delta', text: 'x'.repeat(2_000) };
    } });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'stream_cap' });
    await started; context.journal.close();
  });

  test('US-004 AC-15: starting a run replaces a stale thread event stream', async () => {
    const context = setup();
    await mkdir(context.jobDir, { recursive: true });
    await writeFile(join(context.jobDir, 'thread-events.jsonl'), '{"type":"stale"}\n');
    const { started } = await running(context);
    expect(await eventually(async () => (await streamLines(context)).some((line) => line.type === 'session_started'))).toBe(true);
    const lines = await streamLines(context);
    expect(lines.some((line) => line.type === 'stale')).toBe(false);
    context.run.halt(); await started; context.journal.close();
  });
});
