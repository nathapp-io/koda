import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, SessionEvent } from '@nathapp/nax-agent';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';

// US-004 review findings: everything that runs off `start` (the turn's iteration, the heartbeat) reads data the
// runner does not own. A malformed session chunk or a failing journal must not take the job down, must not leave
// the row stuck RUNNING, and must not disable the cost cap.
const jobId = 'thread-hardening-1';
const leaseEpoch = 1;
const roots: string[] = [];
const thread: ThreadAssign = {
  threadId: 'thread-1', action: 'SESSION', feature: 'brainstorm-x', resume: false,
  instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [],
  initialMessage: { messageId: 'm1', text: 'hi' },
};
const completed = { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' };
const usage = (costUsd: unknown): Record<string, unknown> => ({ type: 'usage', costUsd });

function setup(options: {
  send: () => AsyncGenerator<SessionEvent>;
  cancel?: () => void;
  maxCostUsd?: string;
  threadIdleMs?: number;
  threadCloseTimeoutMs?: number;
  hangClose?: boolean;
}) {
  const root = join(import.meta.dir, `.thread-job-run-hardening-${crypto.randomUUID()}`);
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', {
    jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread,
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
  });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  let closeCalls = 0;
  const session: AgentSession = {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    send: () => options.send(),
    answer: () => 'accepted',
    cancel: () => options.cancel?.(),
    close: async () => {
      closeCalls += 1;
      if (options.hangClose) await new Promise<void>(() => undefined);
    },
  };
  const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = {
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
    tuning: {
      threadIdleMs: options.threadIdleMs ?? 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
      threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
      logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: options.threadCloseTimeoutMs ?? 10_000,
      threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0,
    },
  };
  return { journal, clock, jobDir, closeCalls: () => closeCalls, run: new ThreadJobRun(deps, jobId, leaseEpoch) };
}

type Context = ReturnType<typeof setup>;

function stateEvents(journal: Journal): Array<{ to: string; reason?: string }> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => event.payload as { to: string; reason?: string });
}

function snapshots(journal: Journal): Array<Record<string, unknown>> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'snapshot')
    .map((event) => event.payload as Record<string, unknown>);
}

async function streamLines(context: Context): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(context.jobDir, 'thread-events.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 300;
  while (Date.now() <= deadline) {
    if (await condition()) return true;
    await Bun.sleep(10);
  }
  return false;
}

/** Starts the run and waits until its stream file exists — the run is RUNNING and its first turn is under way. */
async function running(context: Context): Promise<{ started: Promise<void> }> {
  await mkdir(context.jobDir, { recursive: true });
  const started = context.run.start('prepare');
  const up = await eventually(async () => {
    try { return (await streamLines(context)).length > 0; } catch { return false; }
  });
  expect(up).toBe(true);
  await Bun.sleep(25);
  return { started };
}

