import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const TIMEOUT = 60_000;

describeIntegration('remaining permission route outcomes (US-003)', () => {
  let app: Awaited<ReturnType<typeof bootHttpApp>>;
  let server: ReturnType<typeof app.getHttpServer>;
  let ownerToken: string;
  let memberToken: string;
  let adminToken: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    const owner = await request(server).post('/api/auth/register').send({
      email: 'remaining-owner@koda.test', name: 'Owner', password: TEST_PASSWORD,
    }).expect(201);
    ownerToken = data<{ accessToken: string }>(owner).accessToken;
    /**
     * Permissions P1l (US-005): the create route takes no role. `'ADMIN'` means "create it, then bind
     * the global `admin` role through POST /role-bindings" — binding before the login, because the
     * grant can revoke an older token.
     */
    const create = async (email: string, role: 'MEMBER' | 'ADMIN'): Promise<string> => {
      const created = await request(server).post('/api/admin/users').set({ Authorization: `Bearer ${ownerToken}` }).send({
        email, name: email, password: TEST_PASSWORD,
      }).expect(201);
      if (role === 'ADMIN') {
        await request(server)
          .post('/api/role-bindings')
          .set({ Authorization: `Bearer ${ownerToken}` })
          .send({ principalType: 'USER', principalId: data<{ id: string }>(created).id, roleKey: 'admin', projectId: null })
          .expect(201);
      }
      return loginToken(server, email);
    };
    memberToken = await create('remaining-member@koda.test', 'MEMBER');
    resetThrottle(app);
    adminToken = await create('remaining-admin@koda.test', 'ADMIN');
  }, TIMEOUT);

  beforeEach(() => resetThrottle(app));
  afterAll(async () => { await app?.close(); });

  it('AC-3: permits an unauthenticated GET /health and returns status ok', async () => {
    const response = await request(server).get('/api/health').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('AC-4: refuses a member-baseline user from GET /roles with the permissions code', async () => {
    const response = await request(server).get('/api/roles').set({ Authorization: `Bearer ${memberToken}` }).expect(403);
    expect(response.body.ret).toBe(40003);
  });

  it('AC-5: permits a global admin to GET /roles', async () => {
    const response = await request(server).get('/api/roles').set({ Authorization: `Bearer ${adminToken}` }).expect(200);
    expect(response.body.ret).toBe(0);
  });
});
