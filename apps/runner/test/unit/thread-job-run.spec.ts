import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { AgentSession } from '@nathapp/nax-agent';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { assignFor } from '../helpers/assign';
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
} = {}) {
  const journal = Journal.open(':memory:');
  const assign = assignFor('THREAD', {
    jobId, ref: 'refs/heads/base-for-thread', approvalTimeoutSec: 321, thread,
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
  };
  const logs = {
    register(input: Record<string, unknown>) { observations.registered = input; },
    wake() {}, async drain() { return 'drained' as const; }, stopJob() {},
  };
  const deps = {
    journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'),
    sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs,
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
    await waitFor(async () => {
      const stream = await readFile(join(workspaceRoot, '.jobs', jobId, 'thread-events.jsonl'), 'utf8');
      return stream.includes('"type":"turn_end"') && stream.includes('"status":"completed"');
    });
    run.halt();
    await starting;
    expect(stateEvents(context.journal).map((event) => event.to)).toEqual(['RUNNING']);
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
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING'); run.halt(); await starting;
    const lines = (await readFile(join(jobDir, 'thread-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; messageId?: string });
    const consumed = lines.findIndex((line) => line.type === 'input_consumed' && line.messageId === 'm1');
    const firstSessionEvent = lines.findIndex((line) => !['session_started', 'input_consumed'].includes(line.type));
    expect(consumed).toBeGreaterThanOrEqual(0);
    expect(firstSessionEvent).toBeGreaterThan(consumed);
    context.journal.close();
  });
});
