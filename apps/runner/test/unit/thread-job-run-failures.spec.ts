import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession } from '@nathapp/nax-agent';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { THREAD_EVENTS_FILE, ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { waitFor } from '../helpers/wait';

// US-003's start steps share their rules without a dedicated acceptance criterion: these are the failure and
// halt paths around the credential hold and the stream's directory.
const root = join(import.meta.dir, `.thread-job-run-failures-${crypto.randomUUID()}`);
const homeDir = join(root, 'runner-home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-job-fail-1';
const leaseEpoch = 1;
const jobDir = join(workspaceRoot, '.jobs', jobId);
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

function sessionStub(onClose: () => void): AgentSession {
  return {
    id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
    async *send() { yield { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never; },
    answer: () => 'accepted', cancel: () => undefined, close: async () => { onClose(); },
  };
}

interface Overrides {
  acquireResult?: { ok: true; credentials: { helper: string | null; binDir: string | null } } | { ok: false; reason: string; cancelled?: true };
  prepareResult?: { ok: true; worktree: string; tipSha: string } | { ok: false; reason: string };
  releaseThrows?: boolean;
}

function setup(overrides: Overrides = {}) {
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', { jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread });
  journal.insertJob({ assign, leaseEpoch, repoKey: 'acme/app', jobDir });
  const calls: string[] = [];
  const hooks: { onAcquire?: () => void } = {};
  let closes = 0;
  const credentials = {
    async acquire() {
      calls.push('credentials.acquire');
      hooks.onAcquire?.();
      return overrides.acquireResult ?? { ok: true as const, credentials: { helper, binDir: null } };
    },
    async release() {
      calls.push('credentials.release');
      if (overrides.releaseThrows) throw new Error('release exploded');
    },
  };
  const host = {
    sessions: {
      async open() {
        calls.push('sessions.open');
        return { ok: true as const, session: sessionStub(() => { closes += 1; }), resumed: false };
      },
    },
    credentials,
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() {
      calls.push('prepareWorktree');
      return overrides.prepareResult ?? { ok: true as const, worktree, tipSha: 'b'.repeat(40) };
    },
    async ensureSkills() { calls.push('ensureSkills'); return { ok: true as const }; },
    skillOrigin: 'file:///fixture/skills',
  };
  const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = {
    journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'),
    sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning,
  };
  return { journal, calls, hooks, makeRun: () => new ThreadJobRun(deps, jobId, leaseEpoch), closes: () => closes };
}

function stateEvents(journal: Journal): Array<{ to: string; reason?: string }> {
  return journal.pendingEvents(jobId, leaseEpoch, 100).filter((event) => event.type === 'state')
    .map((event) => event.payload as { to: string; reason?: string });
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ThreadJobRun start failures (US-003)', () => {
  test('a halt during the credential wait gives them back before the worktree step', async () => {
    const context = setup();
    const run = context.makeRun();
    context.hooks.onAcquire = () => run.halt();
    await run.start('prepare');
    expect(context.calls).toEqual(['credentials.acquire', 'credentials.release']);
    expect(stateEvents(context.journal)).toEqual([]);   // a halt makes no transition
    context.journal.close();
  });

  test('a cancel request during the credential wait ends CANCELLED and gives them back', async () => {
    const context = setup();
    const run = context.makeRun();
    context.hooks.onAcquire = () => { run.requestCancel(); };
    await run.start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(context.calls).toContain('credentials.release');
    expect(context.calls).not.toContain('prepareWorktree');
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).not.toBeNull();
    context.journal.close();
  });

  test('a refused acquire gives back the socket the broker opened before it waited', async () => {
    const context = setup({ acquireResult: { ok: false, reason: 'git token: timeout' } });
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'FAILED', reason: 'git token: timeout' }]);
    expect(context.calls).toEqual(['credentials.acquire', 'credentials.release']);
    context.journal.close();
  });

  test('a cancelled acquire gives them back and ends CANCELLED', async () => {
    const context = setup({ acquireResult: { ok: false, reason: 'cancelled', cancelled: true } });
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(context.calls).toContain('credentials.release');
    context.journal.close();
  });

  test('a failing release does not mask the worktree failure', async () => {
    const context = setup({ prepareResult: { ok: false, reason: 'worktree_conflict' }, releaseThrows: true });
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([{ to: 'FAILED', reason: 'worktree_conflict' }]);
    expect(context.journal.getJob(jobId, leaseEpoch)?.doneAt).not.toBeNull();
    context.journal.close();
  });

  test('a stream that cannot be opened fails the run and closes the session', async () => {
    await mkdir(join(workspaceRoot, '.jobs'), { recursive: true });
    await writeFile(jobDir, 'not a directory');   // mkdir(jobDir) refuses: the stream cannot be created
    const context = setup();
    await context.makeRun().start('prepare');
    expect(stateEvents(context.journal)).toEqual([
      { to: 'RUNNING' }, { to: 'UPLOADING' }, { to: 'FAILED', reason: 'session_error' },
    ]);
    expect(context.closes()).toBe(1);
    context.journal.close();
  });

  test('the stream directory is 0700 even when it already exists', async () => {
    await mkdir(jobDir, { recursive: true, mode: 0o755 });
    await chmod(jobDir, 0o755);
    const context = setup();
    const run = context.makeRun();
    const starting = run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    run.halt();
    await starting;
    expect((await stat(jobDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(jobDir, THREAD_EVENTS_FILE))).isFile()).toBe(true);
    context.journal.close();
  });
});
