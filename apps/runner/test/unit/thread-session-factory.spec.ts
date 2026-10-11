import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import { createFileTranscriptStore, nativeBackend, type AgentSession, type CreateAgentSessionOptions, type NativeBackendOptions } from '@nathapp/nax-agent';

const factoryModule = await import('../../src/thread/session-factory').catch(() => undefined);

const session: AgentSession = {
  id: 'thread-1',
  backend: { kind: 'native', model: 'm/x' },
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

function setup(overrides: {
  resume?: boolean;
  backend?: ThreadAssign['backend'];
  models?: string[];
  defaultModel?: string | null;
  createError?: Error;
  resumeError?: Error;
} = {}) {
  const calls: {
    create: Array<{ options: CreateAgentSessionOptions }>;
    resume: Array<{ sessionId: string; options: CreateAgentSessionOptions }>;
    native: NativeBackendOptions[];
    transcript: string[];
  } = { create: [], resume: [], native: [], transcript: [] };
  const agent = {
    createAgentSession: async (options: CreateAgentSessionOptions) => {
      calls.create.push({ options });
      if (overrides.createError) throw overrides.createError;
      return session;
    },
    resumeAgentSession: async (sessionId: string, options: CreateAgentSessionOptions) => {
      calls.resume.push({ sessionId, options });
      if (overrides.resumeError) throw overrides.resumeError;
      return session;
    },
    nativeBackend: (options: NativeBackendOptions) => {
      calls.native.push(options);
      return nativeBackend(options);
    },
    createFileTranscriptStore: (directory: string) => {
      calls.transcript.push(directory);
      return createFileTranscriptStore(directory);
    },
  };
  const factory = factoryModule && new factoryModule.ThreadSessionFactory({
    homeDir: '/runner-home',
    naxHome: '/nax-home',
    nativeModels: async () => ({ models: overrides.models ?? ['m/x', 'm/b'], defaultModel: overrides.defaultModel === undefined ? 'm/b' : overrides.defaultModel }),
    agent,
  });
  return { calls, open: (jobId = 'job-1', value = thread()) => {
    expect(factoryModule).toBeDefined();
    return factory!.open({ jobId, thread: value, worktree: '/work/tree', tools: [], approvalTimeoutSec: 60 });
  } };
}

test('US-006 AC-1: creates a non-resumed session with the read profile', async () => {
  const h = setup();
  await h.open();
  expect(h.calls.create[0]?.options.profile).toBe('read');
});

test('US-006 AC-2: resumes a requested session with the read profile', async () => {
  const h = setup({ resume: true });
  await h.open('job-1', thread({ resume: true }));
  expect(h.calls.resume[0]?.options.profile).toBe('read');
});

test('US-006 AC-3: supplies the requested worktree when creating a session', async () => {
  const h = setup();
  await h.open();
  expect(h.calls.create[0]?.options.workdir).toBe('/work/tree');
});

test('US-006 AC-4: stores the transcript below the thread home directory', async () => {
  const h = setup();
  await h.open();
  expect(h.calls.transcript).toEqual([join('/runner-home', 'threads', 'thread-1', 'transcript')]);
});

test('US-006 AC-5: creates the session with the assigned thread id', async () => {
  const h = setup();
  await h.open();
  expect(h.calls.create[0]?.options.sessionId).toBe('thread-1');
});

test('US-006 AC-6: passes the injected native backend to session creation', async () => {
  const h = setup();
  await h.open();
  expect(h.calls.create[0]?.options.backend).toEqual(h.calls.native[0]);
});

test('US-006 AC-7: includes the selected effort in the native model identifier', async () => {
  const h = setup();
  await h.open('job-1', thread({ backend: { kind: 'native', model: 'm/x', effort: 'high' } }));
  expect(h.calls.native[0]?.model).toBe('m/x[high]');
});

test('US-006 AC-8: chooses the default model when the backend omits a model', async () => {
  const h = setup({ defaultModel: 'm/b' });
  await h.open('job-1', thread({ backend: { kind: 'native' } }));
  expect(h.calls.native[0]?.model).toBe('m/b');
});

test('US-006 AC-9: preserves conversation history across native models', async () => {
  const h = setup();
  await h.open();
  expect(h.calls.native[0]?.carryHistoryAcrossModels).toBe(true);
});

test('US-006 AC-10: rejects a model absent from the advertised model set', async () => {
  const h = setup({ models: ['m/x'] });
  const result = await h.open('job-1', thread({ backend: { kind: 'native', model: 'm/z' } }));
  expect(result).toEqual({ ok: false, reason: 'model_unknown' });
});

test('US-006 AC-10: does not create a session for an unadvertised model', async () => {
  const h = setup({ models: ['m/x'] });
  await h.open('job-1', thread({ backend: { kind: 'native', model: 'm/z' } }));
  expect(h.calls.create).toHaveLength(0);
});

test('US-006 AC-11: rejects a missing default model', async () => {
  const h = setup({ defaultModel: null });
  const result = await h.open('job-1', thread({ backend: { kind: 'native' } }));
  expect(result).toEqual({ ok: false, reason: 'model_unknown' });
});

test('US-006 AC-12: rejects ACP sessions without constructing a native backend', async () => {
  const h = setup();
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'claude' } }));
  expect(result).toEqual({ ok: false, reason: 'backend_unavailable' });
});

test('US-006 AC-12: does not construct a native backend for ACP', async () => {
  const h = setup();
  await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'claude' } }));
  expect(h.calls.native).toHaveLength(0);
});

test('US-006 AC-13: creates a missing resumed session and reports it as new', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ resumeError: new AgentSessionError('not found', 'AGENT_SESSION_NOT_FOUND') });
  const result = await h.open('job-1', thread({ resume: true }));
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-14: resumes an existing session after create reports a conflict', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ createError: new AgentSessionError('exists', 'AGENT_SESSION_EXISTS') });
  const result = await h.open();
  expect(result).toEqual({ ok: true, session, resumed: true });
});

test('US-006 AC-15: reports an unauthenticated agent session', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ createError: new AgentSessionError('login required', 'AGENT_SESSION_AUTH_REQUIRED') });
  const result = await h.open();
  expect(result).toEqual({ ok: false, reason: 'agent_not_logged_in' });
});
