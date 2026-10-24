import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { ensureSystemRoles } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const integration = canRunDbTests() ? describe : describe.skip;
interface Session { accessToken: string; user: { id: string } }
integration('global admin token revocation (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let owner: Session;
  let member: Session;
  beforeAll(async () => {
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
  });
  beforeEach(async () => {
    await resetDb(); await ensureSystemRoles(db); resetThrottle(app);
    const register = async (email: string) => data<Session>(await request(app.getHttpServer()).post('/api/auth/register')
      .send({ email, name: 'Token test', password: TEST_PASSWORD }).expect(201));
    owner = await register('owner@tokens.test'); member = await register('member@tokens.test');
  });
  afterAll(async () => { await app?.close(); });
  const me = (token: string) => request(app.getHttpServer()).get('/api/auth/me').auth(token, { type: 'bearer' });
  const grant = async (roleKey: string, projectId: string | null = null) => data<{ id: string }>(await request(app.getHttpServer())
    .post('/api/role-bindings').auth(owner.accessToken, { type: 'bearer' })
    .send({ principalType: 'USER', principalId: member.user.id, roleKey, projectId }).expect(201));
  const version = async () => (await db.user.findUniqueOrThrow({ where: { id: member.user.id } })).tokenVersion;
  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });
  it('AC-9: global grant revokes warmed member token', async () => {
    await me(member.accessToken).expect(200); const before = await version();
    await grant('admin'); expect(await version()).toBe(before + 1);
    await me(member.accessToken).expect(401);
  });
  it('AC-10: last global removal revokes warmed admin token', async () => {
    const binding = await grant('admin');
    const session = data<Session>(await request(app.getHttpServer()).post('/api/auth/login')
      .send({ email: 'member@tokens.test', password: TEST_PASSWORD }).expect(200));
    await me(session.accessToken).expect(200); const before = await version();
    await request(app.getHttpServer()).delete(`/api/role-bindings/${binding.id}`).auth(owner.accessToken, { type: 'bearer' }).expect(204);
    expect(await version()).toBe(before + 1); await me(session.accessToken).expect(401);
  });
  it('a failed token bump rolls back the binding and leaves caches usable', async () => {
    await me(member.accessToken).expect(200);
    const before = await version();
    try {
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION reject_token_bump() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."tokenVersion" <> OLD."tokenVersion" THEN RAISE EXCEPTION 'token bump failure'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER reject_token_bump BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION reject_token_bump()');
      await request(app.getHttpServer()).post('/api/role-bindings').auth(owner.accessToken, { type: 'bearer' })
        .send({ principalType: 'USER', principalId: member.user.id, roleKey: 'admin' }).expect(500);
      expect(await db.roleBinding.count({ where: { principalType: 'USER', principalId: member.user.id, role: { key: 'admin' } } })).toBe(0);
      expect(await version()).toBe(before);
      await me(member.accessToken).expect(200);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_token_bump ON "User"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_token_bump()');
    }
  });
  it('AC-11: project grant preserves warmed token', async () => {
    const project = await db.project.create({ data: { name: 'Tokens', slug: 'tokens', key: 'TOK' } });
    await me(member.accessToken).expect(200); const before = await version();
    await grant('developer', project.id); expect(await version()).toBe(before);
    await me(member.accessToken).expect(200);
  });
});
