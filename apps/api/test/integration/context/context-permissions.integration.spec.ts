/**
 * US-003: Context project routes enforce project access before route permission keys.
 * Run with the compose Postgres up: bun run test:scoped test/integration/context/context-permissions.integration.spec.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { ContextBuilderService } from '../../../src/context/context-builder.service';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const refusalMessage = (namespace: string): string => {
  const messages = JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${namespace}.json`), 'utf8')) as Record<string, string>;
  return messages['40003'] ?? `${namespace}.40003`;
};

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const PROJECT_SLUG = 'context-permissions-p1';
const QUERY = { query: 'auth' };

describeIntegration('US-003 context route permissions', () => {
  vi.setConfig({ testTimeout: 60_000 });

  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let contextBuilder: ContextBuilderService;
  let projectId: string;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let agentKey = '';
  let agentId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string, slug = PROJECT_SLUG) =>
    request(server).get(`/api/context/${slug}`).set(auth(who));
  const postQuery = (who: string) =>
    request(server).post(`/api/context/${PROJECT_SLUG}/query`).set(auth(who)).send(QUERY);
  const expectRefusal = (res: request.Response, code: 'permissions' | 'projects') => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(refusalMessage(code));
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    contextBuilder = app.get(ContextBuilderService);
    vi.spyOn(contextBuilder, 'getProjectContext').mockResolvedValue({ projectId: 'context-project' } as never);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'context-root@koda.test', name: 'Context Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['viewer', 'developer', 'custom', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `context-${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      userIds[who] = (await db.user.findUniqueOrThrow({
        where: { email: `context-${who}@koda.test` }, select: { id: true },
      })).id;
      resetThrottle(app);
      tokens[who] = await loginToken(server, `context-${who}@koda.test`);
    }

    const project = await request(server).post('/api/projects').set(auth('root'))
      .send({ name: 'Context Permissions', slug: PROJECT_SLUG, key: 'CXP' }).expect(201);
    projectId = data<{ id: string }>(project).id;

    await membership.createBinding(
      { principal: { type: 'USER', id: userIds.viewer as string }, roleKey: 'viewer', projectId },
      { type: 'SYSTEM', id: 'us-003-integration' },
    );
    await membership.createBinding(
      { principal: { type: 'USER', id: userIds.developer as string }, roleKey: 'developer', projectId },
      { type: 'SYSTEM', id: 'us-003-integration' },
    );

    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Context Developer Agent', slug: 'context-developer-agent' }).expect(201);
    agentKey = data<{ apiKey: string }>(agent).apiKey;
    agentId = (await db.agent.findUniqueOrThrow({
      where: { slug: 'context-developer-agent' }, select: { id: true },
    })).id;
    await membership.createBinding(
      { principal: { type: 'AGENT', id: agentId }, roleKey: 'developer', projectId },
      { type: 'SYSTEM', id: 'us-003-integration' },
    );

    // US-001: `project.read` admits the caller to the project; `ticket.read` alone is not access.
    const custom = await db.role.create({ data: {
      key: 'context-ticket-only', name: 'Context ticket-only', scope: 'PROJECT', system: false,
      permissions: ['project.read', 'ticket.read'],
    } });
    await db.roleBinding.create({ data: {
      principalType: 'USER', principalId: userIds.custom as string, roleId: custom.id,
      projectId, grantedByType: 'SYSTEM', grantedById: 'us-003-integration',
    } });
  }, 60_000);

  beforeEach(() => {
    vi.mocked(contextBuilder.getProjectContext).mockClear();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it('AC-1: viewer binding reads context', async () => {
    await get('viewer').expect(200);
  });

  it('AC-2: viewer binding cannot query context', async () => {
    expectRefusal(await postQuery('viewer'), 'permissions');
  });

  it('AC-3: developer binding queries context', async () => {
    await postQuery('developer').expect(200);
  });

  it('AC-4: agent developer binding queries context', async () => {
    await request(server).post(`/api/context/${PROJECT_SLUG}/query`)
      .set({ Authorization: `Bearer ${agentKey}` }).send(QUERY).expect(200);
  });

  it('AC-5: custom role without context.read is refused', async () => {
    expectRefusal(await get('custom'), 'permissions');
  });

  it('AC-6: user without project access is refused before key evaluation', async () => {
    expectRefusal(await get('outsider'), 'projects');
  });

  it('AC-7: global admin receives project-not-found for an unknown slug', async () => {
    const res = await get('root', 'no-such-context-project');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Project not found');
  });

  it('AC-8: global admin receives project-not-found for a soft-deleted project', async () => {
    await db.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
    try {
      const res = await get('root');
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Project not found');
    } finally {
      await db.project.update({ where: { id: projectId }, data: { deletedAt: null } });
    }
  });

  it('AC-9: GET passes the binding user and guarded project to ContextBuilderService', async () => {
    await get('viewer').expect(200);
    expect(contextBuilder.getProjectContext).toHaveBeenCalledTimes(1);
    expect(contextBuilder.getProjectContext).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, actorId: userIds.viewer }),
    );
  });
});