afterAll(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

describe('ThreadJobRun review hardening (US-004)', () => {
  test('a null chunk from the session turn is dropped, not turned into a session_error', async () => {
    const context = setup({ send: async function* () { yield null as never; yield completed as never; } });
    const { started } = await running(context);
    context.clock.advance(60_000);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal)).toEqual([{ to: 'RUNNING' }, { to: 'UPLOADING' }, { to: 'COMPLETED', reason: 'idle' }]);
    await started; context.journal.close();
  });

  test('a usage cost that is not a finite number never disables the cap', async () => {
    const context = setup({
      maxCostUsd: '1.00',
      send: async function* () {
        yield usage(Number.NaN) as never;
        yield usage(undefined) as never;
        yield usage(5) as never;
        yield completed as never;
      },
    });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'cost_cap' });
    await started; context.journal.close();
  });

  test('a negative usage cost never un-counts the spend', async () => {
    const context = setup({
      maxCostUsd: '1.00',
      send: async function* () {
        yield usage(-5) as never;
        yield usage(5) as never;
        yield completed as never;
      },
    });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'cost_cap' });
    await started; context.journal.close();
  });

  test('a throwing session cancel still seals the stream and ends the run', async () => {
    const context = setup({
      maxCostUsd: '1.00',
      cancel: () => { throw new Error('cancel broke'); },
      send: async function* () {
        yield usage(0.6) as never;
        yield usage(0.5) as never;
        yield completed as never;
      },
    });
    const { started } = await running(context);
    expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    expect(stateEvents(context.journal).at(-1)).toEqual({ to: 'COMPLETED', reason: 'cost_cap' });
    expect((await streamLines(context)).at(-1)).toMatchObject({ type: 'session_closed', reason: 'cost_cap' });
    await started; context.journal.close();
  });

  test('a journal that refuses one snapshot does not kill the heartbeat', async () => {
    const context = setup({ threadIdleMs: 600_000, send: async function* () { yield completed as never; } });
    const { started } = await running(context);
    let refused = false;
    const append = context.journal.appendEvent.bind(context.journal);
    context.journal.appendEvent = (...args: Parameters<Journal['appendEvent']>): number | null => {
      if (args[2] === 'snapshot' && !refused) {
        refused = true;
        throw new Error('journal refused the snapshot');
      }
      return append(...args);
    };
    context.clock.advance(30_000);   // the first snapshot is refused
    await Bun.sleep(5);
    context.clock.advance(30_000);   // the heartbeat must still be alive for the next interval
    expect(await eventually(() => snapshots(context.journal).length > 0)).toBe(true);
    expect(snapshots(context.journal)[0]?.heartbeatAt).toEqual(expect.any(String));
    context.run.halt(); await started; context.journal.close();
  });
});

/**
 * Review-1125 finding 9. One `threadCloseTimeoutMs` budget covers settling the cancelled turn AND the session close
 * after it. A turn that is still held when the budget runs out is fenced — the run seals its stream, ends its row
 * and stops its timers without it — and a turn that settles late changes nothing afterwards.
 */
