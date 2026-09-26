/**
 * Slice 5 — GET /projects/:slug/events over real HTTP on Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/live
 */
import type { AddressInfo } from 'net';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { LiveStreamRegistry } from '../../../src/live/live-stream-registry';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { openSse, SseConnection, SseMessage } from '../../helpers/sse-client';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const HEARTBEAT_MS = 300;
const isTicket = (m: SseMessage): boolean => m.event === 'ticket';
const parsed = (m: SseMessage): Record<string, unknown> => JSON.parse(m.data) as Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(25);
  }
}

/**
 * Handler-level refusals over an SSE route surface either as an HTTP error
 * status (when the handler's rejection beats Nest's deferred SSE header
 * commit) or, once the 200/text-event-stream headers are already out, as an
 * in-stream `error` frame carrying the exception name. Accept either shape.
 */
async function expectRefused(conn: SseConnection, status: number, kind: RegExp): Promise<void> {
  if (conn.status !== 200) {
    expect(conn.status).toBe(status);
    return;
  }
  const frame = await conn.next((m) => m.event === 'ready' || m.event === 'error', HEARTBEAT_MS * 4);
  expect(frame.event).toBe('error');
  expect(frame.data).toMatch(kind);
  await waitFor(() => conn.isClosed());
}

describeIntegration('GET /projects/:slug/events (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let baseUrl: string;
  let relay: OutboxRelay;
  let registry: LiveStreamRegistry;
  let prisma: PrismaClient;
  let openStreams: SseConnection[] = [];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  const stream = async (who: string, slug = 'live'): Promise<SseConnection> => {
    const conn = await openSse(`${baseUrl}/api/projects/${slug}/events`, tokens[who]);
    openStreams = [...openStreams, conn];
    return conn;
  };
  const dispatch = (): Promise<unknown> => relay.dispatchPendingBatch();

  beforeAll(async () => {
    await resetDb();
    const saved = process.env.LIVE_HEARTBEAT_MS;
    process.env.LIVE_HEARTBEAT_MS = String(HEARTBEAT_MS);
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      if (saved === undefined) delete process.env.LIVE_HEARTBEAT_MS;
      else process.env.LIVE_HEARTBEAT_MS = saved;
    }
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay = app.get(OutboxRelay);
    registry = app.get(LiveStreamRegistry);
    prisma = app.get(PrismaService).client as PrismaClient;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Live', slug: 'live', key: 'LIV' }).expect(201);
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Other', slug: 'other', key: 'OTH' }).expect(201);

    for (const who of ['dev', 'capper', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    for (const who of ['dev', 'capper']) {
      await request(server).post('/api/projects/live/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' }).expect(201);
    }

    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Live Bot', slug: 'live-bot', roles: ['DEVELOPER'] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;
  });

  afterEach(async () => {
    openStreams.forEach((conn) => conn.close());
    openStreams = [];
    await waitFor(() => registry.activeFor(ids.dev) === 0 && registry.activeFor(ids.capper) === 0);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a member gets ready, then created and transitioned events carrying the TicketEvent id', async () => {
    const conn = await stream('dev');
    expect(conn.status).toBe(200);
    await conn.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/live/tickets').set(auth('root')).send({ type: 'BUG', title: 'Live one' }).expect(201);
    await request(server).post('/api/projects/live/tickets/LIV-1/verify').set(auth('root')).send({ body: 'ok' }).expect(200);
    await dispatch();

    // Match on content: an outbox re-delivery from an earlier test could arrive first.
    const created = parsed(await conn.next((m) => isTicket(m) && parsed(m).action === 'created'));
    const transitioned = parsed(await conn.next((m) => isTicket(m) && parsed(m).action === 'transitioned'
      && parsed(m).ticketId === created.ticketId));
    expect(created).toEqual(expect.objectContaining({ type: 'ticket', action: 'created' }));
    expect(transitioned).toEqual(expect.objectContaining({ type: 'ticket', action: 'transitioned', ticketId: created.ticketId }));
    expect(created).not.toHaveProperty('title');

    const row = await prisma.ticketEvent.findFirst({ where: { action: 'status_changed', ticketId: String(created.ticketId) } });
    expect(transitioned.id).toBe(row?.id);
  });

  it('never delivers another project\'s events', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/other/tickets').set(auth('root')).send({ type: 'BUG', title: 'Elsewhere' }).expect(201);
    await dispatch();
    await request(server).post('/api/projects/live/tickets').set(auth('root')).send({ type: 'BUG', title: 'Here' }).expect(201);
    await dispatch();

    const otherProject = await prisma.project.findUnique({ where: { slug: 'other' } });
    const liveProject = await prisma.project.findUnique({ where: { slug: 'live' } });
    const created = parsed(await conn.next((m) => isTicket(m) && parsed(m).action === 'created'
      && parsed(m).projectId === liveProject?.id));
    expect(created.projectId).toBe(liveProject?.id);
    // Nothing from the other project was queued ahead of it.
    await expect(conn.next((m) => isTicket(m) && parsed(m).projectId === otherProject?.id, HEARTBEAT_MS)).rejects.toThrow();
  });

  it('a comment arrives as commented', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/live/tickets/LIV-1/comments').set(auth('root'))
      .send({ body: 'hello live', type: 'GENERAL' }).expect(201);
    await dispatch();

    await conn.next((m) => isTicket(m) && parsed(m).action === 'commented');
  });

  it('refuses a non-member (403), an agent (403) and no token (401)', async () => {
    await expectRefused(await stream('outsider'), 403, /forbidden/i);
    // The agent check throws before any await, so its rejection always beats
    // the header commit and maps to a real 403 status.
    expect((await stream('agent')).status).toBe(403);
    const anonymous = await fetch(`${baseUrl}/api/projects/live/events`);
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();
  });

  it('caps a user at 5 streams and frees a slot when one closes', async () => {
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => stream('capper')));
    await Promise.all(five.map((c) => c.next((m) => m.event === 'ready')));

    const sixth = await stream('capper');
    await expectRefused(sixth, 429, /throttle/i);

    five[0].close();
    await waitFor(() => registry.activeFor(ids.capper) === 4);
    const again = await stream('capper');
    expect(again.status).toBe(200);
    await again.next((m) => m.event === 'ready');
  });

  it('pings on the heartbeat', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ping', HEARTBEAT_MS * 4);
  });

  it('removing the member closes their stream within one heartbeat', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ready');

    await request(server).delete(`/api/projects/live/members/${ids.dev}`).set(auth('root')).expect(200);

    await Promise.race([conn.closed, sleep(HEARTBEAT_MS * 4)]);
    expect(conn.isClosed()).toBe(true);
    await waitFor(() => registry.activeFor(ids.dev) === 0);
  });
});
