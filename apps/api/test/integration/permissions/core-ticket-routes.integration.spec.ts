/**
 * Permissions P1 US-004 — create, read, update, delete and assign on the ticket routes check their
 * catalog key, and `allowedActions` follows the caller's edge keys, over real HTTP + Postgres
 * (AC-1 .. AC-16).
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, tickets, agent bindings) are built as that Owner; every assertion
 * below acts as a principal whose only source in `p1` is one role binding (users and agents, with and
 * without a second agent role binding). No test asserts through a bypass.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-ticket-routes.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>
)['40003'];

type RoleKey = 'reviewer' | 'triager' | 'developer' | 'viewer' | 'project-admin';
type TicketState = 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX';

/** The role key an agent's legacy `AgentRoleEntry` role is read as (the union's own mapping). */
const ROLE_KEY_FOR_AGENT_ROLE: Record<'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER', string> = {
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
  VERIFIER: 'verifier',
  TRIAGER: 'triager',
};

interface TicketDetail {
  ref: string;
  title: string;
  status: string;
  allowedActions: string[];
  assignee: { kind: string; id: string; name: string } | null;
}

describeIntegration('ticket CRUD route keys (US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let counter = 0;
  let rootId = '';
  const agentIds: string[] = [];

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
      role: 'MEMBER',
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: RoleKey): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    );

  /** A ticket built by the Owner, walked to `status` through the real routes. */
  const ticketIn = async (status: TicketState): Promise<string> => {
    const created = await asRoot('post', `/api/projects/${P1_SLUG}/tickets`, {
      type: 'BUG',
      title: `route ${(counter += 1)}`,
    }).expect(201);
    const ref = data<{ ref: string }>(created).ref;
    const step = (action: string, body?: Record<string, unknown>) =>
      asRoot('post', `/api/projects/${P1_SLUG}/tickets/${ref}/${action}`, body ?? {}).expect(200);

    if (status !== 'CREATED') await step('verify', { body: 'verified' });
    if (status === 'IN_PROGRESS' || status === 'VERIFY_FIX') await step('start');
    if (status === 'VERIFY_FIX') await step('fix', { body: 'fixed' });
    return ref;
  };

  /** The detail the Owner sees: status, title, assignee and the caller-independent row state. */
  const detail = async (ref: string): Promise<TicketDetail> => {
    const res = await asRoot('get', `/api/projects/${P1_SLUG}/tickets/${ref}`).expect(200);
    return data<TicketDetail>(res);
  };

  /** How many tickets p1 holds, read through the list route as the Owner. */
  const ticketCount = async (): Promise<number> => {
    const res = await asRoot('get', `/api/projects/${P1_SLUG}/tickets`).expect(200);
    return data<{ total: number }>(res).total;
  };

  /** A rostered agent: a `viewer` binding in p1 is its only source there until `agentRole` adds one. */
  const createAgent = async (slug: string, agentRole?: 'REVIEWER' | 'DEVELOPER'): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    if (agentRole) await grantRole(db, agent, ROLE_KEY_FOR_AGENT_ROLE[agentRole], p1Id);
    tokens[slug] = body.apiKey;
    // The bindings are written after the principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['viewer', 'developer', 'triager', 'reviewer', 'padmin']) await createUser(who);

    const project = await asRoot('post', '/api/projects', {
      name: 'P1',
      slug: P1_SLUG,
      key: P1_KEY,
    }).expect(201);
    p1Id = data<{ id: string }>(project).id;

    await bind('viewer', 'viewer');
    await bind('developer', 'developer');
    await bind('triager', 'triager');
    await bind('reviewer', 'reviewer');
    await bind('padmin', 'project-admin');

    // AC-3: a viewer binding in p1 and no agent role.
    agentIds.push(await createAgent('p1-legacy-agent'));
    // AC-8: a viewer binding plus a developer binding in p1.
    agentIds.push(await createAgent('p1-developer-agent', 'DEVELOPER'));
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(db, [
      { type: 'USER', id: rootId },
      { type: 'USER', id: userIds.viewer },
      { type: 'USER', id: userIds.developer },
      { type: 'USER', id: userIds.triager },
      { type: 'USER', id: userIds.reviewer },
      { type: 'USER', id: userIds.padmin },
      ...agentIds.map((id) => ({ type: 'AGENT' as const, id })),
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — POST …/tickets needs ticket.create
  // -------------------------------------------------------------------------

  it('AC-1: a viewer binding alone is refused by POST …/tickets and no ticket is created', async () => {
    const before = await ticketCount();

    const denied = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets`)
      .set(auth('viewer'))
      .send({ type: 'BUG', title: 'from a viewer' });

    expectPermissionsRefusal(denied);
    await expect(ticketCount()).resolves.toBe(before);
  }, TIMEOUT);

  it('AC-2: a developer binding alone creates a ticket with POST …/tickets', async () => {
    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets`)
      .set(auth('developer'))
      .send({ type: 'BUG', title: 'from a developer' })
      .expect(201);

    const ticket = data<{ ref: string; title: string; createdByUserId: string }>(res);
    expect(ticket.title).toBe('from a developer');
    // The developer is the actor, not the Owner: the row records the developer as its creator.
    expect(ticket.createdByUserId).toBe(userIds.developer);
    await expect(detail(ticket.ref)).resolves.toEqual(expect.objectContaining({ title: 'from a developer' }));
  }, TIMEOUT);

  it('AC-3: an agent with a roster row and no AgentRoleEntry is refused by POST …/tickets and creates nothing', async () => {
    const before = await ticketCount();

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets`)
      .set(auth('p1-legacy-agent'))
      .send({ type: 'BUG', title: 'from an agent' });

    expectPermissionsRefusal(res);
    await expect(ticketCount()).resolves.toBe(before);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 — a viewer reads the list and the detail
  // -------------------------------------------------------------------------

  it('AC-4: a viewer binding alone lists the tickets of p1', async () => {
    const res = await request(server).get(`/api/projects/${P1_SLUG}/tickets`).set(auth('viewer')).expect(200);

    const page = data<{ total: number; records: unknown[] }>(res);
    expect(page.total).toBeGreaterThan(0);
    expect(page.records.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('AC-5: a viewer binding alone reads one ticket of p1', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('viewer'))
      .expect(200);

    expect(data<TicketDetail>(res).ref).toBe(ref);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 / AC-8 — DELETE …/tickets/:ref needs ticket.delete
  // -------------------------------------------------------------------------

  it('AC-6: a developer binding alone is refused by DELETE …/tickets/:ref and nothing is soft-deleted', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(detail(ref)).resolves.toEqual(expect.objectContaining({ ref }));
  }, TIMEOUT);

  it('AC-7: a project-admin binding alone deletes the ticket', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('padmin'))
      .expect(200);

    expect(data<{ deletedAt: string | null }>(res).deletedAt).not.toBeNull();
    // Soft-deleted: the detail route no longer answers it, and the list does not carry it.
    await request(server).get(`/api/projects/${P1_SLUG}/tickets/${ref}`).set(auth('root')).expect(404);
  }, TIMEOUT);

  it('AC-8: an agent with a roster row and an AgentRoleEntry DEVELOPER is refused by DELETE …/tickets/:ref', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('p1-developer-agent'));

    expectPermissionsRefusal(res);
    await expect(detail(ref)).resolves.toEqual(expect.objectContaining({ ref }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 / AC-11 — PATCH …/tickets/:ref needs ticket.update (no status change)
  // -------------------------------------------------------------------------

  it('AC-9: a triager binding alone renames a ticket through PATCH …/tickets/:ref', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('triager'))
      .send({ title: 'Renamed' })
      .expect(200);

    expect(data<{ title: string }>(res).title).toBe('Renamed');
    await expect(detail(ref)).resolves.toEqual(expect.objectContaining({ title: 'Renamed' }));
  }, TIMEOUT);

  it('AC-11: a viewer binding alone is refused by PATCH …/tickets/:ref and the title is unchanged', async () => {
    const ref = await ticketIn('CREATED');
    const before = await detail(ref);

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('viewer'))
      .send({ title: 'Renamed' });

    expectPermissionsRefusal(res);
    await expect(detail(ref)).resolves.toEqual(expect.objectContaining({ title: before.title }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 / AC-12 — POST …/assign needs ticket.assign
  // -------------------------------------------------------------------------

  it('AC-10: a triager binding alone assigns the ticket to a user who has a developer binding', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/assign`)
      .set(auth('triager'))
      .send({ userId: userIds.developer })
      .expect(200);

    expect(data<{ assignee: unknown }>(res).assignee)
      .toEqual(expect.objectContaining({ kind: 'user', id: userIds.developer }));
    await expect(detail(ref)).resolves.toEqual(
      expect.objectContaining({ assignee: expect.objectContaining({ id: userIds.developer }) }),
    );
  }, TIMEOUT);

  it('AC-12: a viewer binding alone is refused by POST …/assign and nobody is assigned', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/assign`)
      .set(auth('viewer'))
      .send({ userId: userIds.developer });

    expectPermissionsRefusal(res);
    await expect(detail(ref)).resolves.toEqual(expect.objectContaining({ assignee: null }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 .. AC-16 — allowedActions is the intersection of the status rules and the caller's keys
  // -------------------------------------------------------------------------

  it('AC-13: a developer binding alone sees exactly [fix, close] on an IN_PROGRESS ticket', async () => {
    const ref = await ticketIn('IN_PROGRESS');

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('developer'))
      .expect(200);

    expect(data<TicketDetail>(res).allowedActions).toEqual(['fix', 'close']);
  }, TIMEOUT);

  it('AC-14: a reviewer binding alone sees exactly [verify-fix, close] on a VERIFY_FIX ticket', async () => {
    const ref = await ticketIn('VERIFY_FIX');

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('reviewer'))
      .expect(200);

    expect(data<TicketDetail>(res).allowedActions).toEqual(['verify-fix', 'close']);
  }, TIMEOUT);

  it('AC-15: a reviewer binding alone sees no action on a CREATED ticket', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('reviewer'))
      .expect(200);

    expect(data<TicketDetail>(res).allowedActions).toEqual([]);
  }, TIMEOUT);

  it('AC-16: a viewer binding alone sees no action on a CREATED ticket', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('viewer'))
      .expect(200);

    expect(data<TicketDetail>(res).allowedActions).toEqual([]);
  }, TIMEOUT);
});
