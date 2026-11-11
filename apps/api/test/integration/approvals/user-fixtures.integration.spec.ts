import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { bootHttpApp, TEST_PASSWORD_HASH } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { createMemberWithToken } from '../../helpers/user-fixtures';

(canRunDbTests() ? describe : describe.skip)('member user fixtures (PG)', () => {
  let app: NathApplication;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
  });
  afterAll(async () => { await app?.close(); });

  it('creates independent members with a reusable hash and real login tokens, without granting owner', async () => {
    const db = fixtureDb(app);
    const first = await createMemberWithToken(app.getHttpServer(), db, { email: 'first@koda.test', name: 'First' });
    const second = await createMemberWithToken(app.getHttpServer(), db, { email: 'second@koda.test', name: 'Second' });
    expect(first.id).not.toBe(second.id);
    expect(await db.user.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      email: 'first@koda.test', name: 'First', passwordHash: TEST_PASSWORD_HASH,
    });
    for (const member of [first, second]) {
      const bindings = await db.roleBinding.findMany({
        where: { principalType: 'USER', principalId: member.id }, include: { role: true },
      });
      expect(bindings.map(({ role, projectId }) => [role.key, projectId])).toEqual([['member', null]]);
      await request(app.getHttpServer()).get('/api/auth/me').auth(member.token, { type: 'bearer' }).expect(200);
      await request(app.getHttpServer()).get('/api/fleet/dashboard').auth(member.token, { type: 'bearer' }).expect(403);
    }
    await request(app.getHttpServer()).post('/api/auth/login')
      .send({ email: 'first@koda.test', password: 'wrong-password' }).expect(401);
  });
});
