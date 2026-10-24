/**
 * Permissions P1 US-007 — the seven KB/retrieval routes decide with catalog keys, and the two write
 * routes enforce own-vs-any row ownership (AC-1 .. AC-15, over real HTTP, real Postgres and the real
 * permission service).
 *
 * The bug being closed (review C/SEC-1): a KB write replaced every row that shared a `source_id`
 * regardless of who wrote it, so any agent or Developer could overwrite rows the ticket indexer or the
 * code graph owned. US-006 keyed the rows by `(source, source_id)` and recorded the creator; this
 * story makes the routes read the keys and the creator.
 *
 * Every caller below has exactly one source in `p1`: one PROJECT-scope binding, and no `ProjectMember`
 * row anywhere. No test asserts through a bypass — the refusals are the guards' own, and the rows are
 * read back through the same `RagService` the handlers write with.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/rag/permissions-kb-routes.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { CommonExceptionCode } from '@nathapp/nestjs-common';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { RagService } from '../../../src/rag/rag.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { asTestActor, expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;

interface KbRow { source: string; sourceId: string; content: string }

describeIntegration('knowledge-base route keys and row ownership (US-007)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let rag: RagService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let p1Id = '';
  let n = 0;

  const as = (who: string, method: 'get' | 'post' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set({ Authorization: `Bearer ${tokens[who]}` });
    return body === undefined ? req : req.send(body);
  };
  const kbUrl = (suffix = '') => `/api/projects/${P1_SLUG}/kb${suffix}`;
  /** `POST /projects/p1/kb/documents` and the two write routes that follow it. */
  const documentsUrl = (suffix = '') => kbUrl(`/documents${suffix}`);

  /** The KB rows of one `(source, sourceId)` pair, read through the store the handlers write. */
  const rows = async (source: string, sourceId: string): Promise<KbRow[]> =>
    (await rag.listDocuments(p1Id, 500)).filter((row) => row.source === source && row.sourceId === sourceId);

  const totalRows = async (): Promise<number> => (await rag.listDocuments(p1Id, 500)).length;

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

  /** The binding that is the caller's only source in p1. */
  const bind = (principal: { type: 'USER' | 'AGENT'; id: string }, roleKey: string): Promise<unknown> =>
    membership.createBinding({ principal, roleKey, projectId: p1Id }, { type: 'SYSTEM', id: 'test' });

  const createUserWithBinding = async (who: string, roleKey: string): Promise<void> => {
    await createUser(who);
    await bind({ type: 'USER', id: ids[who] }, roleKey);
  };

  /** An agent whose only source in p1 is one binding: a viewer binding plus that binding, and no agent role. */
  const createAgent = async (slug: string, roleKey: string): Promise<string> => {
    const created = await as('root', 'post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    tokens[slug] = body.apiKey;
    // Permissions P1 US-004: the roster row is a role binding — the baseline every agent production
    // creates carries, plus the viewer reach the `AgentProject` row stood for.
    await grantBaseline(prisma, { type: 'AGENT', id: body.agent.id });
    await grantRole(prisma, { type: 'AGENT', id: body.agent.id }, 'viewer', p1Id);
    await bind({ type: 'AGENT', id: body.agent.id }, roleKey);
    // The rows are written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  beforeAll(async () => {
    // The fake provider keeps the suite off the network; it is refused in production by rag.config.
    const previousProvider = process.env['EMBEDDING_PROVIDER'];
    process.env['EMBEDDING_PROVIDER'] = 'fake';
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    } finally {
      if (previousProvider === undefined) delete process.env['EMBEDDING_PROVIDER'];
      else process.env['EMBEDDING_PROVIDER'] = previousProvider;
    }

    server = app.getHttpServer();
    prisma = fixtureDb(app);
    // The bindings below are fixture grants with no request principal, so the service writes as
    // `SYSTEM/seed` — the same component `fixtureDb` writes under.
    membership = asTestActor(app.get(MembershipService), { type: 'SYSTEM', id: 'seed' });
    rag = app.get(RagService);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;
    // Permissions P1 US-004: the fixture principal is granted through bindings only — the member
    // baseline production writes for every user it creates.
    await grantBaseline(prisma, { type: 'USER', id: ids.root });

    const project = await as('root', 'post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(project).id;

    await createUserWithBinding('dev1', 'developer');
    await createUserWithBinding('dev2', 'developer');
    await createUserWithBinding('viewer', 'viewer');
    await createUserWithBinding('admin', 'project-admin');
    ids.agent = await createAgent(`p1-kb-agent-${(n += 1)}`, 'developer');
  }, BOOT_TIMEOUT);

  afterAll(async () => { await app?.close(); });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: ids.root },
      { type: 'USER', id: ids.dev1 },
      { type: 'USER', id: ids.dev2 },
      { type: 'USER', id: ids.viewer },
      { type: 'USER', id: ids.admin },
      { type: 'AGENT', id: ids.agent },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 — the add route's key and its source list
  // -------------------------------------------------------------------------

  it('AC-1: a user whose only source in p1 is a viewer binding is refused kb.document.add and reads the list', async () => {
    expectPermissionsRefusal(await as('viewer', 'post', documentsUrl(), { source: 'manual', sourceId: 'm1', content: 'x' }));

    await as('viewer', 'get', documentsUrl()).expect(200);
  }, TIMEOUT);

  it('AC-2: the REST add refuses the ticket and code sources with 400 and indexes nothing', async () => {
    for (const [source, sourceId] of [['ticket', 't1'], ['code', 'c1']] as const) {
      const res = await as('dev1', 'post', documentsUrl(), { source, sourceId, content: 'x' });

      expect(res.status).toBe(400);
    }

    expect(await rows('ticket', 't1')).toEqual([]);
    expect(await rows('code', 'c1')).toEqual([]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-13 — the add route records the caller as the row creator
  // -------------------------------------------------------------------------

  it('AC-3: a developer binding adds a doc row and is recorded as its creator', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac3-d1', content: 'x' }).expect(201);

    await expect(rag.findSourceCreators(p1Id, 'doc', 'ac3-d1')).resolves.toEqual([{ type: 'USER', id: ids.dev1 }]);
  }, TIMEOUT);

  it('an agent whose only source in p1 is a developer binding is recorded as an AGENT creator', async () => {
    await as('p1-kb-agent-1', 'post', documentsUrl(), { source: 'doc', sourceId: 'agent-d1', content: 'x' }).expect(201);

    await expect(rag.findSourceCreators(p1Id, 'doc', 'agent-d1')).resolves.toEqual([{ type: 'AGENT', id: ids.agent }]);
  }, TIMEOUT);

  it('AC-13: the creator replaces its own doc row, and the row content becomes the new one', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac13-d1', content: 'x' }).expect(201);

    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac13-d1', content: 'z' }).expect(201);

    expect((await rows('doc', 'ac13-d1')).map((row) => row.content)).toEqual(['z']);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 — the replace check needs the any-row delete key
  // -------------------------------------------------------------------------

  it('AC-4: another developer binding is refused the replace, and the row keeps its content', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac4-d1', content: 'x' }).expect(201);

    expectPermissionsRefusal(
      await as('dev2', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac4-d1', content: 'y' }),
    );

    expect((await rows('doc', 'ac4-d1')).map((row) => row.content)).toEqual(['x']);
    await expect(rag.findSourceCreators(p1Id, 'doc', 'ac4-d1')).resolves.toEqual([{ type: 'USER', id: ids.dev1 }]);
  }, TIMEOUT);

  it('AC-5: a project-admin binding replaces another user\'s doc row', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac5-d1', content: 'x' }).expect(201);

    await as('admin', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac5-d1', content: 'y' }).expect(201);

    // The replace is a delete-then-add of that pair, so exactly one row is left.
    expect((await rows('doc', 'ac5-d1')).map((row) => row.content)).toEqual(['y']);
    await expect(rag.findSourceCreators(p1Id, 'doc', 'ac5-d1')).resolves.toEqual([{ type: 'USER', id: ids.admin }]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 / AC-8 / AC-9 / AC-14 — the delete route's ownership and source query
  // -------------------------------------------------------------------------

  it('AC-6: the creator deletes both user rows of its id', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac6-d1', content: 'x' }).expect(201);
    await as('dev1', 'post', documentsUrl(), { source: 'manual', sourceId: 'ac6-d1', content: 'm' }).expect(201);

    await as('dev1', 'delete', documentsUrl('/ac6-d1')).expect(200);

    expect(await rows('doc', 'ac6-d1')).toEqual([]);
    expect(await rows('manual', 'ac6-d1')).toEqual([]);
  }, TIMEOUT);

  it('AC-7: another developer binding is refused the delete of a row it did not create', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac7-d1', content: 'x' }).expect(201);

    expectPermissionsRefusal(await as('dev2', 'delete', documentsUrl('/ac7-d1?source=doc')));

    expect((await rows('doc', 'ac7-d1')).map((row) => row.content)).toEqual(['x']);
  }, TIMEOUT);

  it('AC-8: a project-admin binding deletes the user rows of an id and leaves the ticket row alone', async () => {
    // A ticket row is the ticket indexer's: written internally, with no creator (a system row).
    await rag.indexDocument(p1Id, { source: 'ticket', sourceId: 'ac8-t1', content: 'ticket row', metadata: {} });

    await as('admin', 'delete', documentsUrl('/ac8-t1?source=manual')).expect(200);

    expect((await rows('ticket', 'ac8-t1')).map((row) => row.content)).toEqual(['ticket row']);
    expect(await rows('manual', 'ac8-t1')).toEqual([]);
  }, TIMEOUT);

  it('AC-9: the delete route refuses a source outside doc and manual with 400', async () => {
    const res = await as('admin', 'delete', documentsUrl('/ac9-d1?source=ticket'));

    expect(res.status).toBe(400);
  }, TIMEOUT);

  it('AC-14: a sourceId that is not filter-safe is answered 400 and deletes nothing', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac14-keep', content: 'x' }).expect(201);
    const before = await totalRows();

    const res = await as('admin', 'delete', documentsUrl("/x'y"));

    expect(res.status).toBe(400);
    expect(await totalRows()).toBe(before);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 / AC-11 / AC-12 — search, optimize and the retrieval evaluation
  // -------------------------------------------------------------------------

  it('AC-10: search needs kb.search: a viewer binding is refused, a developer binding is admitted', async () => {
    expectPermissionsRefusal(await as('viewer', 'post', kbUrl('/search'), { query: 'x' }));

    await as('dev1', 'post', kbUrl('/search'), { query: 'x' }).expect(200);
  }, TIMEOUT);

  it('AC-11: optimize needs kb.optimize: a developer binding is refused, a project-admin binding is admitted', async () => {
    expectPermissionsRefusal(await as('dev1', 'post', kbUrl('/optimize')));

    await as('admin', 'post', kbUrl('/optimize')).expect(200);
  }, TIMEOUT);

  it('AC-12: the retrieval evaluation needs retrieval.evaluate, which a developer binding does not hold', async () => {
    expectPermissionsRefusal(await as('dev1', 'post', kbUrl('/evaluate/retrieval'), {}));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-15 — an unsafe id is a validation error before any write
  // -------------------------------------------------------------------------

  it('AC-15: an unsafe sourceId is answered 400 ValidationAppException without indexing or replacing', async () => {
    await as('dev1', 'post', documentsUrl(), { source: 'doc', sourceId: 'ac15-keep', content: 'x' }).expect(201);

    for (const source of ['doc', 'manual'] as const) {
      const res = await as('dev1', 'post', documentsUrl(), { source, sourceId: "x'y", content: 'y' });

      expect(res.status).toBe(400);
      // ValidationAppException: `ret: -2`, the envelope's request-parameter code.
      expect(res.body.ret).toBe(CommonExceptionCode.REQUEST_PARAMETER_ERROR);
    }

    expect((await rag.listDocuments(p1Id, 500)).filter((row) => row.sourceId === "x'y")).toEqual([]);
    expect((await rows('doc', 'ac15-keep')).map((row) => row.content)).toEqual(['x']);
  }, TIMEOUT);
});
