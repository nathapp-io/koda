/** Content-carrying thread SSE events (PG). */
import type { AddressInfo } from 'net';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines, seedThreadJob, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { openSse, SseConnection, SseMessage } from '../../helpers/sse-client';
import { LiveStreamRegistry } from '../../../src/live/live-stream-registry';

const describeDb = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
type LivePayload = Record<string, unknown>;
const payload = (m: SseMessage): LivePayload => JSON.parse(m.data) as LivePayload;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await sleep(20);
  }
}

// Per-AC checklist: AC1 bus routing (same thread + other thread); AC2 split PUT delta; AC3
// same-batch accumulation; AC4 turn completion; AC5 input consumption; AC6 reset suppresses delta;
// AC7 question; AC8 session; AC9 priced usage; AC10 unrelated thread isolation; AC11 agent refusal;
// AC12 outsider refusal; AC13 cross-project 404; AC14 shared stream limit.
describeDb('Content thread events over HTTP (PG, US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let baseUrl: string;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let agentKey: string;
  let registry: LiveStreamRegistry;
  let streams: SseConnection[] = [];

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'thread-events-runner');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true } });
    agentKey = (await seedFleetHttpAgent(server, world.tokens.root)).apiKey;
    registry = app.get(LiveStreamRegistry);
  }, 30_000);

  afterEach(async () => {
    streams.forEach((s) => s.close());
    streams = [];
    await waitFor(() => registry.activeFor(world.ids.dev) === 0 && registry.activeFor(world.ids.viewer) === 0);
  });
  afterAll(async () => { await app?.close(); });

  const stream = async (threadId: string, token = world.tokens.viewer, expectedStatus = 200): Promise<SseConnection> => {
    const conn = await openSse(`${baseUrl}/api/projects/web/threads/${threadId}/events`, token);
    streams.push(conn);
    expect(conn.status).toBe(expectedStatus);
    return conn;
  };
  const nextLiveOf = (conn: SseConnection, type: string) => conn.next((m) => m.event === type);
  const fresh = async (name: string, pending: string[] = []): Promise<ThreadJobSeed> => {
    const feature = `us006-${name}`;
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature, title: 'Thread events',
      createdById: world.ids.dev, runnerId: runner.runnerId, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: `.nax/features/${feature}/spec.md`,
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], selectorLabels: [], maxCostUsd: 5, requestedById: world.ids.dev, state: 'RUNNING',
      runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: thread.id,
    } });
    await prisma.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    for (const [index, text] of pending.entries()) {
      await prisma.chatMessage.create({ data: { threadId: thread.id, seq: index + 1, role: 'user', authorUserId: world.ids.dev, content: text, status: 'pending' } });
    }
    if (pending.length) await prisma.chatThread.update({ where: { id: thread.id }, data: { nextSeq: pending.length + 1 } });
    return { threadId: thread.id, jobId: job.id, runnerId: runner.runnerId, runnerKey: runner.apiKey, feature };
  };
  const put = (s: ThreadJobSeed, lines: object[], offset = 0) =>
    putThreadLines(server, s.runnerKey, { id: s.jobId }, lines.map((line) => JSON.stringify(line)), offset);
  const start = (turnId = 't1') => ({ type: 'turn_start', turnId });
  const delta = (text: string, round = 1) => ({ type: 'text_delta', turnId: 't1', round, text });
  const end = () => ({ type: 'turn_end', turnId: 't1', status: 'completed', output: 'Hello', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0 });

  it('US-006 AC1: routes a published event only to listeners for its thread', async () => {
    let bus: (new () => { subscribe: (id: string, cb: (event: { threadId: string }) => void) => () => void; publish: (event: { id: string; threadId: string; at: string; type: 'thread' }) => void }) | undefined;
    try {
      bus = (await import('../../../src/live/thread-event-bus')).ThreadEventBus;
    } catch {
      // The assertion below reports the missing behavior instead of an import error.
    }
    expect(typeof bus).toBe('function');
    const instance = new (bus as new () => { subscribe: (id: string, cb: (event: { threadId: string }) => void) => () => void; publish: (event: { id: string; threadId: string; at: string; type: 'thread' }) => void })();
    const received: string[] = [];
    instance.subscribe('a', (event) => received.push(event.threadId));
    instance.publish({ id: 'e1', threadId: 'a', at: new Date().toISOString(), type: 'thread' });
    instance.publish({ id: 'e2', threadId: 'b', at: new Date().toISOString(), type: 'thread' });
    expect(received).toEqual(['a']);
  });

  it('US-006 AC2: emits a delta after a separate text_delta PUT', async () => {
    const s = await fresh('ac2');
    const conn = await stream(s.threadId);
    expect(conn.status).toBe(200);
    await conn.next((m) => m.event === 'ready');
    const first = JSON.stringify(start());
    await put(s, [start()]);
    const offset = Buffer.byteLength(`${first}\n`);
    await put(s, [delta('Hi')], offset);
    const message = payload(await nextLiveOf(conn, 'delta'));
    const assistant = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId: 't1', role: 'assistant' } });
    expect(message).toMatchObject({ type: 'delta', threadId: s.threadId, messageId: assistant.id, text: 'Hi' });
  });

  it('US-006 AC3: combines same-batch text deltas into one delta event', async () => {
    const s = await fresh('ac3');
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(s, [start(), delta('Hel'), delta('lo')]);
    const event = payload(await nextLiveOf(conn, 'delta'));
    const assistant = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId: 't1', role: 'assistant' } });
    expect(event).toMatchObject({ messageId: assistant.id, text: 'Hello' });
  });

  it('US-006 AC4: emits the assistant message id when a turn ends', async () => {
    const s = await fresh('ac4');
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(s, [start(), end()]);
    const event = payload(await nextLiveOf(conn, 'message'));
    const assistant = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId: 't1', role: 'assistant' } });
    expect(event).toMatchObject({ type: 'message', messageId: assistant.id });
  });

  it('US-006 AC5: emits a message event when a pending user input is consumed', async () => {
    const s = await fresh('ac5', ['queued']);
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    const userMessage = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, role: 'user' } });
    await put(s, [{ type: 'input_consumed', messageId: userMessage.id }]);
    expect(payload(await nextLiveOf(conn, 'message'))).toMatchObject({ messageId: userMessage.id });
  });

  it('US-006 AC6: reset emits the message update without publishing discarded delta text', async () => {
    const s = await fresh('ac6');
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(s, [start(), delta('abc'), { type: 'stream_reset', turnId: 't1', round: 1 }]);
    const event = payload(await nextLiveOf(conn, 'message'));
    const assistant = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId: 't1', role: 'assistant' } });
    expect(event.messageId).toBe(assistant.id);
    await expect(conn.next((m) => m.event === 'delta' && payload(m).messageId === assistant.id, 200)).rejects.toThrow();
  });

  it('US-006 AC7: emits the answerable question request id and text', async () => {
    const s = await fresh('ac7');
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(s, [start(), { type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: new Date(Date.now() + 60_000).toISOString(), answerable: true }]);
    expect(payload(await nextLiveOf(conn, 'question'))).toMatchObject({ requestId: 'q1', text: 'Which repo?' });
  });

  it('US-006 AC8: emits a thread event for session_started', async () => {
    const s = await fresh('ac8');
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(s, [{ type: 'session_started', resumed: false }]);
    expect(payload(await nextLiveOf(conn, 'thread'))).toMatchObject({ threadId: s.threadId, type: 'thread' });
  });

  it('US-006 AC9: emits a thread event for priced usage', async () => {
    const s = await fresh('ac9');
    const conn = await stream(s.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(s, [start(), { type: 'usage', turnId: 't1', round: 1, inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 }]);
    expect(payload(await nextLiveOf(conn, 'thread'))).toMatchObject({ threadId: s.threadId, type: 'thread' });
  });

  it("US-006 AC10: does not let another thread's fold consume this stream's event", async () => {
    const target = await fresh('ac10-target');
    const other = await fresh('ac10-other');
    const conn = await stream(target.threadId);
    await conn.next((m) => m.event === 'ready');
    await put(other, [{ type: 'session_started', resumed: false }]);
    await put(target, [{ type: 'session_started', resumed: false }]);
    expect(payload(await nextLiveOf(conn, 'thread')).threadId).toBe(target.threadId);
  });

  it('US-006 AC11: refuses a rostered agent API key with 403', async () => {
    const s = await fresh('ac11');
    const conn = await stream(s.threadId, agentKey, 403);
    expect(conn.status).toBe(403);
  });

  it('US-006 AC12: refuses a project outsider with 403', async () => {
    const s = await fresh('ac12');
    const conn = await stream(s.threadId, world.tokens.outsider, 403);
    expect(conn.status).toBe(403);
  });

  it('US-006 AC13: hides a thread in another project from root with 404', async () => {
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.opsProjectId, repoId: world.foreignRepoId, baseRef: 'main', feature: 'us006-ops', title: 'Ops thread',
      createdById: world.ids.root, backend: { kind: 'native', model: 'm1' }, skills: [], specPath: '.nax/features/us006-ops/spec.md',
    } });
    const conn = await stream(thread.id, world.tokens.root, 404);
    expect(conn.body).not.toContain('Cannot GET');
  });

  it('US-006 AC14: counts thread streams against the shared per-user live stream limit', async () => {
    const s = await fresh('ac14');
    const projectStreams: SseConnection[] = [];
    for (let i = 0; i < 10; i += 1) {
      const conn = await openSse(`${baseUrl}/api/projects/web/events`, world.tokens.dev);
      streams.push(conn);
      projectStreams.push(conn);
    }
    await Promise.all(projectStreams.map((conn) => conn.next((m) => m.event === 'ready')));
    const extra = await stream(s.threadId, world.tokens.dev, 429);
    expect(extra.status).toBe(429);
  });
});
