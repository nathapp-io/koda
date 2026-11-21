import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
const INVALID_CREDENTIALS = 'Invalid email or password';

describeDb('login failure message (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let email: string;
  const login = (address: string, password: string, language?: string) => {
    const req = request(server).post('/api/auth/login');
    if (language) req.set('Accept-Language', language);
    return req.send({ email: address, password });
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    resetThrottle(app);
    email = `${randomUUID()}@example.test`;
    const user = await db.user.create({
      data: { email, name: 'Login User', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
  });

  it('AC-1: unknown email returns the generic invalid-credentials message', async () => {
    const response = await login(`${randomUUID()}@example.test`, TEST_PASSWORD).expect(401);
    expect(response.body.message).toBe(INVALID_CREDENTIALS);
  });

  it('AC-2: a wrong password returns the generic invalid-credentials message', async () => {
    const response = await login(email, 'wrong-password').expect(401);
    expect(response.body.message).toBe(INVALID_CREDENTIALS);
  });

  it('AC-3: a disabled user with the correct password gets the same failure message', async () => {
    await db.user.update({ where: { email }, data: { disabled: true } });
    const response = await login(email, TEST_PASSWORD).expect(401);
    expect(response.body.message).toBe(INVALID_CREDENTIALS);
  });

  it('AC-4: wrong-password failure is localized for Chinese', async () => {
    const response = await login(email, 'wrong-password', 'zh').expect(401);
    expect(response.body.message).toBe('无效的邮箱或密码');
  });
});
