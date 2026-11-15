import { randomUUID, createHmac } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { AUTH_CFG, IAuthConfig } from '../../../src/config/auth.config';
import { AUTH_LOGIN_LIMIT } from '../../../src/auth/auth-throttle';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
const NEW_PASSWORD = 'Different123!';
type Pair = { accessToken: string; refreshToken: string };
const sid = (pair: Pair): string => (JSON.parse(Buffer.from(pair.accessToken.split('.')[1], 'base64url').toString()) as { sid: string }).sid;

describeDb('password change (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let userId: string;
  let email: string;
  let pair: Pair;
  const login = async (address = email, password = TEST_PASSWORD): Promise<Pair> =>
    data<Pair>(await request(server).post('/api/auth/login').send({ email: address, password }).expect(200));
  const change = (token: string, currentPassword = TEST_PASSWORD, newPassword = NEW_PASSWORD) =>
    request(server).post('/api/auth/password').set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword });
  const me = (token: string) => request(server).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const hash = async () => (await db.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;
  const entries = () => db.auditEntry.findMany({ where: { key: 'session.password.change', resourceId: userId } });

  beforeAll(async () => { await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); server = app.getHttpServer(); db = fixtureDb(app); }, 30_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    email = `${randomUUID()}@example.test`;
    const user = await db.user.create({ data: { email, name: 'Password User', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) } });
    userId = user.id;
    await grantBaseline(db, { type: 'USER', id: userId });
    pair = await login();
  });

  it('AC-1: new password logs in and old password fails', async () => {
    await change(pair.accessToken).expect(200);
    await login(email, NEW_PASSWORD);
    await request(server).post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);
  });
  it('AC-2: the caller access and refresh tokens remain valid', async () => {
    await change(pair.accessToken).expect(200);
    await me(pair.accessToken).expect(200);
    await request(server).post('/api/auth/refresh').set('Authorization', `Bearer ${pair.refreshToken}`).expect(200);
  });
  it('AC-3: a cached second session is revoked immediately', async () => {
    const second = await login();
    await me(second.accessToken).expect(200);
    await change(pair.accessToken).expect(200);
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sid(second) } })).toMatchObject({ revokedReason: 'password-change' });
    await me(second.accessToken).expect(401);
  });
  it('AC-4: another user session remains active', async () => {
    const otherEmail = `${randomUUID()}@example.test`;
    const other = await db.user.create({ data: { email: otherEmail, name: 'Other', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) } });
    await grantBaseline(db, { type: 'USER', id: other.id });
    const otherPair = await login(otherEmail);
    await change(pair.accessToken).expect(200);
    await me(otherPair.accessToken).expect(200);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(otherPair) } })).revokedAt).toBeNull();
  });
  it('AC-5: wrong current password is forbidden without writes', async () => {
    const second = await login();
    const before = await hash();
    const res = await change(pair.accessToken, 'wrong').expect(403);
    expect(JSON.stringify(res.body)).toContain('The current password is incorrect');
    expect(await hash()).toBe(before);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(second) } })).revokedAt).toBeNull();
  });
  it('AC-6: wrong current password records no password change audit', async () => {
    await change(pair.accessToken, 'wrong').expect(403);
    expect(await entries()).toHaveLength(0);
  });
  it('AC-7: success records exactly one audit entry', async () => {
    await change(pair.accessToken).expect(200);
    expect(await entries()).toMatchObject([{ key: 'session.password.change', resourceType: 'user', resourceId: userId, projectId: null, summary: 'password changed' }]);
    expect(await entries()).toHaveLength(1);
  });
  it('AC-8: an authenticated agent is refused without writes', async () => {
    const raw = `agent-${randomUUID()}`;
    const config = app.get<IAuthConfig>(AUTH_CFG);
    const agent = await db.agent.create({ data: { name: 'Agent', slug: randomUUID(), apiKeyHash: createHmac('sha256', config.apiKeySecret).update(raw).digest('hex'), status: 'ACTIVE' } });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    const before = await hash();
    await request(server).get('/api/agents/me').set('Authorization', `Bearer ${raw}`).expect(200);
    await change(raw).expect(401);
    expect(await hash()).toBe(before);
    expect(await entries()).toHaveLength(0);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(pair) } })).revokedAt).toBeNull();
  });
  it('AC-10: short new password is rejected without changing the hash', async () => {
    const before = await hash();
    await change(pair.accessToken, TEST_PASSWORD, 'short1!').expect(400);
    expect(await hash()).toBe(before);
  });
  it('AC-11: new password without uppercase is rejected without changing the hash', async () => {
    const before = await hash();
    await change(pair.accessToken, TEST_PASSWORD, 'lowercase1!').expect(400);
    expect(await hash()).toBe(before);
  });
  it('AC-15: password change uses the login throttle', async () => {
    for (let i = 0; i < AUTH_LOGIN_LIMIT; i++) await change(pair.accessToken, 'wrong').expect(403);
    await change(pair.accessToken, 'wrong').expect(429);
  });
});
