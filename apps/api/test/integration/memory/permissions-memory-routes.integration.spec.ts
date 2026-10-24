import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-008 — the memory and timeline routes decide with catalog keys, a memory write may
 * only supersede an item the caller may replace, and every principal-driven write records its owner's
 * type (AC-1 .. AC-15, over real HTTP, real Postgres and the real permission service).
 *
 * The bug being closed (review C/SEC-2): any member — a Viewer too — could write memory, and a write
 * silently superseded another principal's item because `MemoryItem.ownerId` said nothing about which
 * table it named. This story keys the five routes, adds `ownerType`, and makes the supersede a
 * `memory.update` decision on the item's owner.
 *
 * Every caller below has exactly one permission source in `p1`: one PROJECT-scope binding and no
 * `ProjectMember` row (users), or that binding plus the `viewer` binding its `AgentProject` roster row
 * stood for (agents). No test asserts through a bypass — the refusals are the guard's and the
 * controller's own, and the stored rows are read back from the database the handlers write.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/memory/permissions-memory-routes.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const P2_SLUG = 'p2';
const P2_KEY = 'PTWO';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;
const MCP_ENABLED = 'MCP_ENABLED';
const ACCEPT = 'application/json, text/event-stream';

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;
/** `tickets.404`, the sentence a ticket that is not there answers with. */
const TICKET_NOT_FOUND = readI18n('tickets')['404'] as string;

/** The custom PROJECT role of AC-13: it reaches the project and reads tickets, nothing else. */
const TICKET_READER_ROLE = 'p1-ticket-reader';

/** One memory row as the database holds it, narrowed to the fields these cases assert. */
interface MemoryRow { id: string; ownerId: string | null; ownerType: string | null; status: string; object: string | null }

/** An MCP `tools/call` result: the SDK's text parts. */
interface McpAnswer { isError: boolean; content: Array<{ type: string; text: string }> }

