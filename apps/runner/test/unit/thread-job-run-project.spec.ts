import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { AgentSession } from '@nathapp/nax-agent';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { threadScratchDir } from '../../src/thread/thread-paths';
import { assignFor } from '../helpers/assign';
import { waitFor } from '../helpers/wait';

const root = join(import.meta.dir, `.thread-job-run-project-${crypto.randomUUID()}`);
const homeDir = join(root, 'runner-home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-job-p1';
const threadId = 'thread-p1';
const leaseEpoch = 1;
const skill = {
  sourceId: 'skill-source-1', owner: 'acme', repo: 'skills', sha: 'a'.repeat(40),
  skills: [{ name: 'spec-writing', dir: 'spec-writing', description: 'writes specs' }],
};
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 10_000,
};
const idleSession: AgentSession = {
  id: threadId, backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
  async *send() { yield { type: 'turn_end', sessionId: threadId, turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never; },
  answer: () => 'accepted', cancel: () => undefined, close: async () => undefined,
};

function setup(kind?: 'PROJECT' | 'REPO') {
  const thread: ThreadAssign = {
    threadId, action: 'SESSION', ...(kind === undefined ? {} : { kind }), feature: `thread-${threadId}`, resume: false,
    instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
    skills: [skill], initialMessage: { messageId: 'm1', text: 'hi' },
  };
  const journal = Journal.open(':memory:');
  journal.insertJob({ assign: assignFor('THREAD', { jobId, thread }), leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const calls: string[] = [];
  const state: { open?: Record<string, unknown>; scratchExistedAtOpen?: boolean } = {};
  const host = {
    sessions: { async open(input: Record<string, unknown>) {
      calls.push('sessions.open'); state.open = input;
      state.scratchExistedAtOpen = await stat(threadScratchDir(homeDir, threadId)).then((s) => s.isDirectory(), () => false);
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
  const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = { journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'), sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning };
  return { journal, calls, state, run: new ThreadJobRun(deps, jobId, leaseEpoch) };
}

async function running(kind?: 'PROJECT' | 'REPO') {
  const context = setup(kind);
  await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
  const starting = context.run.start('prepare');
  await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
  return { ...context, finish: async () => { context.run.halt(); await starting; context.journal.close(); } };
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ThreadJobRun PROJECT session (US-006)', () => {
  test('US-006 AC-8: the session opens on the scratch directory', async () => {
    const ctx = await running('PROJECT');
    expect(ctx.state.open?.['worktree']).toBe(threadScratchDir(homeDir, threadId));
    await ctx.finish();
  });

  test('US-006 AC-9: the session opens with only the skill tools', async () => {
    const ctx = await running('PROJECT');
    const tools = ctx.state.open?.['tools'] as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(['load_skill', 'read_skill_file']);
    await ctx.finish();
  });

  test('US-006 AC-10: credentials.acquire is never called', async () => {
    const ctx = await running('PROJECT');
    expect(ctx.calls).not.toContain('credentials.acquire');
    await ctx.finish();
  });

  test('US-006 AC-11: prepareWorktree is never called', async () => {
    const ctx = await running('PROJECT');
    expect(ctx.calls).not.toContain('prepareWorktree');
    expect(ctx.calls).toEqual(['ensureSkills', 'sessions.open']);
    await ctx.finish();
  });

  test('US-006 AC-12: the scratch directory exists before the session opens', async () => {
    const ctx = await running('PROJECT');
    expect(ctx.state.scratchExistedAtOpen).toBe(true);
    await ctx.finish();
  });

  test('US-006 AC-13: THREAD_PUBLISH on a running PROJECT run is rejected as not_repo_thread', async () => {
    const ctx = await running('PROJECT');
    expect(ctx.run.command('THREAD_PUBLISH', {})).toEqual({ result: 'rejected', detail: 'not_repo_thread' });
    await ctx.finish();
  });

  test('US-006 AC-14: a SESSION with no kind still prepares the worktree', async () => {
    const ctx = await running(undefined);
    expect(ctx.calls).toContain('prepareWorktree');
    expect(ctx.calls).toContain('credentials.acquire');
    await ctx.finish();
  });
});
