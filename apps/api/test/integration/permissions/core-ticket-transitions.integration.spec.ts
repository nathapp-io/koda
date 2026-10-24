import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-003 — the six transition routes and `PATCH …/tickets/:ref` enforce one key per
 * state-machine edge, over real HTTP + Postgres (AC-9 .. AC-20).
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, tickets, agent bindings) are built as that Owner; every assertion
 * below acts as an ordinary principal whose only source in `p1` is one role binding (users) or a
 * viewer plus an agent role binding (agents). No test asserts through a bypass.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-ticket-transitions.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>
)['40003'];
/** `tickets.-2`, the sentence `validateTransition`'s 400 carries. */
const INVALID_TRANSITION = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/tickets.json'), 'utf8')) as Record<string, string>
)['-2'];

type RoleKey = 'reviewer' | 'triager' | 'developer' | 'viewer';
type TicketState = 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX';

/** The role key an agent's legacy `AgentRoleEntry` role is read as (the union's own mapping). */
const ROLE_KEY_FOR_AGENT_ROLE: Record<'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER', string> = {
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
  VERIFIER: 'verifier',
  TRIAGER: 'triager',
};

describeIntegration('ticket transition edge keys (US-003)', () => {
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
      title: `edge ${(counter += 1)}`,
    }).expect(201);
    const ref = data<{ ref: string }>(created).ref;
    const step = (action: string, body?: Record<string, unknown>) =>
      asRoot('post', `/api/projects/${P1_SLUG}/tickets/${ref}/${action}`, body ?? {}).expect(200);

    if (status !== 'CREATED') await step('verify', { body: 'verified' });
    if (status === 'IN_PROGRESS' || status === 'VERIFY_FIX') await step('start');
    if (status === 'VERIFY_FIX') await step('fix', { body: 'fixed' });
    return ref;
  };

  const ticketState = async (ref: string, as = 'root'): Promise<{ status: string; title: string }> => {
    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth(as))
      .expect(200);
    return data<{ status: string; title: string }>(res);
  };

  /** A rostered agent with a `viewer` binding plus its role binding in p1: its only sources there. */
  const createAgent = async (slug: string, agentRole: 'REVIEWER' | 'DEVELOPER'): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    await grantRole(db, agent, ROLE_KEY_FOR_AGENT_ROLE[agentRole], p1Id);
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

    for (const who of ['reviewer', 'triager', 'developer', 'viewer']) await createUser(who);

    const project = await asRoot('post', '/api/projects', {
      name: 'P1',
      slug: P1_SLUG,
      key: P1_KEY,
    }).expect(201);
    p1Id = data<{ id: string }>(project).id;

    await bind('reviewer', 'reviewer');
    await bind('triager', 'triager');
    await bind('developer', 'developer');
    await bind('viewer', 'viewer');

    agentIds.push(await createAgent('p1-reviewer-agent', 'REVIEWER'));
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
      { type: 'USER', id: userIds.reviewer },
      { type: 'USER', id: userIds.triager },
      { type: 'USER', id: userIds.developer },
      { type: 'USER', id: userIds.viewer },
      ...agentIds.map((id) => ({ type: 'AGENT' as const, id })),
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-9 / AC-10 — a reviewer approves or returns a fix
  // -------------------------------------------------------------------------

  it('AC-9: a reviewer binding alone approves VERIFY_FIX -> CLOSED on POST …/verify-fix?approve=true', async () => {
    const ref = await ticketIn('VERIFY_FIX');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/verify-fix?approve=true`)
      .set(auth('reviewer'))
      .send({ body: 'lgtm' })
      .expect(200);

    expect(data<{ status: string }>(res).status).toBe('CLOSED');
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'CLOSED' }));
  }, TIMEOUT);

  it('AC-10: a reviewer binding alone returns VERIFY_FIX -> IN_PROGRESS on POST …/verify-fix (no approve)', async () => {
    const ref = await ticketIn('VERIFY_FIX');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/verify-fix`)
      .set(auth('reviewer'))
      .send({ body: 'not ready' })
      .expect(200);

    expect(data<{ status: string }>(res).status).toBe('IN_PROGRESS');
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'IN_PROGRESS' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 / AC-12 / AC-13 — the route key and the edge key both have to pass
  // -------------------------------------------------------------------------

  it('AC-11: a reviewer binding alone is refused by POST …/verify on a CREATED ticket (no route key)', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/verify`)
      .set(auth('reviewer'))
      .send({ body: 'verified' });

    expectPermissionsRefusal(res);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'CREATED' }));
  }, TIMEOUT);

  it('AC-12: a triager binding alone is refused by POST …/verify on a VERIFY_FIX ticket (edge key needs approve)', async () => {
    const ref = await ticketIn('VERIFY_FIX');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/verify`)
      .set(auth('triager'))
      .send({ body: 'verified' });

    expectPermissionsRefusal(res);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'VERIFY_FIX' }));
  }, TIMEOUT);

  it('AC-13: a triager binding alone is refused by POST …/verify-fix?approve=true (route keys are approve|return)', async () => {
    const ref = await ticketIn('VERIFY_FIX');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/verify-fix?approve=true`)
      .set(auth('triager'))
      .send({ body: 'lgtm' });

    expectPermissionsRefusal(res);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'VERIFY_FIX' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 / AC-15 — close is guarded by its own key only
  // -------------------------------------------------------------------------

  it('AC-14: a developer binding alone closes an IN_PROGRESS ticket through POST …/close', async () => {
    const ref = await ticketIn('IN_PROGRESS');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/close`)
      .set(auth('developer'))
      .send({ body: 'duplicate' })
      .expect(200);

    expect(data<{ status: string }>(res).status).toBe('CLOSED');
  }, TIMEOUT);

  it('AC-15: a viewer binding alone is refused by POST …/close on an IN_PROGRESS ticket', async () => {
    const ref = await ticketIn('IN_PROGRESS');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/close`)
      .set(auth('viewer'))
      .send({ body: 'duplicate' });

    expectPermissionsRefusal(res);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'IN_PROGRESS' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-16 / AC-17 — an agent's legacy rows decide its keys
  // -------------------------------------------------------------------------

  it('AC-16: an agent rostered in p1 with AgentRoleEntry REVIEWER is refused by POST …/start on a VERIFIED ticket', async () => {
    const ref = await ticketIn('VERIFIED');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/start`)
      .set(auth('p1-reviewer-agent'))
      .send({});

    expectPermissionsRefusal(res);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'VERIFIED' }));
  }, TIMEOUT);

  it('AC-17: an agent rostered in p1 with AgentRoleEntry DEVELOPER moves an IN_PROGRESS ticket to VERIFY_FIX', async () => {
    const ref = await ticketIn('IN_PROGRESS');

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/fix`)
      .set(auth('p1-developer-agent'))
      .send({ body: 'fixed by the agent' })
      .expect(200);

    expect(data<{ status: string }>(res).status).toBe('VERIFY_FIX');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-18 / AC-19 / AC-20 — PATCH with status
  // -------------------------------------------------------------------------

  it('AC-18: a developer binding alone starts a CREATED ticket through PATCH { status }', async () => {
    const ref = await ticketIn('CREATED');

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('developer'))
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    expect(data<{ status: string }>(res).status).toBe('IN_PROGRESS');
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'IN_PROGRESS' }));
  }, TIMEOUT);

  it('AC-19: a triager binding alone is refused by PATCH { status, title } and no field is written', async () => {
    const ref = await ticketIn('CREATED');
    const before = await ticketState(ref);

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('triager'))
      .send({ status: 'IN_PROGRESS', title: 'Renamed' });

    expectPermissionsRefusal(res);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'CREATED', title: before.title }));
  }, TIMEOUT);

  it('AC-20: PATCH { status: CLOSED } on an IN_PROGRESS ticket is a 400 with no edge key checked', async () => {
    const ref = await ticketIn('IN_PROGRESS');

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('developer'))
      .send({ status: 'CLOSED' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(INVALID_TRANSITION);
    await expect(ticketState(ref)).resolves.toEqual(expect.objectContaining({ status: 'IN_PROGRESS' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // B3 (whole-branch review) — the field write and the checked transition are one operation
  // -------------------------------------------------------------------------

  it('B3: a status move that outraces the PATCH between the pre-check and the transition writes no field', async () => {
    // A caller holding project access, ticket.update and ticket.transition.start but not verify-fix.return:
    // the pair it asks for (CREATED -> IN_PROGRESS) is allowed on the ticket it read, and refused on the
    // ticket the concurrent writer left behind (VERIFY_FIX -> IN_PROGRESS needs verify-fix.return).
    await createUser('interleaved');
    const role = await db.role.create({
      data: {
        key: 'b3-starter',
        name: 'B3 Starter',
        scope: 'PROJECT',
        permissions: ['project.read', 'ticket.read', 'ticket.update', 'ticket.transition.start'],
      },
    });
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userIds.interleaved,
        roleId: role.id,
        projectId: p1Id,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });
    await membership.invalidatePermissions();

    const ref = await ticketIn('CREATED');
    const before = await ticketState(ref);
    expect(before.status).toBe('CREATED');

    const transitions = app.get(TicketTransitionsService);
    const precheck = transitions.assertTransitionAllowed.bind(transitions);
    const spy = vi.spyOn(transitions, 'assertTransitionAllowed').mockImplementation(async (...args) => {
      await precheck(...args);
      // The other actor walks the ticket to VERIFY_FIX through the real routes, between the PATCH's
      // pre-check and its transition.
      await asRoot('post', `/api/projects/${P1_SLUG}/tickets/${ref}/start`).expect(200);
      await asRoot('post', `/api/projects/${P1_SLUG}/tickets/${ref}/fix`, { body: 'fixed meanwhile' }).expect(200);
    });
    try {
      const res = await request(server)
        .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
        .set(auth('interleaved'))
        .send({ status: 'IN_PROGRESS', title: 'Renamed by a refused PATCH' });

      expectPermissionsRefusal(res);
    } finally {
      spy.mockRestore();
    }

    // The refusal wrote nothing: no new title, and the concurrent writer's status stands.
    await expect(ticketState(ref)).resolves.toEqual(
      expect.objectContaining({ status: 'VERIFY_FIX', title: before.title }),
    );
     }, TIMEOUT);
});