describeIntegration('memory route keys and item ownership (US-008)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let memoryRepository: PrismaMemoryItemRepository;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const agentKeys: Record<string, string> = {};
  let savedMcpEnabled: string | undefined;
  let p1Id = '';
  let p2Id = '';
  let p1TicketId = '';
  let p2TicketId = '';

  const as = (who: string, method: 'get' | 'post', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set({ Authorization: `Bearer ${tokens[who]}` });
    return body === undefined ? req : req.send(body);
  };

  /** `POST /memory` in `p1` with a FACT item of the named key. */
  const postMemory = (who: string, key: { subject: string; predicate: string; object?: string }, extra: Record<string, unknown> = {}) =>
    as(who, 'post', '/api/memory', {
      projectId: p1Id, kind: 'FACT', subject: key.subject, predicate: key.predicate,
      ...(key.object === undefined ? {} : { object: key.object }), ...extra,
    });

  /** Every memory row of one project key, newest first. */
  const rows = (subject: string, predicate: string): Promise<MemoryRow[]> =>
    prisma.memoryItem.findMany({
      where: { projectId: p1Id, kind: 'FACT', subject, predicate },
      orderBy: { createdAt: 'desc' },
      select: { id: true, ownerId: true, ownerType: true, status: true, object: true },
    });

  /** The one row of the key that is still active, if any. */
  const activeRow = async (subject: string, predicate: string): Promise<MemoryRow | undefined> =>
    (await rows(subject, predicate)).find((row) => row.status === 'active');

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    resetThrottle(app);
    const created = await as('root', 'post', '/api/admin/users', {
      email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    ids[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    // Permissions P1 US-004: the fixture principal is granted through bindings only — the member
    // baseline production writes for every user it creates.
    await grantBaseline(prisma, { type: 'USER', id: ids[who] });
  };

  /** The binding that is the caller's only permission source in p1. */
  const bind = (principal: { type: 'USER' | 'AGENT'; id: string }, roleKey: string): Promise<unknown> =>
    membership.createBinding({ principal, roleKey, projectId: p1Id }, { type: 'SYSTEM', id: 'test' });

  const createUserWithBinding = async (who: string, roleKey: string): Promise<void> => {
    await createUser(who);
    await bind({ type: 'USER', id: ids[who] }, roleKey);
  };

  /** An agent whose only permission source in p1 is one binding: a viewer binding plus that binding, no agent role. */
  const createAgent = async (slug: string, roleKey: string): Promise<void> => {
    const created = await as('root', 'post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    ids[slug] = body.agent.id;
    // The agent's key authenticates as the agent on every route, as a user's JWT does (`CombinedAuthGuard`).
    tokens[slug] = body.apiKey;
    agentKeys[slug] = body.apiKey;
    // Permissions P1 US-004: the roster row is a role binding — the baseline every agent production
    // creates carries, plus the viewer reach the `AgentProject` row stood for.
    await grantBaseline(prisma, { type: 'AGENT', id: body.agent.id });
    await grantRole(prisma, { type: 'AGENT', id: body.agent.id }, 'viewer', p1Id);
    await bind({ type: 'AGENT', id: body.agent.id }, roleKey);
  };

  /** One MCP `tools/call` by an agent's key; the JSON-RPC body is read from the SSE `data:` line. */
  const mcpCall = async (apiKey: string, name: string, args: Record<string, unknown>): Promise<McpAnswer> => {
    const res = await request(server).post('/api/mcp').set('Accept', ACCEPT)
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    const dataLine = res.text.split('\n').find((line) => line.startsWith('data:')) ?? '';
    const body = String(res.headers['content-type']).includes('text/event-stream')
      ? JSON.parse(dataLine.slice(5))
      : res.body;
    return body.result as McpAnswer;
  };

  const textOf = (answer: McpAnswer): string => answer.content.map((part) => part.text).join('\n');

  beforeAll(async () => {
    savedMcpEnabled = process.env[MCP_ENABLED];
    process.env[MCP_ENABLED] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    memoryRepository = app.get(PrismaMemoryItemRepository);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;
    // Permissions P1 US-004: the fixture principal is granted through bindings only — the member
    // baseline production writes for every user it creates.
    await grantBaseline(prisma, { type: 'USER', id: ids.root });

    p1Id = data<{ id: string }>(await as('root', 'post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201)).id;
    p2Id = data<{ id: string }>(await as('root', 'post', '/api/projects', { name: 'P2', slug: P2_SLUG, key: P2_KEY }).expect(201)).id;
    p1TicketId = (await prisma.ticket.create({ data: {
      projectId: p1Id, number: 1, type: 'BUG', status: 'CREATED', priority: 'MEDIUM', title: 'P1 bug',
    } })).id;
    p2TicketId = (await prisma.ticket.create({ data: {
      projectId: p2Id, number: 1, type: 'BUG', status: 'CREATED', priority: 'MEDIUM', title: 'P2 bug',
    } })).id;

    // US-001: `project.read` admits the caller to the project; the memory keys are what the routes then
    // refuse for this role.
    await prisma.role.create({ data: { key: TICKET_READER_ROLE, name: TICKET_READER_ROLE, scope: 'PROJECT', system: false, permissions: ['project.read', 'ticket.read'] } });

    // AC-2, AC-4, AC-5, AC-7, AC-15: two developers, one of whom owns the item the other may not replace.
    await createUserWithBinding('dev1', 'developer');
    await createUserWithBinding('dev2', 'developer');
    // AC-1, AC-9, AC-12: a viewer reads the project and writes nothing.
    await createUserWithBinding('viewer', 'viewer');
    // AC-6, AC-10: a project admin, with no global role of its own.
    await createUserWithBinding('padmin', 'project-admin');
    // AC-13: a custom role that holds ticket.read and nothing memory-shaped.
    await createUserWithBinding('reader', TICKET_READER_ROLE);
    // AC-3, AC-14: an agent whose only permission source in p1 is a developer binding.
    await createAgent('p1-mem-agent', 'developer');

    // The rows were written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (savedMcpEnabled === undefined) delete process.env[MCP_ENABLED];
      else process.env[MCP_ENABLED] = savedMcpEnabled;
    }
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: ids.root },
      { type: 'USER', id: ids.dev1 },
      { type: 'USER', id: ids.dev2 },
      { type: 'USER', id: ids.viewer },
      { type: 'USER', id: ids.padmin },
      { type: 'USER', id: ids.reader },
      { type: 'AGENT', id: ids['p1-mem-agent'] },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — the write key and the owner it records
  // -------------------------------------------------------------------------

  it('AC-1: a viewer binding is refused memory.create on POST /memory and stores no item', async () => {
    expectPermissionsRefusal(await postMemory('viewer', { subject: 'ac1:viewer', predicate: 'uses', object: 'x' }));

    expect(await rows('ac1:viewer', 'uses')).toEqual([]);
  }, TIMEOUT);

  it('AC-2: a developer binding creates the item and is recorded as its USER owner', async () => {
    await postMemory('dev1', { subject: 'ac2:dev', predicate: 'uses', object: 'NestJS' }).expect(201);

    const stored = await activeRow('ac2:dev', 'uses');
    expect(stored).toMatchObject({ ownerId: ids.dev1, ownerType: 'USER', object: 'NestJS' });
  }, TIMEOUT);

  it('AC-3: an agent developer binding creates the item and is recorded as an AGENT owner', async () => {
    await postMemory('p1-mem-agent', { subject: 'ac3:agent', predicate: 'uses', object: 'Bun' }).expect(201);

    const stored = await activeRow('ac3:agent', 'uses');
    expect(stored).toMatchObject({ ownerId: ids['p1-mem-agent'], ownerType: 'AGENT', object: 'Bun' });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 / AC-6 / AC-7 — the replace rule
  // -------------------------------------------------------------------------

  it('AC-4: another developer binding is refused the replace and the item stays active', async () => {
    await postMemory('dev1', { subject: 'ac4:shared', predicate: 'uses', object: 'first' }).expect(201);
    const owned = await activeRow('ac4:shared', 'uses');

    expectPermissionsRefusal(await postMemory('dev2', { subject: 'ac4:shared', predicate: 'uses', object: 'stolen' }));

    expect(await activeRow('ac4:shared', 'uses')).toEqual(owned);
    expect(owned).toMatchObject({ ownerId: ids.dev1, status: 'active', object: 'first' });
  }, TIMEOUT);

  it('AC-5: the owner replaces its own item and the old item becomes superseded', async () => {
    await postMemory('dev1', { subject: 'ac5:own', predicate: 'uses', object: 'v1' }).expect(201);
    const before = await activeRow('ac5:own', 'uses');

    await postMemory('dev1', { subject: 'ac5:own', predicate: 'uses', object: 'v2' }).expect(201);

    const all = await rows('ac5:own', 'uses');
    expect(all.filter((row) => row.status === 'active').map((row) => row.object)).toEqual(['v2']);
    expect(all.find((row) => row.id === before?.id)?.status).toBe('superseded');
  }, TIMEOUT);

  it('AC-6: a project-admin binding replaces another user\'s item and the old item becomes superseded', async () => {
    await postMemory('dev1', { subject: 'ac6:admin', predicate: 'uses', object: 'v1' }).expect(201);
    const before = await activeRow('ac6:admin', 'uses');

    await postMemory('padmin', { subject: 'ac6:admin', predicate: 'uses', object: 'v2' }).expect(201);

    const all = await rows('ac6:admin', 'uses');
    expect(all.filter((row) => row.status === 'active').map((row) => row.object)).toEqual(['v2']);
    expect(all.find((row) => row.id === before?.id)?.status).toBe('superseded');
    expect(await activeRow('ac6:admin', 'uses')).toMatchObject({ ownerId: ids.padmin });
  }, TIMEOUT);

  it('AC-7: a developer binding is refused a replace of a system item (ownerType null)', async () => {
    // A system writer passes no replace check and stores no owner type — the outbox subscriber's path.
    await memoryRepository.upsert({
      projectId: p1Id, kind: 'FACT', subject: 'ac7:system', predicate: 'uses', object: 'system value',
    });
    const systemRow = await activeRow('ac7:system', 'uses');
    expect(systemRow).toMatchObject({ ownerType: null, status: 'active' });

    expectPermissionsRefusal(await postMemory('dev1', { subject: 'ac7:system', predicate: 'uses', object: 'hijack' }));

    expect(await activeRow('ac7:system', 'uses')).toEqual(systemRow);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-8 / AC-15 — the extract route: the ticket check and the all-or-nothing pre-check
  // -------------------------------------------------------------------------

  it('AC-8: an extract event naming a ticket of another project answers 404 tickets and stores nothing', async () => {
    const res = await as('dev1', 'post', '/api/memory/extract', {
      projectId: p1Id, type: 'ticket_event', id: 'evt-ac8', ticketId: p2TicketId,
      action: 'status_changed', data: { newStatus: 'IN_PROGRESS' },
    });

    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(TICKET_NOT_FOUND);
    expect(await rows(`ticket:${p2TicketId}`, 'status')).toEqual([]);
  }, TIMEOUT);

  it('AC-15: an extract whose item would supersede another user\'s item answers 403 and stores nothing', async () => {
    // The extracted fact of a `status_changed` ticket event is `FACT ticket:<id> status`.
    await postMemory('dev1', {
      subject: `ticket:${p1TicketId}`, predicate: 'status', object: 'CREATED',
    }).expect(201);
    const owned = await activeRow(`ticket:${p1TicketId}`, 'status');

    const res = await as('dev2', 'post', '/api/memory/extract', {
      projectId: p1Id, type: 'ticket_event', id: 'evt-ac15', ticketId: p1TicketId,
      action: 'status_changed', data: { newStatus: 'IN_PROGRESS' },
    });

    expectPermissionsRefusal(res);
    expect(await activeRow(`ticket:${p1TicketId}`, 'status')).toEqual(owned);
    expect(owned).toMatchObject({ ownerId: ids.dev1, status: 'active', object: 'CREATED' });
    expect(await prisma.memoryItem.count({ where: { projectId: p1Id, sourceId: 'evt-ac15' } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 — the decisions route's key
  // -------------------------------------------------------------------------

  it('AC-9: a viewer binding is refused memory.decision.record on POST /memory/decisions', async () => {
    expectPermissionsRefusal(await as('viewer', 'post', '/api/memory/decisions', {
      projectId: p1Id, topic: 'ac9', decision: 'no',
    }));

    expect(await prisma.memoryItem.count({ where: { projectId: p1Id, predicate: 'ac9' } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 / AC-11 — who may attribute an item to someone else
  // -------------------------------------------------------------------------

  it('AC-10: a project-admin binding without a global role stores the item under the caller', async () => {
    await postMemory('padmin', { subject: 'ac10:attribute', predicate: 'uses' }, { ownerId: ids.dev1 }).expect(201);

    expect(await activeRow('ac10:attribute', 'uses')).toMatchObject({ ownerId: ids.padmin, ownerType: 'USER' });
  }, TIMEOUT);

  it('AC-11: a global admin attributes the item to another user and it is stored with a null owner type', async () => {
    await postMemory('root', { subject: 'ac11:attribute', predicate: 'uses' }, { ownerId: ids.dev1 }).expect(201);

    expect(await activeRow('ac11:attribute', 'uses')).toMatchObject({ ownerId: ids.dev1, ownerType: null });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-12 / AC-13 — the two read routes
  // -------------------------------------------------------------------------

  it('AC-12: a viewer binding reads the project memory and timeline', async () => {
    await as('viewer', 'get', `/api/projects/${P1_SLUG}/memory`).expect(200);
    await as('viewer', 'get', `/api/projects/${P1_SLUG}/timeline`).expect(200);
  }, TIMEOUT);

  it('AC-13: a custom role holding only ticket.read is refused both read routes', async () => {
    expectPermissionsRefusal(await as('reader', 'get', `/api/projects/${P1_SLUG}/memory`));
    expectPermissionsRefusal(await as('reader', 'get', `/api/projects/${P1_SLUG}/timeline`));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 — the tool refuses a supersede it may not make, before anything is stored
  // -------------------------------------------------------------------------

  it('AC-14: koda_add_memory over MCP is refused a key another principal owns, and the item stays active', async () => {
    await postMemory('dev1', { subject: 'ac14:tool', predicate: 'uses', object: 'owned' }).expect(201);
    const owned = await activeRow('ac14:tool', 'uses');

    const answer = await mcpCall(agentKeys['p1-mem-agent'], 'koda_add_memory', {
      project: P1_SLUG, kind: 'FACT', subject: 'ac14:tool', predicate: 'uses', object: 'hijack',
    });

    expect(textOf(answer)).toBe('forbidden: koda_add_memory needs memory.update on p1');
    expect(answer.isError).toBe(true);
    expect(await activeRow('ac14:tool', 'uses')).toEqual(owned);
  }, TIMEOUT);
});
