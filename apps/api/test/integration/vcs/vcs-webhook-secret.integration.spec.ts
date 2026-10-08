/**
 * Track 3 Slice 4 (M9): the webhook secret is shown on create and on rotate,
 * never on read. Rotation is project ADMIN or global ADMIN; DEVELOPER, VIEWER,
 * non-members and agents are refused.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-webhook-secret.integration.spec.ts
 */
import request from 'supertest';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const HEX_32 = /^[0-9a-f]{32}$/;
const ROTATE = '/api/projects/hooks/vcs/webhook-secret/rotate';

describeIntegration('VCS webhook secret (M9)', () => {
  jest.setTimeout(60000);
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  let createdSecret: string;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = createTestPrismaClient(process.env.DATABASE_URL);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Hooks', slug: 'hooks', key: 'HOOK' }).expect(201);
    for (const [who, role] of [['padmin', 'ADMIN'], ['pdev', 'DEVELOPER'], ['pviewer', 'VIEWER']]) {
      await request(server).post('/api/projects/hooks/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Hook Agent', slug: 'hook-agent', roles: ['DEVELOPER'] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

    const created = await request(server).post('/api/projects/hooks/vcs').set(auth('root'))
      .send({ provider: 'github', repoOwner: 'acme', repoName: 'widgets', token: 'ghp_test', syncMode: 'webhook' })
      .expect(201);
    createdSecret = data<{ webhookSecret: string }>(created).webhookSecret;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    if (previousKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousKey;
  });

  const storedSecret = async () =>
    (await prisma.vcsConnection.findFirstOrThrow({ where: { project: { slug: 'hooks' } } })).webhookSecret;

  it('create returned the stored secret', async () => {
    expect(createdSecret).toMatch(HEX_32);
    expect(await storedSecret()).toBe(createdSecret);
  });

  it('a read never returns the secret', async () => {
    const res = await request(server).get('/api/projects/hooks/vcs').set(auth('root')).expect(200);
    const body = data<Record<string, unknown>>(res);
    expect(body).not.toHaveProperty('webhookSecret');
    expect(body.webhookSecretConfigured).toBe(true);
  });

  it.each(['padmin', 'root'])('%s rotates and gets the new secret once', async (who) => {
    const before = await storedSecret();
    const res = await request(server).post(ROTATE).set(auth(who)).expect(200);
    const { webhookSecret } = data<{ webhookSecret: string }>(res);
    expect(webhookSecret).toMatch(HEX_32);
    expect(webhookSecret).not.toBe(before);
    expect(await storedSecret()).toBe(webhookSecret);
  });

  it.each(['pdev', 'pviewer', 'outsider', 'agent'])('%s cannot rotate', async (who) => {
    const before = await storedSecret();
    await request(server).post(ROTATE).set(auth(who)).expect(403);
    expect(await storedSecret()).toBe(before);
  });
});
