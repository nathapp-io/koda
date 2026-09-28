/**
 * US-002 — slug-less comment mutations and the project list are scoped to
 * project membership, and every route of the guarded matrix is verified over
 * real HTTP on Postgres.
 *
 * Covers:
 *   AC4   PATCH /api/comments/:id → 404 for the author after their membership is removed
 *   AC5   DELETE /api/comments/:id → 204 for a global ADMIN who is not a member
 *   AC10  GET /api/projects → only the projects the caller is a member of
 *   AC11  every matrix route → 403 for a non-member DEVELOPER
 *   AC12  every matrix route → a status other than 403/404 for a member DEVELOPER
 * plus the Postgres-backed forms of AC1, AC2, AC3, AC6, AC7, AC8 and AC9
 * (real repository + real membership rows, no repository double).
 *
 * Visibility only: AC11/AC12 prove the membership gate (non-member 403, member
 * not 403/404). Write routes are exercised with a global-ADMIN member so that
 * this file keeps asserting visibility, not role rights. Project-role write
 * permissions (#144) are proven in project-role-permissions.integration.spec.ts,
 * which replaces #143's waived AC-29.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-membership-gate
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CommentsService } from '../../../src/comments/comments.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import type {
  AgentPrincipal,
  UserPrincipal,
} from '../../../src/auth/principal/koda-principal.types';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const TEST_TIMEOUT_MS = 30_000;

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

interface MatrixCase {
  /** `METHOD path` as it appears in the acceptance criteria's route matrix. */
  label: string;
  method: HttpMethod;
  /** Lazy: ticket refs and label ids only exist after `beforeAll` seeded them. */
  url: () => string;
  body?: () => Record<string, unknown>;
  /** The member DEVELOPER that makes the AC12 request (see the file header). */
  member: 'dev' | 'adminMember';
}

function userPrincipal(id: string, name: string, role: 'MEMBER' | 'ADMIN'): UserPrincipal {
  return {
    actorType: 'user',
    id,
    sub: id,
    name,
    email: `${name}@koda.test`,
    role,
    blacklisted: false,
    revoked: false,
    authorities: role === 'ADMIN' ? ['ADMIN'] : ['MEMBER'],
  };
}

function agentPrincipal(agent: { id: string; slug: string }): AgentPrincipal {
  return {
    actorType: 'agent',
    id: agent.id,
    sub: agent.id,
    slug: agent.slug,
    status: 'ACTIVE',
    agentRoles: ['DEVELOPER'],
    capabilities: [],
    name: 'Team Bot',
    blacklisted: false,
    revoked: false,
    authorities: ['WORKER'],
  };
}

