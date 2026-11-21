import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { AgentSession } from '@nathapp/nax-agent';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';
import { waitFor } from '../helpers/wait';

// Keep the RED state an assertion failure while the implementation module is not present yet.
const threadRunModule = await import('../../src/thread/thread-job-run').catch(() => undefined);
const root = join(import.meta.dir, `.thread-job-run-${crypto.randomUUID()}`);
const homeDir = join(root, 'runner-home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-job-1';
const leaseEpoch = 1;
const helper = '/job/git-cred';
const worktree = join(root, 'prepared-worktree');
const skill = {
  sourceId: 'skill-source-1', owner: 'acme', repo: 'skills', sha: 'a'.repeat(40),
  skills: [{ name: 'spec-writing', dir: 'spec-writing', description: 'writes specs' }],
};
const thread: ThreadAssign = {
  threadId: 'thread-1', action: 'SESSION', feature: 'brainstorm-x', resume: false,
  instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
  skills: [skill], initialMessage: { messageId: 'm1', text: 'hi' },
};
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10_000, threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0,
};

const noOpSession: AgentSession = {
  id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
  async *send() { yield { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never; },
  answer: () => 'accepted', cancel: () => undefined, close: async () => undefined,
};

function setup(overrides: {
  prepareResult?: { ok: true; worktree: string; tipSha: string } | { ok: false; reason: string };
  skillsResult?: { ok: true } | { ok: false; reason: string };
  openResult?: { ok: true; session: AgentSession; resumed: boolean } | { ok: false; reason: string };
  thread?: Partial<ThreadAssign>;
  /** review-1118 US-001: the daemon's test-only clone-URL policy, as a host dep. */
  allowLocalCloneUrls?: boolean;
  /** review-1120 US-004: the fake clock the heartbeat and the idle timer run on. Without it they never fire. */
  clock?: ReturnType<typeof manualClock>;
} = {}) {
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', {
    jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread: { ...thread, ...overrides.thread },
  });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const calls: string[] = [];
  const observations: {
    prepare?: Record<string, unknown>;
    skills?: Record<string, unknown>;
    open?: Record<string, unknown>;
    registered?: Record<string, unknown>;
  } = {};
  const credentials = {
    async acquire() { calls.push('credentials.acquire'); return { ok: true as const, credentials: { helper, binDir: null } }; },
    async release() { calls.push('credentials.release'); },
  };
  const host = {
    sessions: { async open(input: Record<string, unknown>) {
      calls.push('sessions.open'); observations.open = input;
      return overrides.openResult ?? { ok: true as const, session: noOpSession, resumed: false };
    } },
    credentials,
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree(input: Record<string, unknown>) {
      calls.push('prepareWorktree'); observations.prepare = input;
      return overrides.prepareResult ?? { ok: true as const, worktree, tipSha: 'b'.repeat(40) };
    },
    async ensureSkills(input: Record<string, unknown>) {
      calls.push('ensureSkills'); observations.skills = input;
      return overrides.skillsResult ?? { ok: true as const };
    },
    skillOrigin: 'file:///fixture/skills',
    // review-1118 US-001: absent, the field stays off the host, as a production daemon leaves it.
    ...(overrides.allowLocalCloneUrls === undefined ? {} : { allowLocalCloneUrls: overrides.allowLocalCloneUrls }),
  };
  const logs = {
    register(input: Record<string, unknown>) { observations.registered = input; },
    wake() {}, async drain() { return 'drained' as const; }, stopJob() {},
  };
  const deps = {
    journal, log: createMemoryLogger(),
    now: () => new Date(overrides.clock ? overrides.clock.nowMs() : Date.parse('2026-01-01T00:00:00.000Z')),
    sleep: overrides.clock ? overrides.clock.sleep : (async () => undefined),
    mutex: { acquire: async () => () => undefined }, logs,
    host, tuning,
  };
  const makeRun = () => {
    expect(threadRunModule).toBeDefined();
    if (!threadRunModule) throw new Error('ThreadJobRun module is unavailable');
    return new threadRunModule.ThreadJobRun(deps, jobId, leaseEpoch);
  };
  return { journal, calls, observations, makeRun };
}

