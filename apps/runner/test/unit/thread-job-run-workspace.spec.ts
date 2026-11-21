import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { AgentSession } from '@nathapp/nax-agent';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { threadScratchDir } from '../../src/thread/thread-paths';
import { assignFor } from '../helpers/assign';
import { manualClock } from '../helpers/manual-clock';
import { waitFor } from '../helpers/wait';

/**
 * Fleet S5b 1d-1 US-007: a WORKSPACE SESSION is a personal thread with no checkout and no project repositories,
 * so it runs exactly the PROJECT path: no git credentials, no worktree, the thread's scratch directory and the
 * skill tools alone.
 */
const root = join(import.meta.dir, `.thread-job-run-workspace-${crypto.randomUUID()}`);
const homeDir = join(root, 'runner-home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-job-w1';
const threadId = 'thread-w1';
const leaseEpoch = 1;
const skill = {
  sourceId: 'skill-source-1', owner: 'acme', repo: 'skills', sha: 'a'.repeat(40),
  skills: [{ name: 'spec-writing', dir: 'spec-writing', description: 'writes specs' }],
};
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10_000, threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0,
};
const idleSession: AgentSession = {
  id: threadId, backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
  async *send() { yield { type: 'turn_end', sessionId: threadId, turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never; },
  answer: () => 'accepted', cancel: () => undefined, close: async () => undefined,
};

function setup() {
  const thread: ThreadAssign = {
    threadId, action: 'SESSION', kind: 'WORKSPACE', feature: `thread-${threadId}`, resume: false,
    instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
    skills: [skill], initialMessage: { messageId: 'm1', text: 'hi' },
  };
  const journal = Journal.open(':memory:');
  journal.insertJob({ assign: assignFor('THREAD', { jobId, thread }), leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const calls: string[] = [];
  const state: { open?: Record<string, unknown>; streamRegistered?: boolean } = {};
  const host = {
    sessions: { async open(input: Record<string, unknown>) {
      calls.push('sessions.open'); state.open = input;
      return { ok: true as const, session: idleSession, resumed: false };
    } },
    credentials: {
      async acquire() { calls.push('credentials.acquire'); return { ok: true as const, credentials: { helper: '/job/git-cred', binDir: null } }; },
      async release() { calls.push('credentials.release'); },
    },
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { calls.push('prepareWorktree'); return { ok: true as const, worktree: join(root, 'wt'), tipSha: 'b'.repeat(40) }; },
    async ensureSkills() { calls.push('ensureSkills'); return { ok: true as const }; },
  };
  const logs = { register() { state.streamRegistered = true; }, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const clock = manualClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const deps = { journal, log: createMemoryLogger(), now: () => new Date(clock.nowMs()), sleep: clock.sleep, mutex: { acquire: async () => () => undefined }, logs, host, tuning };
  return { journal, calls, state, clock, run: new ThreadJobRun(deps, jobId, leaseEpoch) };
}

function stateEvents(journal: Journal): string[] {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => (event.payload as { to: string }).to);
}

async function running() {
  const context = setup();
  await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
  const starting = context.run.start('prepare');
  // RUNNING is recorded before openStream finishes initializing the command writer.
  await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING' && context.state.streamRegistered === true);
  return { ...context, finish: async () => { context.run.halt(); await starting; context.journal.close(); } };
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ThreadJobRun WORKSPACE session (US-007)', () => {
  test('US-007 AC-5: credentials.acquire is never called', async () => {
    const ctx = await running();
    expect(ctx.calls).not.toContain('credentials.acquire');
    await ctx.finish();
  });

  test('US-007 AC-6: the session opens on the thread scratch directory', async () => {
    const ctx = await running();
    expect(ctx.state.open?.['worktree']).toBe(threadScratchDir(homeDir, threadId));
    await ctx.finish();
  });

  test('US-007 AC-7: the session opens with only the skill tools', async () => {
    const ctx = await running();
    const tools = ctx.state.open?.['tools'] as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(['load_skill', 'read_skill_file']);
    await ctx.finish();
  });

  test('US-007 AC-7b: no worktree is ever prepared for a WORKSPACE run', async () => {
    const ctx = await running();
    expect(ctx.calls).not.toContain('prepareWorktree');
    expect(ctx.calls).toEqual(['ensureSkills', 'sessions.open']);
    await ctx.finish();
  });

  test('US-007 AC-8: THREAD_PUBLISH on a running WORKSPACE run is rejected as not_repo_thread', async () => {
    const ctx = await running();
    expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'rejected', detail: 'not_repo_thread' });
    await ctx.finish();
  });
});

describe('ThreadJobRun WORKSPACE stream startup and cancellation (US-004)', () => {
  test('US-004 AC-2: a cancel at the RUNNING notification seals the workspace stream and leaves no later event', async () => {
    const context = setup();
    const jobDir = join(workspaceRoot, '.jobs', jobId);
    await mkdir(jobDir, { recursive: true });
    let delivered = false;
    context.journal.onWrite(() => {
      if (delivered || context.journal.getJob(jobId, leaseEpoch)?.state !== 'RUNNING') return;
      delivered = true;
      context.run.requestCancel();
    });
    await context.run.start('prepare');
    const lines = (await readFile(join(jobDir, 'thread-events.jsonl'), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
    expect(lines.map((line) => line.type)).toEqual(['session_started', 'session_closed']);
    expect(lines[1]?.reason).toBe('cancelled');
    expect(stateEvents(context.journal)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).not.toBeNull();
    const stamped = context.journal.pendingEvents(jobId, leaseEpoch, 100).length;
    // Two heartbeat intervals and the idle expiry pass after the run ended: nothing more is written.
    context.clock.advance(tuning.threadHeartbeatMs * 2 + tuning.threadIdleMs);
    await Bun.sleep(50);
    expect(context.journal.pendingEvents(jobId, leaseEpoch, 100).length).toBe(stamped);
    expect(stateEvents(context.journal)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    context.journal.close();
  });
});