describeIntegration('US-002 project membership gate (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let commentsService: CommentsService;
  let projectsService: ProjectsService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const refs: Record<string, string> = {};
  const labelIds: Record<string, string> = {};
  const agent = { id: '', slug: 'team-bot', apiKey: '' };
  let rootUserId = '';
  let authorCommentId = '';
  let adminTargetCommentId = '';
  let otherCommentId = '';
  let otherCommentBaseline = '';
  let agentCommentId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  const send = (
    method: HttpMethod,
    url: string,
    who: string,
    body?: Record<string, unknown>,
  ): request.Test => {
    const req = request(server)[method](url).set(auth(who));
    return body === undefined ? req : req.send(body);
  };

  const createUser = async (who: string, role: 'MEMBER' | 'ADMIN'): Promise<string> => {
    const created = await request(server).post('/api/admin/users').set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role }).expect(201);
    const id = data<{ id: string }>(created).id;
    ids[who] = id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    return id;
  };

  const addMember = (slug: string, who: string, role: string): request.Test =>
    request(server).post(`/api/projects/${slug}/members`).set(auth('root'))
      .send({ email: `${who}@koda.test`, role });

  const createTicket = async (slug: string, title: string): Promise<string> => {
    const res = await request(server).post(`/api/projects/${slug}/tickets`).set(auth('root'))
      .send({ type: 'BUG', title }).expect(201);
    return data<{ ref: string }>(res).ref;
  };

  const transition = async (
    ref: string,
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<void> => {
    await request(server).post(`/api/projects/team/tickets/${ref}/${action}`).set(auth('root'))
      .send(payload ?? {}).expect(200);
  };

  const createLabel = async (name: string): Promise<string> => {
    const res = await request(server).post('/api/projects/team/labels').set(auth('root'))
      .send({ name, color: '#336699' }).expect(201);
    return data<{ id: string }>(res).id;
  };

  const addComment = async (
    slug: string,
    ref: string,
    who: string,
    body: string,
    token?: string,
  ): Promise<string> => {
    const res = await request(server).post(`/api/projects/${slug}/tickets/${ref}/comments`)
      .set(token ? { Authorization: `Bearer ${token}` } : auth(who))
      .send({ body, type: 'GENERAL' }).expect(201);
    return data<{ id: string }>(res).id;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get(PrismaService).client as PrismaClient;
    commentsService = app.get(CommentsService);
    projectsService = app.get(ProjectsService);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootUserId = (await prisma.user.findUnique({ where: { email: 'root@koda.test' } }))?.id ?? '';

    // dev/outside/author/multi are plain users; adminMember carries the global
    // role the project CASL factory needs for Ticket/Label writes.
    for (const who of ['dev', 'outside', 'author', 'multi']) await createUser(who, 'MEMBER');
    await createUser('adminMember', 'ADMIN');

    for (const [slug, key] of [['team', 'TEAM'], ['other', 'OTH'], ['third', 'THD'], ['softdel', 'SFT']]) {
      await request(server).post('/api/projects').set(auth('root'))
        .send({ name: slug, slug, key }).expect(201);
    }
    // The KB write routes admit a project DEVELOPER; enable graphify so the
    // import route runs its handler instead of rejecting the payload.
    await request(server).patch('/api/projects/team').set(auth('root'))
      .send({ graphifyEnabled: true }).expect(200);

    await addMember('team', 'dev', 'DEVELOPER').expect(201);
    await addMember('team', 'adminMember', 'DEVELOPER').expect(201);
    await addMember('team', 'author', 'DEVELOPER').expect(201);
    await addMember('team', 'multi', 'DEVELOPER').expect(201);
    await addMember('other', 'outside', 'DEVELOPER').expect(201);
    await addMember('other', 'multi', 'DEVELOPER').expect(201);
    await addMember('softdel', 'multi', 'DEVELOPER').expect(201);
    // Soft-delete here (not inside AC9) so every list-scoping assertion below
    // (AC6/AC7/AC8/AC9) can run independently of the others' execution order.
    await request(server).delete('/api/projects/softdel').set(auth('root')).expect(204);

    refs.get = await createTicket('team', 'Matrix target');
    refs.patch = await createTicket('team', 'Matrix patch');
    refs.remove = await createTicket('team', 'Matrix delete');
    refs.verify = await createTicket('team', 'Matrix verify');
    refs.start = await createTicket('team', 'Matrix start');
    refs.fix = await createTicket('team', 'Matrix fix');
    refs.verifyFix = await createTicket('team', 'Matrix verify-fix');
    refs.close = await createTicket('team', 'Matrix close');
    refs.reject = await createTicket('team', 'Matrix reject');
    refs.assign = await createTicket('team', 'Matrix assign');
    refs.agent = await createTicket('team', 'Matrix agent');

    await transition(refs.start, 'verify', { body: 'verified' });
    await transition(refs.fix, 'verify', { body: 'verified' });
    await transition(refs.fix, 'start');
    await transition(refs.verifyFix, 'verify', { body: 'verified' });
    await transition(refs.verifyFix, 'start');
    await transition(refs.verifyFix, 'fix', { body: 'fixed' });
    await transition(refs.close, 'verify', { body: 'verified' });
    await transition(refs.close, 'start');

    labelIds.remove = await createLabel('us002-remove');
    labelIds.update = await createLabel('us002-update');
    labelIds.delete = await createLabel('us002-delete');
    labelIds.assign = await createLabel('us002-assign');
    await request(server).post(`/api/projects/team/tickets/${refs.get}/labels`).set(auth('root'))
      .send({ labelId: labelIds.remove }).expect(201);

    authorCommentId = await addComment('team', refs.get, 'author', 'author comment');
    adminTargetCommentId = await addComment('team', refs.get, 'root', 'admin deletes this');

    // A comment in a project none of the comment-404 principals belong to.
    const otherRef = await createTicket('other', 'Other project ticket');
    otherCommentId = await addComment('other', otherRef, 'root', 'comment in another project');
    otherCommentBaseline = 'comment in another project';

    const createdAgent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Team Bot', slug: 'team-bot', roles: ['DEVELOPER'] }).expect(201);
    const agentPayload = data<{ apiKey: string; agent: { id: string; slug: string } }>(createdAgent);
    agent.id = agentPayload.agent.id;
    agent.slug = agentPayload.agent.slug;
    agent.apiKey = agentPayload.apiKey;
    // Assigned so `AgentsService.findByProject('team')` lists it for the
    // PATCH /projects/:slug/agents/:agentSlug route.
    await request(server).post(`/api/projects/team/tickets/${refs.agent}/assign`).set(auth('root'))
      .send({ agentId: agent.id }).expect(200);
    // Agents have no ProjectMember row: an agent-authored comment in `other`
    // proves the agent path skips the membership gate (AC3).
    agentCommentId = await addComment('other', otherRef, '', 'agent comment', agent.apiKey);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC6/AC7/AC8/AC9: findAllForPrincipal scoping. `softdel` was already
  // soft-deleted in beforeAll, so these run independently of each other.
  // -------------------------------------------------------------------------

  it('AC9: findAllForPrincipal never returns a soft-deleted project, even for a member of it', async () => {
    const projects = await projectsService.findAllForPrincipal(
      userPrincipal(ids.multi, 'multi', 'MEMBER'),
    );

    expect(projects.map((p) => p.slug)).not.toContain('softdel');
  }, TEST_TIMEOUT_MS);

  it('AC6: findAllForPrincipal returns exactly the projects a user principal is a member of', async () => {
    const projects = await projectsService.findAllForPrincipal(
      userPrincipal(ids.multi, 'multi', 'MEMBER'),
    );

    expect(projects.map((p) => p.slug).sort()).toEqual(['other', 'team']);
  }, TEST_TIMEOUT_MS);

  it('AC7: findAllForPrincipal returns every non-deleted project for a global ADMIN user principal', async () => {
    const projects = await projectsService.findAllForPrincipal(
      userPrincipal(rootUserId, 'Root', 'ADMIN'),
    );

    expect(projects.map((p) => p.slug).sort()).toEqual(['other', 'team', 'third']);
  }, TEST_TIMEOUT_MS);

  it('AC8: findAllForPrincipal returns every non-deleted project for an agent principal', async () => {
    const projects = await projectsService.findAllForPrincipal(agentPrincipal(agent));

    expect(projects.map((p) => p.slug).sort()).toEqual(['other', 'team', 'third']);
  }, TEST_TIMEOUT_MS);

  it('AC6 boundary: findAllForPrincipal returns no project for a user with no membership row', async () => {
    const projects = await projectsService.findAllForPrincipal(
      userPrincipal('user-no-membership', 'nobody', 'MEMBER'),
    );

    expect(projects).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // AC10 — GET /api/projects is scoped to the caller's memberships
  // -------------------------------------------------------------------------

  it('AC10: GET /api/projects returns exactly the one project a member DEVELOPER belongs to', async () => {
    const res = await send('get', '/api/projects', 'dev').expect(200);

    expect(data<{ slug: string }[]>(res).map((p) => p.slug)).toEqual(['team']);
  }, TEST_TIMEOUT_MS);

  it('AC10 boundary: GET /api/projects returns every non-deleted project for a global ADMIN', async () => {
    const res = await send('get', '/api/projects', 'root').expect(200);

    expect(data<{ slug: string }[]>(res).map((p) => p.slug).sort()).toEqual(['other', 'team', 'third']);
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // AC1 / AC2 / AC3 — CommentsService resolves comment → ticket → project
  // -------------------------------------------------------------------------

  it('AC1: CommentsService.update throws NotFoundAppException for a comment whose project the user is not a member of', async () => {
    await expect(
      commentsService.update(
        otherCommentId,
        { body: 'hijacked' },
        userPrincipal(ids.dev, 'dev', 'MEMBER'),
      ),
    ).rejects.toBeInstanceOf(NotFoundAppException);
  }, TEST_TIMEOUT_MS);

  it("AC1: the comment repository's update is not called for a non-member", async () => {
    await expect(
      commentsService.update(
        otherCommentId,
        { body: 'hijacked again' },
        userPrincipal(ids.dev, 'dev', 'MEMBER'),
      ),
    ).rejects.toBeInstanceOf(NotFoundAppException);

    const row = await prisma.comment.findUnique({ where: { id: otherCommentId } });
    expect(row?.body).toBe(otherCommentBaseline);
  }, TEST_TIMEOUT_MS);

  it('AC2: CommentsService.delete throws NotFoundAppException for a comment in a project the user is not a member of', async () => {
    await expect(
      commentsService.delete(otherCommentId, userPrincipal(ids.dev, 'dev', 'MEMBER')),
    ).rejects.toBeInstanceOf(NotFoundAppException);

    await expect(prisma.comment.findUnique({ where: { id: otherCommentId } })).resolves.not.toBeNull();
  }, TEST_TIMEOUT_MS);

  it('AC3: CommentsService.update proceeds to the CASL check without membership resolution for an agent principal', async () => {
    const updated = await commentsService.update(
      agentCommentId,
      { body: 'agent edit' },
      agentPrincipal(agent),
    );

    expect(updated.body).toBe('agent edit');
    const row = await prisma.comment.findUnique({ where: { id: agentCommentId } });
    expect(row?.body).toBe('agent edit');
    // Agents are cross-project: there is no ProjectMember row that could have
    // admitted the agent.
    expect(await prisma.projectMember.count({ where: { userId: agent.id } })).toBe(0);
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // AC4 / AC5 — slug-less comment mutations over HTTP
  // -------------------------------------------------------------------------

  it('AC4 boundary: PATCH /api/comments/:id returns 200 while the author is still a member', async () => {
    const res = await send('patch', `/api/comments/${authorCommentId}`, 'author', {
      body: 'still mine',
    });

    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it('AC4: PATCH /api/comments/:id returns 404 for the comment author after their project membership is removed', async () => {
    await request(server).delete(`/api/projects/team/members/${ids.author}`).set(auth('root')).expect(200);

    const res = await send('patch', `/api/comments/${authorCommentId}`, 'author', {
      body: 'still mine?',
    });

    expect(res.status).toBe(404);
    const row = await prisma.comment.findUnique({ where: { id: authorCommentId } });
    expect(row?.body).toBe('still mine');
  }, TEST_TIMEOUT_MS);

  it('AC5: DELETE /api/comments/:id returns 204 for a global ADMIN who is not a member', async () => {
    // `root` is a global ADMIN with no ProjectMember row anywhere.
    expect(await prisma.projectMember.count({ where: { userId: rootUserId } })).toBe(0);

    const res = await send('delete', `/api/comments/${adminTargetCommentId}`, 'root');

    expect(res.status).toBe(204);
    await expect(prisma.comment.findUnique({ where: { id: adminTargetCommentId } })).resolves.toBeNull();
  }, TEST_TIMEOUT_MS);

  it('AC5 boundary: DELETE /api/comments/:id returns 404 for a non-member DEVELOPER', async () => {
    const res = await send('delete', `/api/comments/${otherCommentId}`, 'dev');

    expect(res.status).toBe(404);
    await expect(prisma.comment.findUnique({ where: { id: otherCommentId } })).resolves.not.toBeNull();
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // AC11 / AC12 — the guarded route matrix
  // -------------------------------------------------------------------------

  const matrix: MatrixCase[] = [
    {
      label: 'GET /api/projects/:slug/tickets',
      method: 'get',
      url: () => '/api/projects/team/tickets',
      member: 'dev',
    },
    {
      label: 'POST /api/projects/:slug/tickets',
      method: 'post',
      url: () => '/api/projects/team/tickets',
      body: () => ({ type: 'BUG', title: 'Matrix create' }),
      member: 'dev',
    },
    {
      label: 'GET /api/projects/:slug/tickets/:ref',
      method: 'get',
      url: () => `/api/projects/team/tickets/${refs.get}`,
      member: 'dev',
    },
    {
      label: 'PATCH /api/projects/:slug/tickets/:ref',
      method: 'patch',
      url: () => `/api/projects/team/tickets/${refs.patch}`,
      body: () => ({ title: 'Matrix patched' }),
      member: 'adminMember',
    },
    {
      label: 'DELETE /api/projects/:slug/tickets/:ref',
      method: 'delete',
      url: () => `/api/projects/team/tickets/${refs.remove}`,
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/verify',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.verify}/verify`,
      body: () => ({ body: 'verified' }),
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/start',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.start}/start`,
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/fix',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.fix}/fix`,
      body: () => ({ body: 'fixed' }),
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/verify-fix',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.verifyFix}/verify-fix?approve=true`,
      body: () => ({ body: 'reviewed' }),
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/close',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.close}/close`,
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/reject',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.reject}/reject`,
      body: () => ({ body: 'rejected' }),
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/assign',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.assign}/assign`,
      body: () => ({ userId: ids.dev }),
      member: 'adminMember',
    },
    {
      label: 'GET /api/projects/:slug/tickets/:ref/comments',
      method: 'get',
      url: () => `/api/projects/team/tickets/${refs.get}/comments`,
      member: 'dev',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/comments',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.get}/comments`,
      body: () => ({ body: 'matrix comment', type: 'GENERAL' }),
      member: 'dev',
    },
    {
      label: 'GET /api/projects/:slug/labels',
      method: 'get',
      url: () => '/api/projects/team/labels',
      member: 'dev',
    },
    {
      label: 'POST /api/projects/:slug/labels',
      method: 'post',
      url: () => '/api/projects/team/labels',
      body: () => ({ name: 'us002-matrix', color: '#112233' }),
      member: 'adminMember',
    },
    {
      label: 'PATCH /api/projects/:slug/labels/:id',
      method: 'patch',
      url: () => `/api/projects/team/labels/${labelIds.update}`,
      body: () => ({ color: '#445566' }),
      member: 'adminMember',
    },
    {
      label: 'DELETE /api/projects/:slug/labels/:id',
      method: 'delete',
      url: () => `/api/projects/team/labels/${labelIds.delete}`,
      member: 'adminMember',
    },
    {
      label: 'POST /api/projects/:slug/tickets/:ref/labels',
      method: 'post',
      url: () => `/api/projects/team/tickets/${refs.get}/labels`,
      body: () => ({ labelId: labelIds.assign }),
      member: 'dev',
    },
    {
      label: 'DELETE /api/projects/:slug/tickets/:ref/labels/:labelId',
      method: 'delete',
      url: () => `/api/projects/team/tickets/${refs.get}/labels/${labelIds.remove}`,
      member: 'dev',
    },
    {
      label: 'GET /api/projects/:slug/kb/documents',
      method: 'get',
      url: () => '/api/projects/team/kb/documents',
      member: 'dev',
    },
    {
      label: 'POST /api/projects/:slug/kb/documents',
      method: 'post',
      url: () => '/api/projects/team/kb/documents',
      body: () => ({ source: 'doc', sourceId: 'us002-doc', content: 'membership gate' }),
      member: 'dev',
    },
    {
      label: 'POST /api/projects/:slug/kb/search',
      method: 'post',
      url: () => '/api/projects/team/kb/search',
      body: () => ({ query: 'membership' }),
      member: 'dev',
    },
    {
      label: 'POST /api/projects/:slug/kb/import/graphify',
      method: 'post',
      url: () => '/api/projects/team/kb/import/graphify',
      body: () => ({ nodes: [{ id: 'us002-n1', label: 'US-002' }], links: [] }),
      member: 'dev',
    },
    {
      label: 'GET /api/projects/:slug',
      method: 'get',
      url: () => '/api/projects/team',
      member: 'dev',
    },
    {
      label: 'PATCH /api/projects/:slug/agents/:agentSlug',
      method: 'patch',
      url: () => `/api/projects/team/agents/${agent.slug}`,
      body: () => ({ name: 'Renamed Bot' }),
      member: 'adminMember',
    },
  ];

  for (const matrixCase of matrix) {
    it(`AC11: ${matrixCase.label} returns 403 for a non-member DEVELOPER`, async () => {
      const res = await send(matrixCase.method, matrixCase.url(), 'outside', matrixCase.body?.());

      expect(res.status).toBe(403);
    }, TEST_TIMEOUT_MS);

    it(`AC12: ${matrixCase.label} returns a status other than 403 and 404 for a member DEVELOPER`, async () => {
      const res = await send(matrixCase.method, matrixCase.url(), matrixCase.member, matrixCase.body?.());

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(404);
    }, TEST_TIMEOUT_MS);
  }

  it('AC11 boundary: the same requester is admitted on the same route in the project where they are a member', async () => {
    // `outside` is a DEVELOPER member of `other` and not a member of `team`: the
    // 403 in the matrix is caused by the membership gate, not by the principal.
    const res = await send('get', '/api/projects/other/tickets', 'outside');

    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);
});
