import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { waitFor } from '../helpers/wait';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpBackend } from '@nathapp/nax-agent-acp/client';
import { ThreadWorktreeOwners } from '../../src/thread/thread-worktree-owners';
import { createMemoryTranscriptStore, nativeBackend, writeTool, type BackendOpenContext } from '@nathapp/nax-agent';

function gate() {
  let release = (): void => {};
  const done = new Promise<void>((resolve) => { release = resolve; });
  return { done, release };
}

function context(dir: string, controller: AbortController): BackendOpenContext {
  return {
    sessionId: 'worktree-ownership', workdir: dir, profile: 'full', tools: [], instructions: undefined, resume: undefined,
    transcriptStore: createMemoryTranscriptStore(), asks: {
      requestApproval: async () => ({ decision: 'allow', decidedBy: 'profile' }),
      recordAutoDecision: () => {}, askQuestion: async () => null, noteQuestion: () => {},
    },
    turnSignal: () => controller.signal, currentTurnId: () => 'turn', turnTimeoutSeconds: 30, metadata: {},
    openSignal: new AbortController().signal,
  };
}

for (const revoked of [true, false]) test(`ACP releases its worktree after real child exit and ${revoked ? 'a revoked transcript' : 'a failed final transcript read'}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'koda-acp-owner-'));
  const fixture = join(dir, 'agent.cjs');
  const transcript = new AbortController();
  const exits: number[] = [];
  const failures: unknown[] = [];
  const owners = new ThreadWorktreeOwners((_id, stage, error) => failures.push({ stage, error }));
  const io = new Error('final read failed');
  const lease = await owners.acquire('thread', new AbortController().signal);
  if (!lease) throw new Error('missing initial lease');
  try {
    // A real ndjson agent. It has no network dependencies and only implements the ACP open handshake.
    await writeFile(fixture, [
      "const { createInterface } = require('node:readline');",
      "createInterface({ input: process.stdin }).on('line', line => {",
      "  const req = JSON.parse(line);",
      "  const result = req.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: 'acp-session' };",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));",
      "});",
    ].join('\n'));
    const backend = acpBackend({ agent: { name: 'owner-fixture', command: process.execPath, args: [fixture] }, allowUnsandboxed: true,
      cancelGraceMs: 100, initializeTimeoutMs: 1500, onProcess: { exited: (pid) => exits.push(pid) } });
    const ctx = context(dir, new AbortController());
    let lateRead = false;
    await lease.backend(backend, transcript.signal).open({ ...ctx, transcriptStore: {
      ...ctx.transcriptStore,
      load: async (id) => {
        if (exits.length > 0) { lateRead = true; throw revoked ? transcript.signal.reason : io; }
        return ctx.transcriptStore.load(id);
      },
    } });
    if (revoked) transcript.abort();
    lease.release();
    await Promise.all(owners.pending());
    expect(lateRead).toBe(true);
    expect(exits).toHaveLength(1);
    expect(failures).toEqual(revoked ? [] : [{ stage: 'transcript', error: io }]);
    expect(owners.activeIds()).toEqual([]);
  } finally {
    lease.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP waits for the disconnected process exit before opening a replacement', async () => {
  // Delay the transport's process-exit notification while keeping the pinned ACP protocol, launch, and kill paths.
  const internal = await import(new URL('backend.js', import.meta.resolve('@nathapp/nax-agent-acp/client')).href);
  const deps = internal._acpBackendDeps;
  const launch = deps.launch;
  const exit = gate();
  let launches = 0;
  deps.launch = (...args: unknown[]) => {
    const child = launch(...args);
    launches++;
    return launches === 1 ? { ...child, exited: child.exited.then(async (status: unknown) => { await exit.done; return status; }) } : child;
  };
  const dir = await mkdtemp(join(tmpdir(), 'koda-acp-reconnect-'));
  const fixture = join(dir, 'slow.cjs');
  try {
    await writeFile(fixture, [
      "const { createInterface } = require('node:readline');",
      "createInterface({ input: process.stdin }).on('line', line => {",
      "  const req = JSON.parse(line);",
      "  if (req.method === 'session/prompt') { require('node:fs').writeFileSync('prompt-seen', 'seen'); return; }",
      "  if (!req.id && req.id !== 0) return;",
      "  const result = req.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : { sessionId: 'before' };",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));",
      "});",
    ].join('\n'));
    const backend = acpBackend({ agent: { name: 'slow', command: process.execPath, args: [fixture] }, allowUnsandboxed: true,
      cancelGraceMs: 10, initializeTimeoutMs: 1000 });
    const controller = new AbortController();
    const opened = await backend.open(context(dir, controller));
    const send = (signal: AbortSignal) => opened.adapter.sendTurn(opened.handle, 'hello', { ...opened.turnOpts(), signal }).catch(() => {});
    const original = send(controller.signal);
    await waitFor(() => existsSync(join(dir, 'prompt-seen')));
    controller.abort();
    await original;
    const next = new AbortController();
    const pending = send(next.signal);
    await Bun.sleep(25);
    const beforeExit = launches;
    exit.release();
    await waitFor(() => launches === 2);
    next.abort();
    await pending;
    await opened.close();
    expect(beforeExit).toBe(1);
  } finally {
    exit.release();
    deps.launch = launch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed ACP handshake waits for the launched process to exit before releasing its owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'koda-acp-failed-open-'));
  const fixture = join(dir, 'invalid.cjs');
  const exits: number[] = [];
  try {
    await writeFile(fixture, [
      "const { createInterface } = require('node:readline');",
      "createInterface({ input: process.stdin }).on('line', line => {",
      "  const req = JSON.parse(line);",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: {code: -32603, message: 'failed open'} }));",
      "});",
    ].join('\n'));
    const backend = acpBackend({ agent: { name: 'failed-fixture', command: process.execPath, args: [fixture] }, allowUnsandboxed: true,
      cancelGraceMs: 100, initializeTimeoutMs: 1500, onProcess: { exited: (pid) => exits.push(pid) } });
    await expect(backend.open(context(dir, new AbortController()))).rejects.toThrow();
    expect(exits).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a physical backend shutdown failure retains only its owning thread and reports the failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'koda-owner-failure-'));
  const ctx = context(dir, new AbortController());
  const handle = await nativeBackend({ model: 'openai/gpt-5', bashApproval: 'raw', allowUnsandboxed: true }).open(ctx);
  const reports: unknown[] = [];
  const owners = new ThreadWorktreeOwners((id, stage, error) => reports.push({ id, stage, error }));
  const error = new Error('agent still running');
  const lease = await owners.acquire('one', ctx.openSignal);
  if (!lease) throw new Error('missing initial lease');
  try {
    await lease.backend({ kind: 'acp:fixture', open: async () => ({ ...handle, close: async () => { throw error; } }) }).open(ctx);
    lease.release();
    await waitFor(() => reports.length > 0);
    const independent = await owners.acquire('two', ctx.openSignal);
    independent?.release();
    expect(owners.activeIds()).toEqual(['one']);
    expect(reports).toEqual([{ id: 'one', stage: 'shutdown', error }]);
  } finally {
    await handle.adapter.closeSession(handle.handle);
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('native close drains an aborted built-in Write and refuses its pending filesystem mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'koda-native-owner-'));
  const file = join(dir, 'work.txt');
  const started = gate();
  const release = gate();
  const finished = gate();
  const turn = new AbortController();
  const original = writeTool.run;
  const spy = spyOn(writeTool, 'run').mockImplementation(async (input, ctx) => {
    started.release();
    await release.done;
    try { return await original(input, ctx); } finally { finished.release(); }
  });
  try {
    await writeFile(file, 'initial');
    const backend = nativeBackend({ model: 'openai/gpt-5', bashApproval: 'raw', allowUnsandboxed: true });
    const opened = await backend.open(context(dir, turn));
    const { interactionHandler: handler } = opened.turnOpts();
    if (!handler) throw new Error('native session has no interaction handler');
    const call = handler.onInteraction({ kind: 'coding-tool', name: 'Write', input: { path: 'work.txt', content: 'stale' }, signal: turn.signal });
    await started.done;
    turn.abort();
    await call.catch(() => {});
    let closed = false;
    const close = opened.close().then(() => { closed = true; });
    await Bun.sleep(5);
    const closedDuringWrite = closed;
    release.release();
    await finished.done;
    await close;
    expect(closedDuringWrite).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('initial');
    await expect(handler.onInteraction({ kind: 'coding-tool', name: 'Write', input: { path: 'work.txt', content: 'late' }, signal: new AbortController().signal })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('initial');
    await opened.adapter.closeSession(opened.handle);
  } finally {
    release.release();
    spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
