import { canRunDbTests } from '../../helpers/test-environment';
/**
 * The e2e seed, as an import-safe module.
 *
 * `prisma/seed-e2e.ts` is the runner that calls it; this spec drives the module directly, so the seed
 * is checked without a script run: the bindings it writes, its idempotence and the access its admin
 * really has.
 */
import request from 'supertest';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { hashPasswordResetToken } from '../../../src/auth/password-reset/password-reset-token';
import { refreshClientOf } from '../../../src/auth/sessions/refresh-client';
import { seedE2e } from '../../../prisma/seed-e2e-data';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const ADMIN_EMAIL = 'admin@koda-e2e.test';
const ADMIN_PASSWORD = 'E2ePassword1!';

describeIntegration('e2e seed (PG)', () => {
  let db: PrismaClient;
  let app: NathApplication | undefined;

  beforeAll(async () => {
    await resetDb();
    db = createTestPrismaClient();
  });

  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  it('AC-1: binds the admin to member and admin globally and to project-admin on fleet-e2e', async () => {
    await seedE2e(db);

    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    const bindings = await db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: admin.id },
      include: { role: { select: { key: true } } },
      orderBy: { role: { key: 'asc' } },
    });

    expect(bindings.map((binding) => [binding.role.key, binding.projectId])).toEqual([
      ['admin', null],
      ['member', null],
      ['project-admin', (await db.project.findUniqueOrThrow({ where: { slug: 'fleet-e2e' } })).id],
    ]);

    // The sentinel of the seed itself: the admin holds no legacy grant.
    await expectBindingOnlyFixtures(db, [{ type: 'USER', id: admin.id }]);
  });

  it('AC-2: seeds twice on the same database and leaves the admin, the journey accounts and three bindings', async () => {
    await seedE2e(db);
    await seedE2e(db);

    // The admin plus the five password-journey accounts (koda #466), which carry no role binding.
    expect(await db.user.count()).toBe(6);
    expect(await db.user.count({ where: { email: ADMIN_EMAIL } })).toBe(1);
    expect(await db.roleBinding.count()).toBe(3);
    expect(await db.project.count()).toBe(1);
  });

  it('AC-3: the seeded admin logs in and reads fleet-e2e through its bindings', async () => {
    await seedE2e(db);
    app = await bootHttpApp({ registrationEnabled: false });
    const server = app.getHttpServer();

    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    const token = data<{ accessToken: string }>(login).accessToken;

    const res = await request(server)
      .get('/api/projects/fleet-e2e')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(data<{ slug: string }>(res).slug).toBe('fleet-e2e');
  });

  /**
   * koda #466: the fixtures the browser password journeys need. The reset tokens and the pre-used
   * refresh token are the things a journey cannot build for itself — the request route writes no
   * token while email is unconfigured, and only the sha256 of a token is stored.
   */
  it('AC-4: seeds the auth fixtures the password journeys need', async () => {
    const fixture = await seedE2e(db);

    // One account per reset token: two of them carry a token that still works, one a dead one.
    for (const key of ['valid', 'replayable', 'expired', 'weak'] as const) {
      const account = fixture.accounts[key];
      expect(account.password).toBeTruthy();
      const user = await db.user.findUniqueOrThrow({ where: { email: account.email } });
      const token = await db.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash: hashPasswordResetToken(account.resetToken) },
      });
      expect(token.userId).toBe(user.id);
      expect(token.usedAt).toBeNull();
      const expired = key === 'expired';
      expect(token.expiresAt.getTime() > Date.now()).toBe(!expired);
    }

    // A refresh token that was already used, bound to the User-Agent the browser journey presents.
    // The signed token names the session and the token row, so the API finds them.
    const claims = JSON.parse(Buffer.from(fixture.refreshToken.split('.')[1] ?? '', 'base64url').toString()) as {
      sub: string; sid: string; jti: string; typ?: string;
    };
    expect(claims.typ).toBe('refresh');

    const refresh = await db.refreshToken.findUniqueOrThrow({ where: { id: claims.jti } });
    expect(refresh.usedAt).not.toBeNull();
    expect(refresh.usedUaHash).toBe(refreshClientOf(fixture.userAgent, undefined).uaHash);
    expect(refresh.sessionId).toBe(claims.sid);

    const session = await db.authSession.findUniqueOrThrow({ where: { id: claims.sid } });
    expect(session.userId).toBe(claims.sub);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