function stateEvents(journal: Journal): Array<{ to: string; reason?: string }> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => event.payload as { to: string; reason?: string });
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ThreadJobRun preparation (US-003)', () => {
  test('US-003 AC-1: completed initial turn leaves exactly the RUNNING state event', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun();
    const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    // The run removes the stream and recreates it, so a read can miss the file for an instant: "not yet".
    await waitFor(async () => {
      const stream = await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8').catch(() => '');
      return stream.includes('"type":"turn_end"') && stream.includes('"status":"completed"');
    });
    run.halt();
    await starting;
    expect(stateEvents(context.journal).map((event) => event.to)).toEqual(['RUNNING']);
    context.journal.close();
  });

  test('US-006 AC-10: an opened ask-mode session writes the assigned mode to session_started', async () => {
    const context = setup({ thread: { mode: 'ask' } });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun();
    const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    await waitFor(async () => {
      const stream = await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8').catch(() => '');
      return stream.includes('"type":"session_started"') && stream.includes('"mode":"ask"');
    });
    run.halt();
    await starting;
    context.journal.close();
  });

  test('US-003 AC-2: preparation dependencies are invoked in credential-to-session order', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun();
    const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    run.halt(); await starting;
    expect(context.calls).toEqual(['credentials.acquire', 'prepareWorktree', 'credentials.release', 'ensureSkills', 'sessions.open']);
    context.journal.close();
  });

  test('US-003 AC-3: worktree preparation receives the thread feature, ASSIGN ref, and acquired helper', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(context.observations.prepare).toMatchObject({ feature: 'brainstorm-x', baseRef: 'refs/heads/base-for-thread', credentialHelper: helper });
    context.journal.close();
  });

  test('US-003 AC-4: skill setup receives the runner skills directory and assigned sources', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(context.observations.skills).toMatchObject({ skillsRoot: join(homeDir, 'skills'), skills: [skill] });
    context.journal.close();
  });

  test('US-001 AC-14: the host\'s allowLocalCloneUrls reaches the worktree prepare input', async () => {
    const context = setup({ allowLocalCloneUrls: true });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(context.observations.prepare).toMatchObject({ allowLocalCloneUrls: true });
    context.journal.close();
  });

  test('US-001 AC-14: without the host option the prepare input says so, so the clone stays https-only', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(context.observations.prepare).toMatchObject({ allowLocalCloneUrls: false });
    context.journal.close();
  });

  test('US-003 AC-5: the session opens on the prepared worktree with ASSIGN approval timeout', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(context.observations.open).toMatchObject({ worktree, approvalTimeoutSec: 321 });
    context.journal.close();
  });

  test('US-003 AC-6: worktree conflict fails the row with its reason', async () => {
    const context = setup({ prepareResult: { ok: false, reason: 'worktree_conflict' } });
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'FAILED', reason: 'worktree_conflict' }]);
    context.journal.close();
  });

  test('US-003 AC-7: failed worktree preparation releases acquired credentials', async () => {
    const context = setup({ prepareResult: { ok: false, reason: 'worktree_conflict' } });
    await context.makeRun().start('prepare');
    expect(context.calls).toContain('credentials.release');
    context.journal.close();
  });

  test('US-003 AC-8: failed worktree preparation does not open a session', async () => {
    const context = setup({ prepareResult: { ok: false, reason: 'worktree_conflict' } });
    await context.makeRun().start('prepare');
    expect(context.calls).not.toContain('sessions.open');
    context.journal.close();
  });

  test('US-003 AC-9: worktree preparation failure marks the row done before start resolves', async () => {
    const context = setup({ prepareResult: { ok: false, reason: 'worktree_conflict' } });
    await context.makeRun().start('prepare');
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).not.toBeNull();
    context.journal.close();
  });

  test('US-003 AC-10: skill fetch failure is the terminal failure reason', async () => {
    const context = setup({ skillsResult: { ok: false, reason: 'skill_fetch_failed' } });
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'FAILED', reason: 'skill_fetch_failed' }]);
    context.journal.close();
  });

  test('US-003 AC-11: session opening failure is the terminal failure reason', async () => {
    const context = setup({ openResult: { ok: false, reason: 'model_unknown' } });
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'FAILED', reason: 'model_unknown' }]);
    context.journal.close();
  });

  test('US-003 AC-12: registered thread log stream uses the job thread-events path', async () => {
    const context = setup();
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(context.observations.registered).toMatchObject({ threadPath: join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl') });
    context.journal.close();
  });

  test('US-003 AC-13: first persisted thread line records session start and assigned skill SHAs', async () => {
    const context = setup();
    const jobDir = join(workspaceRoot, '.jobs', jobId); await mkdir(jobDir, { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    const first = JSON.parse((await readFile(join(jobDir, 'thread-events.jsonl'), 'utf8')).split('\n')[0] ?? '{}') as Record<string, unknown>;
    expect(first).toMatchObject({ type: 'session_started', skillShas: [skill.sha] });
    context.journal.close();
  });

  test('US-003 AC-14: the initial message text is sent to the session', async () => {
    let sent: string | undefined;
    const session: AgentSession = { ...noOpSession, async *send(message: string) { sent = message; yield { type: 'turn_end', status: 'completed' } as never; } };
    const context = setup({ openResult: { ok: true, session, resumed: false } });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    expect(sent).toBe('hi');
    context.journal.close();
  });

  test('US-003 AC-15: input-consumed is written before the first session event', async () => {
    const context = setup();
    const jobDir = join(workspaceRoot, '.jobs', jobId); await mkdir(jobDir, { recursive: true });
    const run = context.makeRun(); const starting = run.start('prepare');
    // RUNNING precedes async stream creation; wait for the event before stopping the run.
    await waitFor(async () => {
      const file = Bun.file(join(jobDir, 'thread-events.jsonl'));
      return await file.exists() && (await file.text()).includes('"type":"turn_end"');
    });
    run.halt(); await starting;
    const lines = (await readFile(join(jobDir, 'thread-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; messageId?: string });
    const consumed = lines.findIndex((line) => line.type === 'input_consumed' && line.messageId === 'm1');
    const firstSessionEvent = lines.findIndex((line) => !['session_started', 'input_consumed'].includes(line.type));
    expect(consumed).toBeGreaterThanOrEqual(0);
    expect(firstSessionEvent).toBeGreaterThan(consumed);
    context.journal.close();
  });
});

describe('ThreadJobRun stream startup and cancellation (US-004)', () => {
  const jobDir = join(workspaceRoot, '.jobs', jobId);
  const streamPath = join(jobDir, 'thread-events.jsonl');

  async function streamLines(): Promise<Array<{ type: string; reason?: string }>> {
    return (await readFile(streamPath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
  }

  test('US-004 AC-1: a cancel at the RUNNING notification seals the stream with one started and one closed line', async () => {
    const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
    let sent: string | undefined;
    const session: AgentSession = { ...noOpSession, async *send(message: string) { sent = message; yield { type: 'turn_end', status: 'completed' } as never; } };
    const context = setup({ clock, openResult: { ok: true, session, resumed: false } });
    await mkdir(jobDir, { recursive: true });
    const run = context.makeRun();
    // The cancel is delivered at the RUNNING journal notification, while the stream is still being created.
    let streamPending = false;
    let delivered = false;
    context.journal.onWrite(() => {
      if (delivered || context.journal.getJob(jobId, leaseEpoch)?.state !== 'RUNNING') return;
      delivered = true;
      streamPending = !existsSync(streamPath);
      run.requestCancel();
    });
    await run.start('prepare');
    expect(streamPending).toBe(true);
    const lines = await streamLines();
    expect(lines.map((line) => line.type)).toEqual(['session_started', 'session_closed']);
    expect(lines[1]?.reason).toBe('cancelled');
    // The initial message was never consumed: the close landed before the first turn.
    expect(sent).toBeUndefined();
    expect(lines.some((line) => line.type === 'input_consumed')).toBe(false);
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('CANCELLED');
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).not.toBeNull();
    expect(stateEvents(context.journal).map((event) => event.to)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    // Two heartbeat intervals and the idle expiry pass after the run ended: the event count, the final state and
    // the stream are unchanged, exactly as the PROJECT and WORKSPACE runs keep theirs.
    const stamped = context.journal.pendingEvents(jobId, leaseEpoch, 100).length;
    clock.advance(tuning.threadHeartbeatMs * 2 + tuning.threadIdleMs);
    await Bun.sleep(50);
    expect(context.journal.pendingEvents(jobId, leaseEpoch, 100).length).toBe(stamped);
    expect(context.journal.getJob(jobId, leaseEpoch)?.state).toBe('CANCELLED');
    expect(stateEvents(context.journal).map((event) => event.to)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(await streamLines()).toEqual(lines);
    context.journal.close();
  });

  test('US-004 AC-3: a normal session takes its initial input and stamps a heartbeat on schedule', async () => {
    const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
    let sent: string | undefined;
    const session: AgentSession = { ...noOpSession, async *send(message: string) { sent = message; yield { type: 'turn_end', status: 'completed' } as never; } };
    const context = setup({ clock, openResult: { ok: true, session, resumed: false } });
    await mkdir(jobDir, { recursive: true });
    const run = context.makeRun();
    const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    // The initial message reaches the session.
    await waitFor(() => sent === 'hi');
    // The heartbeat stamps the journal on its own schedule.
    clock.advance(tuning.threadHeartbeatMs);
    await waitFor(() => context.journal.pendingEvents(jobId, leaseEpoch, 100)
      .some((event) => event.type === 'snapshot' && typeof (event.payload as { heartbeatAt?: unknown }).heartbeatAt === 'string'));
    // The ordinary close ends the run.
    expect(run.command('THREAD_CLOSE', {}).detail).not.toBe('session_not_ready');
    await starting;
    const stamped = context.journal.pendingEvents(jobId, leaseEpoch, 100).length;
    // Two heartbeat intervals and the idle expiry pass after the run ended: nothing more is written.
    clock.advance(tuning.threadHeartbeatMs * 2 + tuning.threadIdleMs);
    await Bun.sleep(50);
    expect(context.journal.pendingEvents(jobId, leaseEpoch, 100).length).toBe(stamped);
    context.journal.close();
  });
});
