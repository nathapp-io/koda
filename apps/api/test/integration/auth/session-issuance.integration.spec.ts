import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
}

const claims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;

describeIntegration('session-bound sign-in issuance (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let userId: string;
  const email = 'session-issuance@koda.test';

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    const user = await prisma.user.create({
      data: { email, name: 'Session Issuance', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    userId = user.id;
    await grantBaseline(prisma, { type: 'USER', id: userId });
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1..5: login persists one session and binds both JWTs and expiry to its identifiers', async () => {
    const response = data<SessionResponse>(await request(app.getHttpServer())
      .post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200));
    const refresh = claims(response.refreshToken);
    const access = claims(response.accessToken);
    const sessions = await prisma.authSession.findMany({
      where: { userId }, include: { tokens: true },
    });

    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(refresh.sid).toBe(session.id);
    expect(refresh.jti).toBe(session.tokens[0].id);
    expect(session.tokens).toHaveLength(1);
    expect(access.sid).toBe(session.id);
    expect(session.expiresAt.getTime()).toBe((refresh.exp as number) * 1000);
  });
});
