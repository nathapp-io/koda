import request from 'supertest';
import bcrypt from 'bcrypt';
import type { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { ensureSystemRoles, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const integration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
interface Session { accessToken: string; refreshToken: string; user: { id: string; role: string } }
const claim = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role;

integration('binding-derived role claims (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  beforeAll(async () => {
    app = await bootHttpApp({ registrationEnabled: true });
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
  });
  beforeEach(async () => { await resetDb(); await ensureSystemRoles(db); resetThrottle(app); });
  afterAll(async () => { await app?.close(); });
  const register = async (email = 'first@claim.test') => data<Session>(await request(app.getHttpServer())
    .post('/api/auth/register').send({ email, name: 'Claim', password: TEST_PASSWORD }).expect(201));
  const login = async (email: string) => data<Session>(await request(app.getHttpServer())
    .post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200));
  async function user() {
    const row = await db.user.create({ data: { email: 'user@claim.test', name: 'User',  passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) } });
    await grantBaseline(db, { type: 'USER', id: row.id });
    return row;
  }
  const project = () => db.project.create({ data: { name: 'Claims', slug: 'claims', key: 'CLM' } });

  it('P1m AC-5/6: Owner creates an account which logs in with MEMBER claim', async () => {
    const owner = await register();
    await request(app.getHttpServer()).post('/api/admin/users').auth(owner.accessToken, { type: 'bearer' })
      .send({ email: 'created@claim.test', name: 'Created', password: TEST_PASSWORD }).expect(201);
    expect(claim((await login('created@claim.test')).accessToken)).toBe('MEMBER');
  });
  it('AC-1: first registration displays ADMIN', async () => { expect((await register()).user.role).toBe('ADMIN'); });
  it('AC-2: first registration access token works immediately', async () => {
    const session = await register();
    await request(app.getHttpServer()).get('/api/auth/me').auth(session.accessToken, { type: 'bearer' }).expect(200);
  });
  it('AC-3: second registration claim is MEMBER', async () => {
    await register();
    expect(claim((await register('second@claim.test')).accessToken)).toBe('MEMBER');
  });
  it('AC-4: user without a global binding yields MEMBER', async () => {
    const row = await user();
    expect(claim((await login(row.email)).accessToken)).toBe('MEMBER');
  });
  it('AC-5: me displays ADMIN from a global admin binding', async () => {
    const row = await user();
    await grantRole(db, { type: 'USER', id: row.id }, 'admin');
    const session = await login(row.email);
    const response = await request(app.getHttpServer()).get('/api/auth/me').auth(session.accessToken, { type: 'bearer' }).expect(200);
    expect(data<{ role: string }>(response).role).toBe('ADMIN');
  });
  it.each([false, true])('AC-6: project-admin (global project scope %s) yields MEMBER', async global => {
    const row = await user();
    const p = await project();
    await grantRole(db, { type: 'USER', id: row.id }, 'project-admin', global ? null : p.id);
    expect(claim((await login(row.email)).accessToken)).toBe('MEMBER');
  });
  it('AC-7: refresh re-derives MEMBER after direct binding deletion', async () => {
    const row = await user();
    const binding = await grantRole(db, { type: 'USER', id: row.id }, 'admin');
    const session = await login(row.email);
    expect(claim(session.accessToken)).toBe('ADMIN');
    await db.roleBinding.delete({ where: { id: binding.id } });
    const response = await request(app.getHttpServer()).post('/api/auth/refresh').auth(session.refreshToken, { type: 'bearer' }).send({}).expect(200);
    expect(claim(data<Session>(response).accessToken)).toBe('MEMBER');
  });
  it('AC-8: new invite account displays MEMBER', async () => {
    const root = await register();
    await request(app.getHttpServer()).post('/api/projects').auth(root.accessToken, { type: 'bearer' })
      .send({ name: 'Claims', slug: 'claims', key: 'CLM' }).expect(201);
    const response = await request(app.getHttpServer()).post('/api/projects/claims/invites').auth(root.accessToken, { type: 'bearer' })
      .send({ email: 'invited@claim.test', roleKey: 'developer' }).expect(201);
    const token = data<{ invitePath: string }>(response).invitePath.split('/').pop();
    const accepted = await request(app.getHttpServer()).post(`/api/invites/${token}/accept`)
      .send({ name: 'Invited', password: TEST_PASSWORD }).expect(201);
    expect(data<Session>(accepted).user.role).toBe('MEMBER');
  });
});
