import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ThreadAssign } from '@nathapp/fleet-protocol';
import { createFileTranscriptStore, nativeBackend, type AgentSession, type CreateAgentSessionOptions, type NativeBackendOptions, type SessionBackend } from '@nathapp/nax-agent';
import type { AcpBackendOptions } from '@nathapp/nax-agent-acp/client';

const factoryModule = await import('../../src/thread/session-factory').catch(() => undefined);

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

function setup(overrides: {
  resume?: boolean;
  backend?: ThreadAssign['backend'];
  models?: string[];
  defaultModel?: string | null;
  createError?: Error;
  resumeError?: Error;
  tools?: CreateAgentSessionOptions['tools'];
} = {}) {
  const calls: {
    create: Array<{ options: CreateAgentSessionOptions }>;
    resume: Array<{ sessionId: string; options: CreateAgentSessionOptions }>;
    native: NativeBackendOptions[];
    acp: AcpBackendOptions[];
    nativeModels: number;
    backendResults: CreateAgentSessionOptions['backend'][];
    transcript: string[];
  } = { create: [], resume: [], native: [], acp: [], nativeModels: 0, backendResults: [], transcript: [] };
  // The injected ACP factory's result: this spec fakes the session itself, so the backend is only ever
  // compared by identity — an `open` that throws proves the factory never let nax-agent use it.
  const acpSentinel: SessionBackend = {
    kind: 'acp:codex',
    open: async () => { throw new Error('this spec never opens an ACP backend'); },
  };
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
      const backend = nativeBackend(options);
      calls.backendResults.push(backend);
      return backend;
    },
    acpBackend: (options: AcpBackendOptions) => {
      calls.acp.push(options);
      calls.backendResults.push(acpSentinel);
      return acpSentinel;
    },
    createFileTranscriptStore: (directory: string) => {
      calls.transcript.push(directory);
      return createFileTranscriptStore(directory);
    },
  };
  const factory = factoryModule && new factoryModule.ThreadSessionFactory({
    homeDir: '/runner-home',
    naxHome: '/nax-home',
    nativeModels: async () => {
      calls.nativeModels += 1;
      return { models: overrides.models ?? ['m/x', 'm/b'], defaultModel: overrides.defaultModel === undefined ? 'm/b' : overrides.defaultModel };
    },
    agent,
  });
  // `resume` and `backend` seed the thread handed to open(), so a test can vary the assign either
  // here or, for a single call, through open()'s second argument.
  const assigned = thread({
    resume: overrides.resume ?? false,
    backend: overrides.backend ?? { kind: 'native', model: 'm/x' },
  });
  return { calls, acpSentinel, open: (jobId = 'job-1', value = assigned) => {
    expect(factoryModule).toBeDefined();
    if (factory === undefined) throw new Error('ThreadSessionFactory is unavailable');
    return factory.open({ jobId, thread: value, worktree: '/work/tree', tools: overrides.tools ?? [], approvalTimeoutSec: 60 });
  } };
}

test('US-006 AC-1: creates a non-resumed session with the read profile', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.create[0]?.options.profile).toBe('read');
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-2: resumes a requested session with the read profile', async () => {
  const h = setup({ resume: true });
  const result = await h.open();
  expect(h.calls.create).toHaveLength(0);
  expect(h.calls.resume[0]?.options.profile).toBe('read');
  expect(result).toEqual({ ok: true, session, resumed: true });
});

test('US-006 AC-3: supplies the requested worktree when creating a session', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.create[0]?.options.workdir).toBe('/work/tree');
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-4: stores the transcript below the thread home directory', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.transcript).toEqual([join('/runner-home', 'threads', 'thread-1', 'transcript')]);
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-5: creates the session with the assigned thread id', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.create[0]?.options.sessionId).toBe('thread-1');
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-6: passes the injected native backend to session creation', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.create[0]?.options.backend).toBe(h.calls.backendResults[0]);
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-7: includes the selected effort in the native model identifier', async () => {
  const h = setup();
  const result = await h.open('job-1', thread({ backend: { kind: 'native', model: 'm/x', effort: 'high' } }));
  expect(h.calls.native[0]?.model).toBe('m/x[high]');
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-8: chooses the default model when the backend omits a model', async () => {
  const h = setup({ backend: { kind: 'native' }, defaultModel: 'm/b' });
  const result = await h.open();
  expect(h.calls.native[0]?.model).toBe('m/b');
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-006 AC-9: preserves conversation history across native models', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.native[0]?.carryHistoryAcrossModels).toBe(true);
  expect(result).toEqual({ ok: true, session, resumed: false });
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

// thread-agents-modes US-003: an `acp` backend is opened through the injected ACP factory. The assign parser and
// nax-agent own the rest of the contract; this factory only wires the options and maps the failure codes.
test('US-003 AC-6: an acp open constructs no native backend and consults no native models', async () => {
  const h = setup();
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'claude' } }));
  expect(result.ok).toBe(true);
  expect(h.calls.native).toHaveLength(0);
  expect(h.calls.nativeModels).toBe(0);
});

