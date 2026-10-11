import { expect, test } from 'bun:test';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import {
  createFileTranscriptStore,
  nativeBackend,
  type AgentSession,
  type CreateAgentSessionOptions,
  type NativeBackendOptions,
} from '@nathapp/nax-agent';
import { ThreadSessionFactory } from '../../src/thread/session-factory';

const session: AgentSession = {
  id: 'thread-1',
  backend: { kind: 'native', capabilities: {} },
  lastTurn: undefined,
  async *send() {},
  answer: () => 'unknown',
  cancel: () => undefined,
  close: async () => undefined,
};

function thread(overrides: Partial<ThreadAssign> = {}): ThreadAssign {
  return {
    threadId: 'thread-1',
    action: 'SESSION',
    feature: 'feature',
    resume: false,
    instructions: 'instructions',
    backend: { kind: 'native', model: 'm/x' },
    skills: [],
    initialMessage: null,
    ...overrides,
  };
}

/** A real Error carrying a code, but not an `AgentSessionError` instance (a second nax-agent copy). */
function codedError(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function harness(overrides: {
  nativeModels?: () => Promise<{ models: string[]; defaultModel: string | null }>;
  createAgentSession?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
  resumeAgentSession?: (sessionId: string, options: CreateAgentSessionOptions) => Promise<AgentSession>;
} = {}) {
  const created: CreateAgentSessionOptions[] = [];
  const native: NativeBackendOptions[] = [];
  const factory = new ThreadSessionFactory({
    homeDir: '/runner-home',
    naxHome: '/nax-home',
    nativeModels: overrides.nativeModels ?? (async () => ({ models: ['m/x'], defaultModel: 'm/x' })),
    agent: {
      nativeBackend: (options) => {
        native.push(options);
        return nativeBackend(options);
      },
      createFileTranscriptStore: (directory) => createFileTranscriptStore(directory),
      createAgentSession: async (options) => {
        created.push(options);
        return overrides.createAgentSession ? await overrides.createAgentSession(options) : session;
      },
      resumeAgentSession: async (sessionId, options) =>
        overrides.resumeAgentSession ? await overrides.resumeAgentSession(sessionId, options) : session,
    },
  });
  return {
    created,
    native,
    open: (input: { thread?: ThreadAssign; approvalTimeoutSec?: number } = {}) =>
      factory.open({
        jobId: 'job-1',
        thread: input.thread ?? thread(),
        worktree: '/work/tree',
        tools: [],
        approvalTimeoutSec: input.approvalTimeoutSec ?? 60,
      }),
  };
}

test('US-006 hardening: a rejected nativeModels() resolves to session_error instead of rejecting', async () => {
  const h = harness({ nativeModels: async () => { throw new Error('nax config unreadable'); } });
  const result = await h.open();
  expect(result).toEqual({ ok: false, reason: 'session_error' });
});

test('US-006 hardening: a malformed thread backend resolves to session_error instead of throwing', async () => {
  const h = harness();
  const broken = { ...thread(), backend: undefined } as unknown as ThreadAssign;
  const result = await h.open({ thread: broken });
  expect(result).toEqual({ ok: false, reason: 'session_error' });
});

test('US-006 hardening: a null effort is rejected as model_unknown without building a backend', async () => {
  const h = harness();
  const backend = { kind: 'native', model: 'm/x', effort: null } as unknown as ThreadAssign['backend'];
  const result = await h.open({ thread: thread({ backend }) });
  expect(result).toEqual({ ok: false, reason: 'model_unknown' });
  expect(h.native).toHaveLength(0);
});

test('US-006 hardening: a non-finite approvalTimeoutSec falls back to the 30s floor', async () => {
  const h = harness();
  await h.open({ approvalTimeoutSec: Number.NaN });
  expect(h.created[0]?.approvalTimeoutMs).toBe(30_000);
});

test('US-006 hardening: a fractional approvalTimeoutSec stays an integer within 30s..3600s', async () => {
  const h = harness();
  await h.open({ approvalTimeoutSec: 60.0005 });
  const ms = h.created[0]?.approvalTimeoutMs;
  expect(Number.isInteger(ms)).toBe(true);
  expect(ms).toBeGreaterThanOrEqual(30_000);
  expect(ms).toBeLessThanOrEqual(3_600_000);
});

test('US-006 hardening: approvalTimeoutSec is clamped to the 30s..3600s bounds', async () => {
  const low = harness();
  await low.open({ approvalTimeoutSec: 0 });
  expect(low.created[0]?.approvalTimeoutMs).toBe(30_000);

  const high = harness();
  await high.open({ approvalTimeoutSec: 100_000 });
  expect(high.created[0]?.approvalTimeoutMs).toBe(3_600_000);
});

test('US-006 hardening: a duck-typed AGENT_SESSION_EXISTS error still falls back to resume', async () => {
  const h = harness({ createAgentSession: async () => { throw codedError('AGENT_SESSION_EXISTS'); } });
  const result = await h.open();
  expect(result).toEqual({ ok: true, session, resumed: true });
});

test('US-006 hardening: a duck-typed AGENT_SESSION_NOT_FOUND error still falls back to create', async () => {
  const h = harness({ resumeAgentSession: async () => { throw codedError('AGENT_SESSION_NOT_FOUND'); } });
  const result = await h.open({ thread: thread({ resume: true }) });
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 hardening: a duck-typed AGENT_SESSION_AUTH_REQUIRED error maps to agent_not_logged_in', async () => {
  const h = harness({ createAgentSession: async () => { throw codedError('AGENT_SESSION_AUTH_REQUIRED'); } });
  const result = await h.open();
  expect(result).toEqual({ ok: false, reason: 'agent_not_logged_in' });
});
