import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AgentSession } from '@nathapp/nax-agent';
import type { FleetCommandOut, ThreadAssign } from '@nathapp/fleet-protocol';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { CommandHandler } from '../../src/supervisor/command-handler';
import { RepoMutex } from '../../src/supervisor/repo-mutex';
import { Supervisor } from '../../src/supervisor/supervisor';
import { assignFor } from '../helpers/assign';
import { FakeExecutor } from '../helpers/fake-executor';
import { NO_LOG_SHIPPING } from '../helpers/fake-log-shipping';
import { manualClock } from '../helpers/manual-clock';
import { waitFor } from '../helpers/wait';

const roots: string[] = [];
const supervisors: Supervisor[] = [];
const thread: ThreadAssign = {
  threadId: 'thread-1', action: 'SESSION', feature: 'brainstorm-x', resume: false,
  instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [],
  initialMessage: null,
};
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10_000, threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0,
};

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send() { yield { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never; },
    answer: () => 'accepted', cancel: () => undefined, close: async () => undefined, ...overrides,
  };
}

function setup(options: { withThreads?: boolean; liveSession?: AgentSession; sessionFactory?: () => AgentSession; initialMessage?: ThreadAssign['initialMessage'] } = {}) {
  const time = manualClock(Date.parse('2026-10-01T00:00:00.000Z'));
  const now = (): Date => new Date(time.nowMs());
  const root = join(import.meta.dir, `.supervisor-thread-${crypto.randomUUID()}`);
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const journal = Journal.open(':memory:', now);
  const ex = new FakeExecutor();
  const mutex = new RepoMutex();
  const credentials = { acquire: mock(async () => ({ ok: true as const, credentials: { helper: '/job/git-cred', binDir: null } })), release: mock(async () => undefined) };
  let opened: AgentSession | undefined;
  const host = {
    sessions: { open: async () => { opened = options.sessionFactory?.() ?? options.liveSession ?? session(); return { ok: true as const, session: opened, resumed: false }; } },
    credentials, git: { run: async () => ({ code: 0, stdout: '', stderr: '' }), ok: async () => '' } as never,
    homeDir: join(root, 'home'), workspaceRoot,
    prepareWorktree: async () => ({ ok: true as const, worktree: join(root, 'worktree'), tipSha: 'a'.repeat(40) }),
    ensureSkills: async () => ({ ok: true as const }), skillOrigin: 'file:///fixture',
  };
  const deps = {
    journal, executor: ex, mutex, log: createMemoryLogger(), now, sleep: time.sleep,
    uploader: { upload: async () => ({ kind: 'ok' as const }) },
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, logDrainTimeoutMs: 1_000 },
    readoptHeartbeatMs: 120_000, logs: NO_LOG_SHIPPING,
    ...(options.withThreads === false ? {} : { threads: { host, tuning } }),
  };
  const supervisor = new Supervisor(deps);
  supervisors.push(supervisor);
  const handler = new CommandHandler({ journal, supervisor, workspaceRoot, log: deps.log, now, approvals: { answer: async () => ({ result: 'ok' }) } });
  const addThread = (jobId = 'j1', epoch = 1) => journal.insertJob({
    assign: assignFor('THREAD', { jobId, feature: `thread-${jobId}`, thread: { ...thread, initialMessage: options.initialMessage ?? thread.initialMessage } }),
    leaseEpoch: epoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId),
  }).row;
  return { time, root, workspaceRoot, journal, ex, mutex, credentials, host, supervisor, handler, addThread, get opened() { return opened; } };
}

