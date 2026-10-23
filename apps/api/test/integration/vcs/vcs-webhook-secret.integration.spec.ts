/**
 * Track 3 Slice 4 (M9): the webhook secret is shown on create and on rotate,
 * never on read. Rotation requires the rotate permission: legacy project/global
 * admins and project-admin-bound agents may rotate; developers and viewers cannot.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-webhook-secret.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const HEX_32 = /^[0-9a-f]{32}$/;
const ROTATE = '/api/projects/hooks/vcs/webhook-secret/rotate';

describeIntegration('VCS webhook secret (M9)', () => {
  vi.setConfig({ testTimeout: 60000 });
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let createdSecret: string;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;
  const previousScoping = process.env.AGENT_PROJECT_SCOPING;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.AGENT_PROJECT_SCOPING = 'on';
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = createTestPrismaClient(process.env.DATABASE_URL);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['padmin', 'pdev', 'pviewer', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
      ids[who] = (await prisma.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` } })).id;
    }
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Hooks', slug: 'hooks', key: 'HOOK' }).expect(201);
    for (const [who, roleKey] of [['padmin', 'project-admin'], ['pdev', 'developer'], ['pviewer', 'viewer']]) {
      await request(server).post('/api/projects/hooks/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, roleKey }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Hook Agent', slug: 'hook-agent', roles: [] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;
    ids.agent = (await prisma.agent.findUniqueOrThrow({ where: { slug: 'hook-agent' } })).id;

    const project = await prisma.project.findUniqueOrThrow({ where: { slug: 'hooks' } });
    const grantor = await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } });
    const projectAdminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'project-admin' } });
    const developerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'developer' } });
    for (const [who, roleId] of [
      ['binding-admin-agent', projectAdminRole.id],
      ['binding-developer-agent', developerRole.id],
    ] as const) {
      const response = await request(server).post('/api/agents').set(auth('root'))
        .send({ name: who, slug: who, roles: [] }).expect(201);
      const agent = data<{ apiKey: string }>(response);
      tokens[who] = agent.apiKey;
      const agentRow = await prisma.agent.findUniqueOrThrow({ where: { slug: who } });
      ids[who] = agentRow.id;
      await prisma.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agentRow.id } });
      expect(await prisma.agentProject.count({ where: { agentId: agentRow.id } })).toBe(0);
      expect(await prisma.agentRoleEntry.count({ where: { agentId: agentRow.id } })).toBe(0);
      await prisma.roleBinding.create({ data: {
        principalType: 'AGENT', principalId: agentRow.id, roleId, projectId: project.id,
        grantedByType: 'USER', grantedById: grantor.id,
      } });
    }
  });

  beforeEach(async () => {
    resetThrottle(app);
    // Rotation cases must not change the connection observed by another case.
    await prisma.vcsConnection.deleteMany({ where: { project: { slug: 'hooks' } } });
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
    if (previousScoping === undefined) delete process.env.AGENT_PROJECT_SCOPING;
    else process.env.AGENT_PROJECT_SCOPING = previousScoping;
  });

  const storedSecret = async () =>
    (await prisma.vcsConnection.findFirstOrThrow({ where: { project: { slug: 'hooks' } } })).webhookSecret;

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(
      prisma,
      [
        { type: 'USER', id: ids.root },
        { type: 'USER', id: ids.padmin },
        { type: 'USER', id: ids.pdev },
        { type: 'USER', id: ids.pviewer },
        { type: 'USER', id: ids.outsider },
        { type: 'AGENT', id: ids.agent },
        { type: 'AGENT', id: ids['binding-admin-agent'] },
        { type: 'AGENT', id: ids['binding-developer-agent'] },
      ],
      // The two binding agents hold exactly one project binding each — their baseline binding is
      // deleted on purpose, so they are the principals with no global binding.
      {
        noBaseline: [
          { type: 'AGENT', id: ids['binding-admin-agent'] },
          { type: 'AGENT', id: ids['binding-developer-agent'] },
        ],
      },
    );

    // The hook agent holds no legacy role: its `roles` are empty, so production wrote no
    // `AgentRoleEntry` row for it.
    expect(await prisma.agentRoleEntry.count({ where: { agentId: ids.agent } })).toBe(0);
  });

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

  it('AC-11: project-admin-bound agent rotates and persists the new secret', async () => {
    const before = await storedSecret();
    const response = await request(server).post(ROTATE).set(auth('binding-admin-agent')).expect(200);
    const next = data<{ webhookSecret: string }>(response).webhookSecret;
    expect(next).toMatch(HEX_32);
    expect(next).not.toBe(before);
    expect(await storedSecret()).toBe(next);
  });

  it('AC-12: developer-bound agent is refused without changing the secret', async () => {
    const before = await storedSecret();
    const response = await request(server).post(ROTATE).set(auth('binding-developer-agent')).expect(403);
    expect(response.body).toMatchObject({ ret: 40003 });
    expect(response.body.message).toContain('permissions');
    expect(await storedSecret()).toBe(before);
  });
});
