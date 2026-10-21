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
import { seedE2e } from '../../../prisma/seed-e2e-data';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

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

  it('AC-2: seeds twice on the same database and leaves one user and three bindings', async () => {
    await seedE2e(db);
    await seedE2e(db);

    expect(await db.user.count()).toBe(1);
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
});
