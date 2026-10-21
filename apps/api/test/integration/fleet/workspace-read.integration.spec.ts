/** US-004: WORKSPACE read routes, commands and the creator-only events stream (PG, real HTTP stack). */
import type { AddressInfo } from 'net';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { openSse, type SseConnection } from '../../helpers/sse-client';
import { LiveStreamRegistry } from '../../../src/live/live-stream-registry';
import { ThreadEventBus } from '../../../src/live/thread-event-bus';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';

const describeDb = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await sleep(20);
  }
}

describeDb('workspace read routes, commands and events (us-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let baseUrl: string;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  let agentKey: string;
  let registry: LiveStreamRegistry;
  let streams: SseConnection[] = [];
  /** dev's own workspace thread, and the three threads that must stay invisible to the /threads routes. */
  let mine: string;
  let otherUsersThread: string;
  let repoThread: string;
  let projectThread: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const message = (res: request.Response, expected: string) => { expect(res.body.ret).not.toBe(0); expect(res.body.message).toBe(expected); };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    config = app.get(FLEET_CFG, { strict: false });
    config.threadsEnabled = true;
    registry = app.get(LiveStreamRegistry);
    agentKey = (await seedFleetHttpAgent(server, world.tokens.root)).apiKey;

    const createWorkspace = async (token: string, title: string): Promise<string> => data<{ id: string }>(
      await request(server).post('/api/threads').set(as(token))
        .send({ title, backend: { kind: 'native' }, homeProject: 'web' }).expect(201),
    ).id;
    mine = await createWorkspace(world.tokens.dev, 'Mine');
    otherUsersThread = await createWorkspace(world.tokens.root, 'Root');
    repoThread = data<{ id: string }>(await request(server).post('/api/projects/web/threads').set(as(world.tokens.dev))
      .send({ repoId: world.repoId, feature: 'us004-repo', title: 'Repo', backend: { kind: 'native' } }).expect(201)).id;
    projectThread = data<{ id: string }>(await request(server).post('/api/projects/web/threads').set(as(world.tokens.dev))
      .send({ kind: 'PROJECT', title: 'Project', backend: { kind: 'native' } }).expect(201)).id;

    // Inserted out of seq order: the route's ordering, not insertion or createdAt order, is what AC-7 asserts.
    await prisma.chatMessage.create({ data: { threadId: mine, seq: 2, role: 'assistant', content: 'second', status: 'complete' } });
    await prisma.chatMessage.create({ data: { threadId: mine, seq: 1, role: 'user', content: 'first', status: 'complete' } });
  }, 60_000);

  afterEach(async () => {
    streams.forEach((conn) => conn.close());
    streams = [];
    await waitFor(() => registry.activeFor(world.ids.dev) === 0 && registry.activeFor(world.ids.root) === 0);
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1/AC-2/AC-3: lists only the caller’s workspace threads, each with its home project', async () => {
    const list = data<{ items: Array<{ id: string; kind: string; homeProject: { slug: string; name: string } }>; threadsEnabled: boolean }>(
      await request(server).get('/api/threads').set(as(world.tokens.dev)).expect(200),
    );
    const ids = list.items.map((item) => item.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(otherUsersThread);
    expect(ids).not.toContain(repoThread);
    expect(ids).not.toContain(projectThread);
    expect(list.items.every((item) => item.kind === 'WORKSPACE')).toBe(true);
    expect(list.items.find((item) => item.id === mine)?.homeProject).toEqual({ slug: 'web', name: 'web' });
    expect(list.threadsEnabled).toBe(true);
  });

  it('AC-13: the creator raises the cap and reads the home project back', async () => {
    const thread = data<{ maxCostUsd: string; homeProject: { slug: string; name: string } }>(
      await request(server).patch(`/api/threads/${mine}`).set(as(world.tokens.dev)).send({ maxCostUsd: 7 }).expect(200),
    );
    expect(thread.maxCostUsd).toBe('7');
    expect(thread.homeProject).toEqual({ slug: 'web', name: 'web' });
  });

  it('AC-5: the creator reads the thread with kind WORKSPACE and an empty handoff', async () => {
    const thread = data<{ kind: string; handoff: unknown; homeProject: { slug: string } }>(
      await request(server).get(`/api/threads/${mine}`).set(as(world.tokens.dev)).expect(200),
    );
    expect(thread.kind).toBe('WORKSPACE');
    expect(thread.handoff).toEqual({ plan: null, run: null });
    expect(thread.homeProject.slug).toBe('web');
  });

  it('AC-4: a global admin who did not create the thread is answered 404', async () => {
    message(await request(server).get(`/api/threads/${mine}`).set(as(world.tokens.root)).expect(404), 'Thread not found');
  });

  it('AC-6: a PROJECT thread stays invisible on the workspace route, even for its creator', async () => {
    message(await request(server).get(`/api/threads/${projectThread}`).set(as(world.tokens.dev)).expect(404), 'Thread not found');
  });

  it('AC-7: returns the transcript in seq order', async () => {
    const list = data<{ items: Array<{ seq: number; content: string }> }>(
      await request(server).get(`/api/threads/${mine}/messages`).set(as(world.tokens.dev)).expect(200),
    );
    expect(list.items.map((item) => [item.seq, item.content])).toEqual([[1, 'first'], [2, 'second']]);
  });

  it('AC-8: another user gets 404 for the transcript', async () => {
    message(await request(server).get(`/api/threads/${mine}/messages`).set(as(world.tokens.root)).expect(404), 'Thread not found');
  });

  it('AC-9/AC-10: an agent API key is refused on the list and create routes by the workspace key it does not hold', async () => {
    // Permissions P1 US-003: the principal-type refusal is gone; the seeded `agent` role holds no
    // `thread.workspace.read` or `thread.workspace.create`, so the key refuses the request.
    message(await request(server).get('/api/threads').set(as(agentKey)).expect(403), 'You do not have permissions to perform this action');
    message(await request(server).post('/api/threads').set(as(agentKey))
      .send({ title: 'Agent', backend: { kind: 'native' } }).expect(403), 'You do not have permissions to perform this action');
  });

  it('AC-11: the creator opens the event stream and receives thread events', async () => {
    const conn = await openSse(`${baseUrl}/api/threads/${mine}/events`, world.tokens.dev);
    streams.push(conn);
    expect(conn.status).toBe(200);
    expect(conn.contentType).toContain('text/event-stream');
    await conn.next((m) => m.event === 'ready');
    expect(registry.activeFor(world.ids.dev)).toBe(1);
    app.get(ThreadEventBus).publish({ id: 'us004-1', threadId: mine, at: new Date().toISOString(), type: 'thread' });
    expect(JSON.parse((await conn.next((m) => m.event === 'thread')).data)).toMatchObject({ threadId: mine, type: 'thread' });
  });

  it('AC-12: opening someone else’s workspace stream answers 404 and uses no stream slot', async () => {
    const outer = await openSse(`${baseUrl}/api/threads/${mine}/events`, world.tokens.root);
    streams.push(outer);
    expect(outer.status).toBe(404);
    expect(JSON.parse(outer.body)).toMatchObject({ message: 'Thread not found' });
    expect(registry.activeFor(world.ids.root)).toBe(0);
    const missing = await openSse(`${baseUrl}/api/threads/no-such-thread/events`, world.tokens.dev);
    streams.push(missing);
    expect(missing.status).toBe(404);
    expect(registry.activeFor(world.ids.dev)).toBe(0);
  });

  it('AC-14: end-session without a live session answers 409', async () => {
    message(await request(server).post(`/api/threads/${mine}/end-session`).set(as(world.tokens.dev)).send({}).expect(409), 'Thread has no active session');
  });

  it('AC-15: stop by a user who did not create the thread answers 404', async () => {
    message(await request(server).post(`/api/threads/${mine}/stop`).set(as(world.tokens.root)).send({}).expect(404), 'Thread not found');
  });

  it('answers the project route’s query errors with the same 400 reasons', async () => {
    message(await request(server).get('/api/threads?status=BOGUS').set(as(world.tokens.dev)).expect(400), 'Invalid thread input: status');
    message(await request(server).get('/api/threads?size=0').set(as(world.tokens.dev)).expect(400), 'Invalid thread input: size');
    message(await request(server).get(`/api/threads/${mine}/messages?limit=0`).set(as(world.tokens.dev)).expect(400), 'Invalid thread input: messages');
  });
});
