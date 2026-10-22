/**
 * Permissions P1 US-006 — a ticket link records who created it, and the links routes check
 * `ticket.link.add`, `ticket.link.read` and `ticket.link.remove` (with the row's creator, so
 * `ticket.link.remove.own` is honoured), over real HTTP + Postgres (AC-1 .. AC-12).
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, tickets, agent bindings) are built as that Owner; every assertion
 * below acts as a principal whose only source in `p1` is one role binding (users and agents). No
 * test asserts through a bypass.
 *
 * The creator columns are internal (`TicketLinkResponseDto` does not expose them), so the "what was
 * stored" half of AC-1 .. AC-4 reads the row through Prisma.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-ticket-links.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { TicketLinksService } from '../../../src/ticket-links/ticket-links.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

const readI18n = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, string>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'];
/** `ticket-links.404`, the sentence an unknown link answers with. */
const LINK_NOT_FOUND = readI18n('ticket-links')['404'];

type RoleKey = 'developer' | 'viewer' | 'project-admin';

interface LinkDto {
  id: string;
  url: string;
  provider: string;
}

describeIntegration('ticket link creators and route keys (US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let linksService: TicketLinksService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let counter = 0;
  let rootId = '';
  let agentId = '';

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

  /** A ticket built by the Owner. */
  const createTicket = async (): Promise<string> => {
    const created = await asRoot('post', `/api/projects/${P1_SLUG}/tickets`, {
      type: 'BUG',
      title: `links ${(counter += 1)}`,
    }).expect(201);
    return data<{ ref: string }>(created).ref;
  };

  /** A fresh URL per call: link rows are unique on (ticketId, url). */
  const newUrl = () => `https://github.com/owner/repo/pull/${(counter += 1)}`;

  const postLink = (who: string, ref: string, url: string) =>
    request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/links`)
      .set(auth(who))
      .send({ url });

  /** A link created through the real route by `who`; returns its id. */
  const linkBy = async (who: string, ref: string, url = newUrl()): Promise<string> => {
    const res = await postLink(who, ref, url).expect(201);
    return data<LinkDto>(res).id;
  };

  /** The links of a ticket, read by the Owner, so a mutation can be checked independently. */
  const links = async (ref: string): Promise<LinkDto[]> => {
    const res = await asRoot('get', `/api/projects/${P1_SLUG}/tickets/${ref}/links`).expect(200);
    return data<LinkDto[]>(res);
  };

  /** The stored row: the creator columns are internal and absent from the response DTO. */
  const linkRow = async (id: string) =>
    db.ticketLink.findUniqueOrThrow({
      where: { id },
      select: { id: true, createdByUserId: true, createdByAgentId: true },
    });

  /** The creatorless path: no principal, exactly how the assistant link tool calls the service. */
  const linkWithoutCreator = async (ref: string): Promise<string> => {
    const result = await linksService.create(P1_SLUG, ref, { url: newUrl() });
    expect(result.status).toBe(201);
    return result.link.id;
  };

  /** A rostered agent with a `developer` binding in p1 — its only source of p1 keys. */
  const createDeveloperAgent = async (slug: string): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    await grantRole(db, agent, 'developer', p1Id);
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
    linksService = app.get(TicketLinksService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['developer', 'developer2', 'viewer', 'padmin', 'outsider']) {
      await createUser(who);
    }

    const project = await asRoot('post', '/api/projects', {
      name: 'P1',
      slug: P1_SLUG,
      key: P1_KEY,
    }).expect(201);
    p1Id = data<{ id: string }>(project).id;

    await bind('developer', 'developer');
    await bind('developer2', 'developer');
    await bind('viewer', 'viewer');
    await bind('padmin', 'project-admin');
    // AC-11's caller keeps no source in p1 at all.

    // AC-2's caller: a viewer binding plus a developer binding in p1.
    agentId = await createDeveloperAgent('p1-links-agent');
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
      { type: 'USER', id: userIds.developer },
      { type: 'USER', id: userIds.developer2 },
      { type: 'USER', id: userIds.viewer },
      { type: 'USER', id: userIds.padmin },
      { type: 'USER', id: userIds.outsider },
      { type: 'AGENT', id: agentId },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-4 — the creator is recorded when the caller is known, and left null when not
  // -------------------------------------------------------------------------

  it('AC-1: POST …/links by a developer binding stores the caller as createdByUserId', async () => {
    const ref = await createTicket();

    const res = await postLink('developer', ref, newUrl()).expect(201);
    const link = data<LinkDto>(res);

    expect(link.url).toBeDefined();
    await expect(linkRow(link.id)).resolves.toEqual({
      id: link.id,
      createdByUserId: userIds.developer,
      createdByAgentId: null,
    });
  }, TIMEOUT);

  it('AC-2: POST …/links by an agent with a legacy DEVELOPER entry stores createdByAgentId', async () => {
    const ref = await createTicket();

    const res = await postLink('p1-links-agent', ref, newUrl()).expect(201);
    const link = data<LinkDto>(res);

    await expect(linkRow(link.id)).resolves.toEqual({
      id: link.id,
      createdByUserId: null,
      createdByAgentId: agentId,
    });
  }, TIMEOUT);

  it('AC-3: POST …/links with an existing url answers 200 and keeps the original creator', async () => {
    const ref = await createTicket();
    const url = newUrl();
    const firstName = await linkBy('developer', ref, url);

    const res = await postLink('developer2', ref, url).expect(200);

    expect(data<LinkDto>(res).id).toBe(firstName);
    await expect(linkRow(firstName)).resolves.toEqual({
      id: firstName,
      createdByUserId: userIds.developer,
      createdByAgentId: null,
    });
  }, TIMEOUT);

  it('AC-4: TicketLinksService.create without a creator stores both creator columns null', async () => {
    const ref = await createTicket();

    const id = await linkWithoutCreator(ref);

    await expect(linkRow(id)).resolves.toEqual({ id, createdByUserId: null, createdByAgentId: null });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 .. AC-8 — DELETE …/links/:linkId needs ticket.link.remove, or .own on the caller's link
  // -------------------------------------------------------------------------

  it('AC-5: a developer binding alone deletes its own link', async () => {
    const ref = await createTicket();
    const id = await linkBy('developer', ref);

    await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}/links/${id}`)
      .set(auth('developer'))
      .expect(204);

    await expect(links(ref)).resolves.toEqual([]);
  }, TIMEOUT);

  it("AC-6: a developer binding alone is refused by DELETE on another user's link and the link remains", async () => {
    const ref = await createTicket();
    const id = await linkBy('developer2', ref);

    const res = await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}/links/${id}`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(links(ref)).resolves.toEqual([expect.objectContaining({ id })]);
  }, TIMEOUT);

  it('AC-7: a developer binding alone is refused by DELETE on a creatorless link and the link remains', async () => {
    const ref = await createTicket();
    const id = await linkWithoutCreator(ref);

    const res = await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}/links/${id}`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(links(ref)).resolves.toEqual([expect.objectContaining({ id })]);
  }, TIMEOUT);

  it("AC-8: a project-admin binding alone deletes another user's link", async () => {
    const ref = await createTicket();
    const id = await linkBy('developer', ref);

    await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}/links/${id}`)
      .set(auth('padmin'))
      .expect(204);

    await expect(links(ref)).resolves.toEqual([]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 .. AC-11 — POST needs ticket.link.add, GET needs ticket.link.read
  // -------------------------------------------------------------------------

  it('AC-9: a viewer binding alone is refused by POST …/links and writes no link', async () => {
    const ref = await createTicket();

    const res = await postLink('viewer', ref, newUrl());

    expectPermissionsRefusal(res);
    await expect(links(ref)).resolves.toEqual([]);
  }, TIMEOUT);

  it('AC-10: a viewer binding alone lists the links with GET …/links', async () => {
    const ref = await createTicket();
    const id = await linkBy('developer', ref);

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}/links`)
      .set(auth('viewer'))
      .expect(200);

    expect(data<LinkDto[]>(res).map((link) => link.id)).toEqual([id]);
  }, TIMEOUT);

  it('AC-11: a non-admin with no source in p1 gets 403 projects from GET …/links', async () => {
    const ref = await createTicket();

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}/links`)
      .set(auth('outsider'));

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    // `projects` has no 40003 sentence, so the i18n lookup answers the key itself.
    expect(res.body.message).toBe('projects.40003');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-12 — the link lookup comes before the key check, so an unknown id is still a 404
  // -------------------------------------------------------------------------

  it('AC-12: DELETE …/links/<unknown id> by a project admin answers 404 ticket-links', async () => {
    const ref = await createTicket();

    const res = await request(server)
      .delete(`/api/projects/${P1_SLUG}/tickets/${ref}/links/unknown-link-id`)
      .set(auth('padmin'));

    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(LINK_NOT_FOUND);
  }, TIMEOUT);
});
