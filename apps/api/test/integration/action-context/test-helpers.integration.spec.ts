/**
 * Permissions P2 US-004 — `fixtureDb` and `expectGuardActive` against the booted `AppModule`.
 *
 * The unit spec proves the actor helpers; these five acceptance criteria need the real thing: the
 * application's guarded client (a Prisma client extension, so only a live driver adapter shows
 * whether a fixture write is legal) and a Nest container that resolves `PrismaService`.
 *
 * The negative application of AC-13 builds its own `TestingModule` on the plain generated client: it
 * proves the sentinel rejects a client without the guard, so a converted spec's `expectGuardActive`
 * cannot pass for the wrong reason.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/action-context/test-helpers.integration.spec.ts
 */
import { Test } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { ActionContext } from '../../../src/action-context/action-context';
import { currentContext } from '../../../src/action-context/action-context';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaClient as PlainPrismaClient } from '../../../src/generated/prisma/client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { restoreEnvAfterEach } from '../../../src/common/test-helpers/restore-env';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient, testDatabaseUrl } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

describeIntegration('the guard test helpers (US-004)', () => {
  // The guard mode is read when a client is constructed; a test that changes these must not change
  // the mode of the application another test writes through.
  restoreEnvAfterEach();

  let app: NathApplication;
  /** The unguarded client the row assertions read through: the application's client is under test. */
  let plainDb: PrismaClient;

  const fixtureUser = (email: string) => ({ email, name: 'Guard Fixture', passwordHash: 'not-a-real-hash' });

  beforeAll(async () => {
    await resetDb();
    // The story's test-time mode: a context-less write throws.
    process.env['NODE_ENV'] = 'test';
    delete process.env['ENV_NAME'];

    plainDb = createTestPrismaClient();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
    await plainDb?.$disconnect();
  }, TIMEOUT);

  it('AC-9: fixtureDb(app).user.create(…) with no context resolves to the created User row', async () => {
    const email = 'fixture-db-create@koda.test';

    const row = await fixtureDb(app).user.create({ data: fixtureUser(email) });

    expect(row).toMatchObject({ email, name: 'Guard Fixture', disabled: false });
    expect(row.id).toBeTruthy();
    // The row is really in the database, and the call left no context behind.
    await expect(plainDb.user.count({ where: { email } })).resolves.toBe(1);
    expect(currentContext()).toBeUndefined();
  }, TIMEOUT);

  it('AC-10: fixtureDb(app).$transaction(async () => …) runs its callback as SYSTEM/seed', async () => {
    const context = await fixtureDb(app).$transaction(async () => currentContext());

    expect(context?.actor).toEqual({ type: 'SYSTEM', id: 'seed' });
    expect(context?.origin).toBe('system');
    expect(currentContext()).toBeUndefined();
  }, TIMEOUT);

  it('AC-11: a tagged fixtureDb(app).$executeRaw updating one User row resolves to 1', async () => {
    const email = 'fixture-db-raw@koda.test';
    await fixtureDb(app).user.create({ data: fixtureUser(email) });

    const updated = await fixtureDb(app).$executeRaw`UPDATE "User" SET "name" = ${'raw updated'} WHERE "email" = ${email}`;

    expect(updated).toBe(1);
    await expect(plainDb.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ name: 'raw updated' });
  }, TIMEOUT);

  it('AC-12: expectGuardActive(app) resolves for the booted application', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  }, TIMEOUT);

  it('AC-13: expectGuardActive rejects for a PrismaModule built on the plain generated client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PlainPrismaClient,
          clientOptions: { adapter: createPgAdapter(testDatabaseUrl()) },
        }),
      ],
    }).compile();

    try {
      await moduleRef.init();

      await expect(expectGuardActive(moduleRef)).rejects.toBeInstanceOf(Error);
      await expect(expectGuardActive(moduleRef)).rejects.toMatchObject({
        message: 'the application Prisma client does not refuse context-less writes',
      });
    } finally {
      await moduleRef.close();
    }
  }, TIMEOUT);

  it('fixtureDb passes a read through to the guarded client unchanged', async () => {
    const email = 'fixture-db-read@koda.test';
    await fixtureDb(app).user.create({ data: fixtureUser(email) });

    await expect(fixtureDb(app).user.findUnique({ where: { email } })).resolves.toMatchObject({ email });
  }, TIMEOUT);
});