describe('ThreadJobRun close budget (review-1125 US-007)', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  const heldDelta = { type: 'text_delta', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), round: 1, text: 'partial transcript ' };

  /** A turn held inside its transcript finalization: one line out, then it waits for the test's gate. */
  function heldSend(gate: { promise: Promise<void> }, onSettled: () => void) {
    return async function* () {
      yield heldDelta as never;
      await gate.promise;
      onSettled();
      yield completed as never;
    };
  }

  const terminalStates = (journal: Journal): Array<{ to: string; reason?: string }> =>
    stateEvents(journal).filter((event) => event.to !== 'RUNNING');

  test('review-1125 US-007 AC-4: a turn that settles late leaves only the remaining close budget to the close', async () => {
    const gate = deferred();
    let settled = false;
    const context = setup({ threadCloseTimeoutMs: 1_000, hangClose: true, send: heldSend(gate, () => { settled = true; }) });
    const { started } = await running(context);
    try {
      expect(context.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' });
      // The settlement wait takes the first 400 ms of the 1000 ms budget.
      expect(await eventually(() => context.clock.sleepingFor(1_000))).toBe(true);
      context.clock.advance(400);
      gate.resolve();
      expect(await eventually(() => settled)).toBe(true);
      // The close is started, and it waits only the 600 ms that is left — never a fresh 1000 ms.
      expect(await eventually(() => context.closeCalls() === 1)).toBe(true);
      expect(await eventually(() => context.clock.sleepingFor(600))).toBe(true);
      expect(context.clock.sleepingFor(1_000)).toBe(false);
      context.clock.advance(600);
      expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
    } finally {
      gate.resolve();
      context.run.halt();
      await started;
      context.journal.close();
    }
  });

  test('review-1125 US-007 AC-5: a settlement that spends the whole budget still starts session.close once', async () => {
    const gate = deferred();
    let settled = false;
    const context = setup({ threadCloseTimeoutMs: 1_000, hangClose: true, send: heldSend(gate, () => { settled = true; }) });
    const { started } = await running(context);
    try {
      expect(context.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' });
      expect(await eventually(() => context.clock.sleepingFor(1_000))).toBe(true);
      context.clock.advance(1_000);   // the turn is still held, so the settlement spends the whole budget
      expect(await eventually(() => context.closeCalls() === 1)).toBe(true);
      // Zero time left still initiates the close, and the run goes on to seal its stream.
      expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
      expect((await streamLines(context)).at(-1)).toMatchObject({ type: 'session_closed', reason: 'closed' });
      gate.resolve();                 // the turn settles long after the run sealed
      expect(await eventually(() => settled)).toBe(true);
      await Bun.sleep(25);
      expect(context.closeCalls()).toBe(1);
    } finally {
      gate.resolve();
      context.run.halt();
      await started;
      context.journal.close();
    }
  });

  test('review-1125 US-007 AC-7: a late finalizer adds no terminal event to a sealed run', async () => {
    const gate = deferred();
    let settled = false;
    const context = setup({ threadCloseTimeoutMs: 1_000, send: heldSend(gate, () => { settled = true; }) });
    const { started } = await running(context);
    try {
      expect(context.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' });
      expect(await eventually(() => context.clock.sleepingFor(1_000))).toBe(true);
      context.clock.advance(1_000);
      expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
      expect(terminalStates(context.journal).map((event) => event.to)).toEqual(['UPLOADING', 'COMPLETED']);
      gate.resolve();
      expect(await eventually(() => settled)).toBe(true);
      context.clock.advance(120_000);   // past both the idle and the heartbeat deadlines
      await Bun.sleep(25);
      expect(terminalStates(context.journal).map((event) => event.to)).toEqual(['UPLOADING', 'COMPLETED']);
    } finally {
      gate.resolve();
      context.run.halt();
      await started;
      context.journal.close();
    }
  });

  test('review-1125 US-007 AC-8: a late finalizer leaves the journal completion of a sealed run untouched', async () => {
    const gate = deferred();
    let settled = false;
    const context = setup({ threadCloseTimeoutMs: 1_000, send: heldSend(gate, () => { settled = true; }) });
    const { started } = await running(context);
    try {
      expect(context.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' });
      expect(await eventually(() => context.clock.sleepingFor(1_000))).toBe(true);
      context.clock.advance(1_000);
      expect(await eventually(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'COMPLETED')).toBe(true);
      const done = context.journal.getJob(jobId, leaseEpoch)?.doneAt;
      expect(done).not.toBeNull();
      const events = context.journal.pendingEvents(jobId, leaseEpoch, 200).length;
      gate.resolve();
      expect(await eventually(() => settled)).toBe(true);
      context.clock.advance(120_000);
      await Bun.sleep(25);
      const row = context.journal.getJob(jobId, leaseEpoch);
      expect({ state: row?.state, doneAt: row?.doneAt, events: context.journal.pendingEvents(jobId, leaseEpoch, 200).length })
        .toEqual({ state: 'COMPLETED', doneAt: done, events });
    } finally {
      gate.resolve();
      context.run.halt();
      await started;
      context.journal.close();
    }
  });

  test('review-1125 US-007 AC-10: a halt during settlement leaves a recoverable row without a terminal event', async () => {
    const gate = deferred();
    let settled = false;
    const context = setup({ threadCloseTimeoutMs: 1_000, send: heldSend(gate, () => { settled = true; }) });
    const { started } = await running(context);
    try {
      expect(context.run.command('THREAD_CLOSE', {})).toEqual({ result: 'ok' });
      expect(await eventually(() => context.clock.sleepingFor(1_000))).toBe(true);
      context.clock.advance(400);
      context.run.halt();
      // The settlement wait gives up at once instead of outliving the daemon stop.
      expect(await eventually(() => !context.clock.sleepingFor(600))).toBe(true);
      await Bun.sleep(25);
      const row = context.journal.getJob(jobId, leaseEpoch);
      expect({ state: row?.state, doneAt: row?.doneAt }).toEqual({ state: 'RUNNING', doneAt: null });
      expect(terminalStates(context.journal)).toEqual([]);
      expect((await streamLines(context)).some((line) => line.type === 'session_closed' || line.type === 'session_failed')).toBe(false);
      // A finalizer that settles after the halt writes nothing either.
      gate.resolve();
      expect(await eventually(() => settled)).toBe(true);
      await Bun.sleep(25);
      expect(terminalStates(context.journal)).toEqual([]);
    } finally {
      gate.resolve();
      context.run.halt();
      await started;
      context.journal.close();
    }
  });
});