const assignCommand = (commandId = 'assign-1', jobId = 'j1'): FleetCommandOut => ({
  commandId, type: 'ASSIGN', jobId, leaseEpoch: 1, payload: assignFor('THREAD', { jobId, feature: `thread-${jobId}`, thread }),
});
const cmd = (type: FleetCommandOut['type'], commandId: string, jobId = 'j1', payload: FleetCommandOut['payload'] = {}): FleetCommandOut => ({ commandId, type, jobId, leaseEpoch: 1, payload });
const states = (b: ReturnType<typeof setup>, jobId = 'j1') => b.journal.pendingEvents(jobId, 1, 100).filter((event) => event.type === 'state').map((event) => (event.payload as { to: string; reason?: string }));

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) { supervisor.shutdown(); await supervisor.idle(); }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('US-006 Supervisor and CommandHandler THREAD routing', () => {
  test('US-006 AC-1: THREAD ASSIGN starts the assigned row', async () => {
    const b = setup();
    await b.handler.handle([assignCommand()]);
    await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    expect(b.journal.getJob('j1', 1)?.state).toBe('RUNNING');
    expect(b.ex.calls).toEqual([]);
    await b.supervisor.abandon('j1', 1); await b.supervisor.idle();
  });

  test('US-006 AC-2: THREAD ASSIGN without a thread host fails backend_unavailable', async () => {
    const b = setup({ withThreads: false });
    await b.handler.handle([assignCommand()]);
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'backend_unavailable' }]);
  });

  test('US-006 AC-3: input to a running thread is acknowledged ok', async () => {
    const b = setup(); await b.handler.handle([assignCommand()]);
    await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    expect(await b.handler.handle([cmd('THREAD_INPUT', 'input-1', 'j1', { messageId: 'm2', text: 'next' })])).toMatchObject([{ result: 'ok' }]);
    await b.supervisor.abandon('j1', 1); await b.supervisor.idle();
  });

  test('US-006 AC-4: replayed input command sends its text only once', async () => {
    let sends = 0;
    const s = session({ async *send() { sends += 1; await new Promise<void>(() => undefined); yield undefined as never; } });
    const b = setup({ liveSession: s }); await b.handler.handle([assignCommand()]);
    await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    const input = cmd('THREAD_INPUT', 'same-input', 'j1', { messageId: 'm2', text: 'once' });
    await b.handler.handle([input]); await b.handler.handle([input]);
    expect(sends).toBe(1);
    await b.supervisor.abandon('j1', 1); await b.supervisor.idle();
  });

  test('US-006 AC-5: input for an unassigned job is rejected', async () => {
    const b = setup();
    expect(await b.handler.handle([cmd('THREAD_INPUT', 'ghost-input', 'ghost', { messageId: 'm1', text: 'hi' })])).toEqual([
      { commandId: 'ghost-input', leaseEpoch: 1, result: 'rejected', detail: 'does not hold job' },
    ]);
  });

  test('US-006 AC-6: input after THREAD_CLOSE and idle is rejected', async () => {
    const b = setup(); await b.handler.handle([assignCommand()]);
    await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    await b.handler.handle([cmd('THREAD_CLOSE', 'close-1')]);
    await b.supervisor.idle();
    const inputAck = await b.handler.handle([cmd('THREAD_INPUT', 'after-close', 'j1', { messageId: 'm2', text: 'late' })]);
    expect(inputAck).toEqual([
      { commandId: 'after-close', leaseEpoch: 1, result: 'rejected', detail: 'does not hold job' },
    ]);
  });

  test('US-006 AC-7: CANCEL closes a running thread through UPLOADING to CANCELLED', async () => {
    const b = setup(); await b.handler.handle([assignCommand()]);
    await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    await b.handler.handle([cmd('CANCEL', 'cancel-1')]); await b.supervisor.idle();
    expect(states(b).map((event) => event.to)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(b.ex.calls).toEqual([]);
  });

  test('US-006 AC-8: abandoning a running thread resolves while the repository mutex is held', async () => {
    const b = setup(); const held = await b.mutex.acquire('acme/app');
    const row = b.addThread(); b.journal.updateJob(row.jobId, 1, { state: 'RUNNING' });
    b.supervisor.begin(row, 'prepare');
    const outcome = await Promise.race([b.handler.handle([cmd('ABANDON', 'abandon-1')]).then(() => 'resolved'), Bun.sleep(100).then(() => 'blocked')]);
    held();
    expect(outcome).toBe('resolved');
    await b.supervisor.idle();
  });

  test('US-006 AC-9: abandoning a live thread removes its journal row', async () => {
    const b = setup(); await b.handler.handle([assignCommand()]);
    await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    await b.handler.handle([cmd('ABANDON', 'abandon-2')]);
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.calls).toEqual([]);
    await b.supervisor.idle();
  });

  test('US-006 AC-10: abandon bounds a never-resolving session close by the configured timeout', async () => {
    const close = mock(async () => new Promise<void>(() => undefined));
    const b = setup({ liveSession: session({ close }) });
    await b.handler.handle([assignCommand()]); await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    const abandoning = b.handler.handle([cmd('ABANDON', 'abandon-timeout')]);
    await waitFor(() => close.mock.calls.length === 1);
    await Bun.sleep(0);   // let the abandon park on the close it will not await past the timeout
    b.time.advance(tuning.threadCloseTimeoutMs);
    await abandoning;
    expect(close).toHaveBeenCalledTimes(1);
    expect(b.journal.getJob('j1', 1)).toBeNull();
  });

  test('US-006 AC-11: abandoning a thread releases credentials for its row', async () => {
    const b = setup(); await b.handler.handle([assignCommand()]); await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    const row = b.journal.getJob('j1', 1);
    await b.handler.handle([cmd('ABANDON', 'abandon-release')]);
    expect(b.credentials.release).toHaveBeenCalledWith(row);
  });

  test('US-006 AC-12: an abandoned held turn cannot append later journal events', async () => {
    let releaseTurn: (() => void) | undefined;
    const held = session({ async *send() { await new Promise<void>((resolve) => { releaseTurn = resolve; }); yield { type: 'turn_end', status: 'completed' } as never; } });
    const b = setup({ liveSession: held }); await b.handler.handle([assignCommand()]); await waitFor(() => b.journal.getJob('j1', 1)?.state === 'RUNNING');
    const inputAck = await b.handler.handle([cmd('THREAD_INPUT', 'held-input', 'j1', { messageId: 'm2', text: 'held' })]);
    expect(inputAck).toMatchObject([{ result: 'ok' }]);
    expect(releaseTurn).toBeDefined();
    await b.handler.handle([cmd('ABANDON', 'abandon-held')]); releaseTurn?.(); await b.supervisor.idle();
    expect(b.journal.pendingEvents('j1', 1, 100)).toEqual([]);
  });

  test('US-006 AC-13: abandoning a thread row without an in-memory run does not wait for the repository mutex', async () => {
    const b = setup(); const held = await b.mutex.acquire('acme/app');
    const row = b.addThread('orphan'); b.journal.updateJob(row.jobId, 1, { state: 'RUNNING' });
    const outcome = await Promise.race([b.handler.handle([cmd('ABANDON', 'orphan-abandon', 'orphan')]).then(() => 'resolved'), Bun.sleep(100).then(() => 'blocked')]);
    expect(outcome).toBe('resolved');
    held();
    expect(b.journal.getJob('orphan', 1)).toBeNull();
  });

  test('US-006 AC-14: READOPT of a running thread without its session is rejected with restart detail', async () => {
    const b = setup(); const row = b.addThread(); b.journal.updateJob(row.jobId, 1, { state: 'RUNNING' });
    expect(await b.handler.handle([cmd('READOPT', 'readopt-thread')])).toEqual([
      { commandId: 'readopt-thread', leaseEpoch: 1, result: 'rejected', detail: 'thread session ended by a runner restart' },
    ]);
  });

  test('US-006 AC-15: READOPT of a running thread does not reap, clean or kill through FakeExecutor', async () => {
    const b = setup(); const row = b.addThread(); b.journal.updateJob(row.jobId, 1, { state: 'RUNNING' });
    await b.handler.handle([cmd('READOPT', 'readopt-no-reap')]);
    expect(b.ex.calls).toEqual([]);
    expect(b.ex.killed).toEqual([]);
  });
});
