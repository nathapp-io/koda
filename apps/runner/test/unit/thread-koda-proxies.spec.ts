import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, EmbedderTool, EmbedderToolContext } from '@nathapp/nax-agent';
import type { KodaToolDescriptor, ThreadAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { NetworkError, ServerClient, ServerError, type FetchFn } from '../../src/sync/http';
import type { KodaToolCaller, KodaToolCallInput, KodaToolProxyOptions } from '../../src/thread/tools/koda-proxies';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { waitFor } from '../helpers/wait';

// Fleet S5b US-006: the proxy module is new, so the import is guarded and each case fails on its own assertion
// (rather than on a module-not-found error that hides which behaviour is missing).
const proxiesModule = await import('../../src/thread/tools/koda-proxies').catch(() => undefined);

function buildProxies(descriptors: readonly KodaToolDescriptor[], options: KodaToolProxyOptions): EmbedderTool[] {
  expect(proxiesModule).toBeDefined();
  if (proxiesModule === undefined) throw new Error('koda-proxies module is unavailable');
  return proxiesModule.buildKodaToolProxies(descriptors, options);
}

const DESCRIPTORS: KodaToolDescriptor[] = [
  { name: 'koda_get_ticket', description: 'reads one ticket of this project', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
  { name: 'koda_search_tickets', description: 'searches the project tickets', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
];

const context = (toolCallId: string, signal: AbortSignal = new AbortController().signal): EmbedderToolContext => ({ sessionId: 'session-1', toolCallId, signal });

/** A caller that records every call and answers (or rejects) as scripted. */
function recordingCaller(answer: (args: KodaToolCallInput) => Promise<{ content: string; isError: boolean }>) {
  const calls: KodaToolCallInput[] = [];
  const caller: KodaToolCaller = {
    async call(args) {
      calls.push(args);
      return answer(args);
    },
  };
  return { calls, caller };
}

const envelope = (data: unknown, status = 200): Response => new Response(JSON.stringify({ ret: 0, data }), { status, headers: { 'content-type': 'application/json' } });

describe('ServerClient.callKodaTool (US-006 AC-6)', () => {
  function recordingClient(respond: (url: string) => Response) {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      requests.push({ url, init });
      return respond(url);
    };
    return { requests, client: new ServerClient({ serverUrl: 'https://koda.example.test', apiKey: 'kr_test', fetchFn }) };
  }

  test('US-006 kodaTools AC-6: one POST with the provider body, the runner bearer and leaseEpoch', async () => {
    const { requests, client } = recordingClient(() => envelope({ content: 'ticket WEB-1', isError: false }));
    const answer = await client.callKodaTool({ jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c1', input: { ref: 'WEB-1' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://koda.example.test/api/fleet/runner/jobs/j1/tools/koda_get_ticket?leaseEpoch=3');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ toolCallId: 'c1', input: { ref: 'WEB-1' } });
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: 'Bearer kr_test', 'accept-language': 'en', 'content-type': 'application/json' });
    expect(answer).toEqual({ content: 'ticket WEB-1', isError: false });
  });

  test('US-006 kodaTools: the job id and the tool name are URL-encoded path segments', async () => {
    const { requests, client } = recordingClient(() => envelope({ content: 'ok', isError: false }));
    await client.callKodaTool({ jobId: 'j 1', leaseEpoch: 0, name: 'koda_get/ticket', toolCallId: 'c1', input: {} });
    expect(requests[0]?.url).toBe('https://koda.example.test/api/fleet/runner/jobs/j%201/tools/koda_get%2Fticket?leaseEpoch=0');
  });

  test('US-006 kodaTools: an HTTP error rejects with ServerError carrying the status, the body message and the body', async () => {
    const body = { ret: 1, message: "This runner does not hold the job's current lease" };
    const { client } = recordingClient(() => new Response(JSON.stringify(body), { status: 409 }));
    const failure = client.callKodaTool({ jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c1', input: {} });
    await expect(failure).rejects.toBeInstanceOf(ServerError);
    await expect(failure).rejects.toMatchObject({ status: 409, message: "This runner does not hold the job's current lease", body });
  });

  test('US-006 kodaTools: an unreachable server rejects with NetworkError', async () => {
    const client = new ServerClient({
      serverUrl: 'https://koda.example.test', apiKey: 'kr_test',
      fetchFn: async () => { throw new TypeError('connect ECONNREFUSED'); },
    });
    await expect(client.callKodaTool({ jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c1', input: {} })).rejects.toBeInstanceOf(NetworkError);
  });

  test('US-006 kodaTools: a caller abort rejects with the abort reason, not a NetworkError', async () => {
    const controller = new AbortController();
    const client = new ServerClient({
      serverUrl: 'https://koda.example.test', apiKey: 'kr_test',
      fetchFn: async (_url, init) => {
        controller.abort(new Error('turn cancelled'));
        const signal = init?.signal;
        expect(signal?.aborted).toBe(true);
        throw signal?.reason;
      },
    });
    await expect(client.callKodaTool({ jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c1', input: {}, signal: controller.signal }))
      .rejects.toThrow('turn cancelled');
  });
});

describe('buildKodaToolProxies (US-006 AC-7..AC-10, AC-14)', () => {
  const options = (caller: KodaToolCaller): KodaToolProxyOptions => ({ jobId: 'j1', leaseEpoch: 3, caller });

  test('US-006 kodaTools AC-7: one tool per descriptor, each carrying its descriptor fields and approval never', () => {
    const { caller } = recordingCaller(async () => ({ content: '', isError: false }));
    const tools = buildProxies(DESCRIPTORS, options(caller));
    expect(tools).toHaveLength(2);
    for (const [index, tool] of tools.entries()) {
      const descriptor = DESCRIPTORS[index] as KodaToolDescriptor;
      expect({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, approval: tool.approval })
        .toEqual({ ...descriptor, approval: 'never' });
    }
  });

  test('US-006 kodaTools AC-8: run calls the caller once with the context tool call id, the input and the context signal', async () => {
    const { calls, caller } = recordingCaller(async () => ({ content: 'WEB-1: fix login', isError: false }));
    const tool = buildProxies([DESCRIPTORS[0] as KodaToolDescriptor], options(caller))[0] as EmbedderTool;
    const signal = new AbortController().signal;
    const answer = await tool.run({ ref: 'WEB-1' }, context('c9', signal));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c9', input: { ref: 'WEB-1' } });
    expect(calls[0]?.signal).toBe(signal);
    expect(answer).toEqual({ content: 'WEB-1: fix login', isError: false });
  });

  test('US-006 kodaTools AC-8: an error answer from the server is passed through as it is', async () => {
    const { calls, caller } = recordingCaller(async () => ({ content: 'not_found', isError: true }));
    const tool = buildProxies([DESCRIPTORS[0] as KodaToolDescriptor], options(caller))[0] as EmbedderTool;
    expect(await tool.run({ ref: 'NOPE-1' }, context('c9'))).toEqual({ content: 'not_found', isError: true });
    expect(calls).toHaveLength(1);
  });

  test('US-006 kodaTools AC-9: a ServerError becomes the tool-unavailable answer, with no retry', async () => {
    const { calls, caller } = recordingCaller(async () => { throw new ServerError(409, "This runner does not hold the job's current lease", null); });
    const tool = buildProxies([DESCRIPTORS[0] as KodaToolDescriptor], options(caller))[0] as EmbedderTool;
    expect(await tool.run({ ref: 'WEB-1' }, context('c9'))).toEqual({ content: "koda tool unavailable: This runner does not hold the job's current lease", isError: true });
    expect(calls).toHaveLength(1);
  });

  test('US-006 kodaTools AC-10: a NetworkError becomes the network answer, with no retry', async () => {
    const { calls, caller } = recordingCaller(async () => { throw new NetworkError('connect ECONNREFUSED'); });
    const tool = buildProxies([DESCRIPTORS[0] as KodaToolDescriptor], options(caller))[0] as EmbedderTool;
    expect(await tool.run({ ref: 'WEB-1' }, context('c9'))).toEqual({ content: 'koda tool unavailable: network error', isError: true });
    expect(calls).toHaveLength(1);
  });

  test('US-006 kodaTools AC-14: an aborted call becomes the network answer, with no retry', async () => {
    const controller = new AbortController();
    const { calls, caller } = recordingCaller(async (args) => {
      // The transport's own abort path: the merged signal is aborted, so the call ends with an AbortError.
      expect(args.signal?.aborted).toBe(true);
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    const tool = buildProxies([DESCRIPTORS[0] as KodaToolDescriptor], options(caller))[0] as EmbedderTool;
    controller.abort();
    expect(await tool.run({ ref: 'WEB-1' }, context('c9', controller.signal))).toEqual({ content: 'koda tool unavailable: network error', isError: true });
    expect(calls).toHaveLength(1);
  });

  test('US-006 kodaTools: an unexpected failure (neither ServerError nor abort) is also the network answer', async () => {
    const { calls, caller } = recordingCaller(async () => { throw new TypeError('undefined is not a function'); });
    const tool = buildProxies([DESCRIPTORS[0] as KodaToolDescriptor], options(caller))[0] as EmbedderTool;
    expect(await tool.run({}, context('c9'))).toEqual({ content: 'koda tool unavailable: network error', isError: true });
    expect(calls).toHaveLength(1);
  });

  test('US-006 kodaTools: no descriptors means no tools', () => {
    const { caller } = recordingCaller(async () => ({ content: '', isError: false }));
    expect(buildProxies([], options(caller))).toEqual([]);
  });
});

const root = join(import.meta.dir, `.thread-koda-proxies-${crypto.randomUUID()}`);
const homeDir = join(root, 'runner-home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-koda-job-1';
const threadId = 'thread-koda-1';
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

/** One ThreadJobRun for a REPO (default) or PROJECT session that records what the session opener was handed. */
function sessionRun(kind: 'REPO' | 'PROJECT' | undefined, descriptors: KodaToolDescriptor[] | undefined, caller: KodaToolCaller | undefined) {
  const thread: ThreadAssign = {
    threadId, action: 'SESSION', ...(kind === undefined ? {} : { kind }), feature: `thread-${threadId}`, resume: false,
    instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
    skills: [skill], initialMessage: { messageId: 'm1', text: 'hi' },
    ...(descriptors === undefined ? {} : { kodaTools: descriptors }),
  };
  const journal = Journal.open(':memory:');
  journal.insertJob({ assign: assignFor('THREAD', { jobId, thread }), leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const opened: Array<Record<string, unknown>> = [];
  const host = {
    sessions: { async open(input: Record<string, unknown>) {
      opened.push(input);
      return { ok: true as const, session: idleSession, resumed: false };
    } },
    credentials: {
      async acquire() { return { ok: true as const, credentials: { helper: '/job/git-cred', binDir: null } }; },
      async release() { /* nothing to give back */ },
    },
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { return { ok: true as const, worktree: join(root, 'wt'), tipSha: 'b'.repeat(40) }; },
    async ensureSkills() { return { ok: true as const }; },
    ...(caller === undefined ? {} : { kodaTools: caller }),
  };
  const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = { journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'), sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning };
  return { journal, opened, run: new ThreadJobRun(deps, jobId, leaseEpoch) };
}

/** Starts one run, waits until the session is open, then reads the tool names the opener was handed. */
async function openerToolNames(kind: 'REPO' | 'PROJECT' | undefined, descriptors: KodaToolDescriptor[] | undefined, caller: KodaToolCaller | undefined): Promise<string[]> {
  const context1 = sessionRun(kind, descriptors, caller);
  await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
  const starting = context1.run.start('prepare');
  await waitFor(() => context1.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
  const tools = (context1.opened.at(-1)?.['tools'] ?? []) as Array<{ name: string }>;
  context1.run.halt();
  await starting;
  context1.journal.close();
  return tools.map((tool) => tool.name);
}

const hostCaller = (): KodaToolCaller => ({ call: async () => ({ content: 'ok', isError: false }) });
const descriptorNames = (): string[] => DESCRIPTORS.map((descriptor) => descriptor.name);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ThreadJobRun koda tool session sets (US-006 AC-11, AC-12, AC-15, AC-16)', () => {
  test('US-006 kodaTools AC-11: a REPO session appends one proxy per descriptor after the base tools', async () => {
    expect(await openerToolNames(undefined, DESCRIPTORS, hostCaller()))
      .toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file', 'write_doc', ...descriptorNames()]);
  });

  test('US-006 kodaTools AC-12: a PROJECT session appends one proxy per descriptor after the skill tools', async () => {
    expect(await openerToolNames('PROJECT', DESCRIPTORS, hostCaller()))
      .toEqual(['load_skill', 'read_skill_file', ...descriptorNames()]);
  });

  test('US-006 kodaTools AC-15: with no descriptors the kind\'s own tools are unchanged', async () => {
    expect(await openerToolNames(undefined, undefined, hostCaller()))
      .toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file', 'write_doc']);
    expect(await openerToolNames('PROJECT', undefined, hostCaller())).toEqual(['load_skill', 'read_skill_file']);
  });

  test('US-006 kodaTools AC-15: an empty descriptor list leaves the kind\'s own tools unchanged', async () => {
    expect(await openerToolNames(undefined, [], hostCaller()))
      .toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file', 'write_doc']);
    expect(await openerToolNames('PROJECT', [], hostCaller())).toEqual(['load_skill', 'read_skill_file']);
  });

  test('US-006 kodaTools AC-16: descriptors with no host caller leave the kind\'s own tools unchanged', async () => {
    expect(await openerToolNames(undefined, DESCRIPTORS, undefined))
      .toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file', 'write_doc']);
    expect(await openerToolNames('PROJECT', DESCRIPTORS, undefined)).toEqual(['load_skill', 'read_skill_file']);
  });

  test('US-006 kodaTools: the appended proxy answers through the host caller with the ASSIGN\'s job id and lease epoch', async () => {
    const { calls, caller } = recordingCaller(async () => ({ content: 'WEB-1: fix login', isError: false }));
    const context1 = sessionRun('PROJECT', DESCRIPTORS, caller);
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const starting = context1.run.start('prepare');
    await waitFor(() => context1.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    const tools = (context1.opened.at(-1)?.['tools'] ?? []) as EmbedderTool[];
    const signal = new AbortController().signal;
    const answer = await tools[2]?.run({ ref: 'WEB-1' }, context('c9', signal));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ jobId, leaseEpoch, name: 'koda_get_ticket', toolCallId: 'c9', input: { ref: 'WEB-1' } });
    expect(calls[0]?.signal).toBe(signal);
    expect(answer).toEqual({ content: 'WEB-1: fix login', isError: false });
    context1.run.halt();
    await starting;
    context1.journal.close();
  });
});
