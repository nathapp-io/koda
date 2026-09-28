/**
 * Track 3 Slice 4: the code-intel read routes and the impact route are
 * project-role gated (#144 matrix: ADMIN and DEVELOPER read CodeIntel, VIEWER
 * does not). The code-intel routes take the slug from ?projectSlug=.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/code-intel-project-roles.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('code-intel project-role gate (Slice 4)', () => {
  jest.setTimeout(60000);
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};
  let symbolId: string;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string, url: string) => request(server).get(url).set(auth(who));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Intel', slug: 'intel', key: 'INT' }).expect(201);
    for (const [who, role] of [['padmin', 'ADMIN'], ['pdev', 'DEVELOPER'], ['pviewer', 'VIEWER']]) {
      await request(server).post('/api/projects/intel/members').set(auth('root')).send({ email: `${who}@koda.test`, role }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Intel Agent', slug: 'intel-agent', roles: [] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

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

  it.each(['padmin', 'pdev', 'agent', 'root'])('%s reads every code-intel route', async (who) => {
    for (const url of routes()) {
      const res = await get(who, url);
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
    }
  });

  it.each(['pviewer', 'outsider'])('%s is refused on every code-intel route', async (who) => {
    for (const url of routes()) {
      const res = await get(who, url);
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
    }
  });

  it.each([
    ['missing', '/api/code-intel/symbols'],
    ['empty', '/api/code-intel/symbols?projectSlug='],
    ['repeated', '/api/code-intel/symbols?projectSlug=intel&projectSlug=intel'],
  ])('a %s projectSlug fails closed', async (_label, url) => {
    await get('pdev', url).expect(403);
  });
});