test('US-003 AC-1: opens an acp thread through the injected acp backend factory', async () => {
  const h = setup();
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'codex', model: 'gpt-5-codex' } }));
  expect(h.calls.acp).toHaveLength(1);
  expect(h.calls.acp[0]).toEqual({ agent: 'codex', allowUnsandboxed: true, inheritEnv: true, model: 'gpt-5-codex' });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.session).toBe(session);
  expect(result.resumed).toBe(false);
});

test('US-003 AC-2: forwards an acp effort to the backend factory', async () => {
  const h = setup();
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'codex', model: 'gpt-5-codex', effort: 'high' } }));
  expect(h.calls.acp[0]?.effort).toBe('high');
  expect(result.ok).toBe(true);
});

test('US-003 AC-2: an acp backend without a model or effort keeps both keys off the factory options', async () => {
  const h = setup();
  await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'claude' } }));
  expect(h.calls.acp[0]).toEqual({ agent: 'claude', allowUnsandboxed: true, inheritEnv: true });
});

test('US-003 AC-3: passes the declared tools, the worktree and the instructions to the acp session', async () => {
  const tools: CreateAgentSessionOptions['tools'] = [{
    name: 'read_file',
    description: 'reads one file of the worktree',
    inputSchema: { type: 'object' },
    approval: 'never',
    run: async () => ({ content: '' }),
  }];
  const h = setup({ tools });
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'cursor' }, instructions: 'koda instructions' }));
  expect(h.calls.create[0]?.options.tools).toBe(tools);
  expect(h.calls.create[0]?.options.workdir).toBe('/work/tree');
  expect(h.calls.create[0]?.options.instructions).toBe('koda instructions');
  expect(h.calls.create[0]?.options.backend).toBe(h.acpSentinel);
  expect(result.ok).toBe(true);
});

test('US-003 AC-3: an acp session keeps the native session options', async () => {
  const h = setup();
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'claude' } }));
  expect(h.calls.create[0]?.options.sessionId).toBe('thread-1');
  expect(h.calls.create[0]?.options.profile).toBe('read');
  expect(h.calls.create[0]?.options.turnTimeoutSeconds).toBe(900);
  expect(h.calls.create[0]?.options.approvalTimeoutMs).toBe(60_000);
  expect(h.calls.create[0]?.options.metadata).toEqual({ threadId: 'thread-1', jobId: 'job-1' });
  expect(h.calls.transcript).toEqual([join('/runner-home', 'threads', 'thread-1', 'transcript')]);
  expect(result.ok).toBe(true);
});

test('US-003 AC-4: an acp agent that needs login returns agent_not_logged_in', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ createError: new AgentSessionError('login required', 'AGENT_SESSION_AUTH_REQUIRED') });
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'cursor' } }));
  expect(result).toEqual({ ok: false, reason: 'agent_not_logged_in' });
});

test('US-003 AC-5: an unlaunchable acp agent returns backend_unavailable', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ createError: new AgentSessionError('no agent', 'AGENT_SESSION_BACKEND_UNAVAILABLE') });
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'codex' } }));
  // The code is mapped from the agent session, not from the backend kind: the ACP factory and a create
  // attempt come first.
  expect(h.calls.acp).toHaveLength(1);
  expect(h.calls.create).toHaveLength(1);
  expect(result).toEqual({ ok: false, reason: 'backend_unavailable' });
});

test('US-003: an acp session that already exists falls back to resume', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ createError: new AgentSessionError('exists', 'AGENT_SESSION_EXISTS') });
  const result = await h.open('job-1', thread({ backend: { kind: 'acp', agent: 'codex' } }));
  expect(h.calls.resume[0]?.sessionId).toBe('thread-1');
  expect(h.calls.resume[0]?.options.backend).toBe(h.acpSentinel);
  expect(result).toEqual({ ok: true, session, resumed: true });
});

test('US-003: a resumed acp session that is gone falls back to create', async () => {
  const { AgentSessionError } = await import('@nathapp/nax-agent');
  const h = setup({ resumeError: new AgentSessionError('not found', 'AGENT_SESSION_NOT_FOUND') });
  const result = await h.open('job-1', thread({ resume: true, backend: { kind: 'acp', agent: 'claude' } }));
  expect(h.calls.create[0]?.options.sessionId).toBe('thread-1');
  expect(h.calls.acp).toHaveLength(1);
  expect(result).toEqual({ ok: true, session, resumed: false });
});

test('US-003 AC-6: a native open never calls the acp backend factory', async () => {
  const h = setup();
  const result = await h.open();
  expect(h.calls.acp).toHaveLength(0);
  expect(h.calls.backendResults).toHaveLength(1);
  expect(result).toEqual({ ok: true, session, resumed: false });
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
