/**
 * Code-intel routes enforce project access followed by permission keys.
 * Viewers can read but cannot index; custom roles need the specific route key.
 * Reads resolve ?projectSlug= and indexing resolves the body projectSlug.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/code-intel-project-roles.integration.spec.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { MembershipService } from '../../../src/permissions/membership.service';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const refusalMessage = (namespace: string): string => {
  const messages = JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${namespace}.json`), 'utf8')) as Record<string, string>;
  return messages['40003'] ?? `${namespace}.40003`;
};

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('code-intel project-role gate (Slice 4)', () => {
  vi.setConfig({ testTimeout: 60000 });
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let db: PrismaClient;
  let membership: MembershipService;
  let intelProjectId: string;
  let secondProjectId: string;
  let symbolId: string;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string, url: string) => request(server).get(url).set(auth(who));
  const expectRefusalCode = (res: request.Response, namespace: 'permissions' | 'projects') => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(refusalMessage(namespace));
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'outsider', 'custom']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
      userIds[who] = (await db.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` }, select: { id: true } })).id;
    }
    const project = await request(server).post('/api/projects').set(auth('root')).send({ name: 'Intel', slug: 'intel', key: 'INT' }).expect(201);
    intelProjectId = data<{ id: string }>(project).id;
    const secondProject = await request(server).post('/api/projects').set(auth('root')).send({ name: 'Intel Two', slug: 'intel-two', key: 'INTX' }).expect(201);
    secondProjectId = data<{ id: string }>(secondProject).id;
    const roleKey = { padmin: 'project-admin', pdev: 'developer', pviewer: 'viewer' } as const;
    for (const who of ['padmin', 'pdev', 'pviewer'] as const) {
      await membership.createBinding(
        { principal: { type: 'USER', id: userIds[who] as string }, roleKey: roleKey[who], projectId: intelProjectId },
        { type: 'SYSTEM', id: 'integration-test' },
      );
    }
    await membership.createBinding(
      { principal: { type: 'USER', id: userIds.pdev as string }, roleKey: 'developer', projectId: secondProjectId },
      { type: 'SYSTEM', id: 'integration-test' },
    );
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Intel Agent', slug: 'intel-agent', roles: [] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

    const intelAgent = await db.agent.findUniqueOrThrow({ where: { slug: 'intel-agent' } });
    await membership.createBinding(
      { principal: { type: 'AGENT', id: intelAgent.id }, roleKey: 'developer', projectId: intelProjectId },
      { type: 'SYSTEM', id: 'integration-test' },
    );

    await request(server).post('/api/code-intel/index').set(auth('root')).send({
      repoId: 'acme/widgets',
      commitHash: 'c1',
      projectSlug: 'intel',
      files: [{ path: 'src/a.ts', content: 'export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }' }],
    }).expect(201);

    const search = await get('root', '/api/code-intel/symbols?projectSlug=intel&q=alpha').expect(200);
    symbolId = data<{ items: Array<{ id: string }> }>(search).items[0].id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const enc = () => encodeURIComponent(symbolId);
  const routes = () => [
    '/api/code-intel/symbols?projectSlug=intel',
    `/api/code-intel/symbols/${enc()}?projectSlug=intel`,
    `/api/code-intel/symbols/${enc()}/callers?projectSlug=intel`,
    `/api/code-intel/symbols/${enc()}/callees?projectSlug=intel`,
    '/api/projects/intel/codeintel/impact?repoId=acme%2Fwidgets&commitHash=c1&changedFiles=src%2Fa.ts',
  ];

  it('stores the project in the symbol id', () => {
    expect(symbolId).toMatch(/^[^:]+:acme\/widgets:src\/a\.ts::alpha$/);
  });

  it.each(['padmin', 'pdev', 'pviewer', 'agent', 'root'])('%s reads every code-intel route', async (who) => {
    for (const url of routes()) {
      const res = await get(who, url);
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
    }
  });

  it('outsider is refused by project access before the route key', async () => {
    for (const url of routes()) {
      expectRefusalCode(await get('outsider', url), 'projects');
    }
  });

  it.each([
    ['missing', '/api/code-intel/symbols'],
    ['empty', '/api/code-intel/symbols?projectSlug='],
    ['repeated', '/api/code-intel/symbols?projectSlug=intel&projectSlug=intel'],
  ])('a %s projectSlug fails closed', async (_label, url) => {
    expectRefusalCode(await get('pdev', url), 'permissions');
  });

  it('AC-1/AC-2: developer binding indexes in p1 and search stays project-isolated', async () => {
    await request(server).post('/api/code-intel/index').set(auth('pdev')).send({
      projectSlug: 'intel', repoId: 'repo-ac2', commitHash: 'developer-commit',
      files: [{ path: 'src/foo.ts', content: 'export function fooFn() { return 1; }' }],
    }).expect(201);

    const p1 = await get('pdev', '/api/code-intel/symbols?projectSlug=intel&q=fooFn').expect(200);
    expect(data<{ items: Array<{ name: string }> }>(p1).items.map(({ name }) => name)).toContain('fooFn');
    const p2 = await get('pdev', '/api/code-intel/symbols?projectSlug=intel-two&q=fooFn').expect(200);
    expect(data<{ items: unknown[] }>(p2).items).toEqual([]);
  });

  it('AC-3: viewer binding cannot index and persists no symbols', async () => {
    expectRefusalCode(await request(server).post('/api/code-intel/index').set(auth('pviewer')).send({
      projectSlug: 'intel', repoId: 'repo-denied', commitHash: 'denied-commit',
      files: [{ path: 'src/denied.ts', content: 'export function deniedFn() {}' }],
    }), 'permissions');
    const search = await get('pviewer', '/api/code-intel/symbols?projectSlug=intel&q=deniedFn').expect(200);
    expect(data<{ items: unknown[] }>(search).items).toEqual([]);
  });

  it('AC-4: global admin without a project slug fails closed on indexing', async () => {
    expectRefusalCode(await request(server).post('/api/code-intel/index').set(auth('root')).send({
      repoId: 'repo-no-project', commitHash: 'no-project', files: [],
    }), 'permissions');
  });

  it('AC-5: user without project access is refused before the key', async () => {
    expectRefusalCode(await request(server).post('/api/code-intel/index').set(auth('outsider')).send({
      projectSlug: 'intel', repoId: 'repo-outsider', commitHash: 'outsider', files: [],
    }), 'projects');
  });

  it('AC-7/10/14: a custom project role lacking code-intel keys is refused by all route families', async () => {
    // US-001: `project.read` is what admits the caller to the project at all; the code-intel keys are
    // what the routes then refuse.
    const custom = await db.role.create({ data: {
      key: 'intel-ticket-only', name: 'Intel ticket-only', scope: 'PROJECT', system: false,
      permissions: ['project.read', 'ticket.read'],
    } });
    await db.roleBinding.create({ data: {
      principalType: 'USER', principalId: userIds.custom as string, roleId: custom.id,
      projectId: intelProjectId, grantedByType: 'SYSTEM', grantedById: 'integration-test',
    } });
    for (const url of [
      '/api/code-intel/symbols?projectSlug=intel',
      `/api/code-intel/symbols/${encodeURIComponent(symbolId)}/callers?projectSlug=intel`,
      '/api/projects/intel/codeintel/impact?repoId=acme%2Fwidgets&commitHash=c1&changedFiles=src%2Fa.ts',
    ]) expectRefusalCode(await get('custom', url), 'permissions');
  });

  it('AC-8: global admin without projectSlug is refused for symbol search by the key guard', async () => {
    expectRefusalCode(await get('root', '/api/code-intel/symbols'), 'permissions');
  });

  it('AC-12: an agent with only a developer binding can index', async () => {
    await request(server).post('/api/code-intel/index').set(auth('agent')).send({
      projectSlug: 'intel', repoId: 'repo-agent-binding', commitHash: 'agent-binding',
      files: [{ path: 'src/agent-only.ts', content: 'export function agentBindingFn() {}' }],
    }).expect(201);
  });

  it('AC-13/AC-15: viewer binding reads impact and missing parameters reach handler validation', async () => {
    await get('pviewer', '/api/projects/intel/codeintel/impact?repoId=acme%2Fwidgets&commitHash=c1&changedFiles=src%2Fa.ts').expect(200);
    await get('pviewer', '/api/projects/intel/codeintel/impact').expect(400);
  });
});
