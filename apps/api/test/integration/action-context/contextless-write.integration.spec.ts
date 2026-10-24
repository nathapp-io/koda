/**
 * Permissions P2 US-002 — the context-less write guard on the API's Prisma client, over a real Postgres.
 *
 * The guard is a Prisma client extension, so it is only proven against a real driver adapter: a mocked
 * `query` callback would show nothing about transactions, rollbacks or raw executes. Every client here
 * is constructed by `KodaPrismaClient` on the test database, and the fixtures and reads use a plain
 * `createTestPrismaClient()` (the guard is US-002's; the helpers that make fixture writes legal arrive
 * in US-004).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/action-context/contextless-write.integration.spec.ts
 */
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { KodaPrismaClient } from '../../../src/prisma/koda-prisma-client';
import { ContextlessWriteError } from '../../../src/action-context/contextless-write';
import { restoreEnvAfterEach } from '../../../src/common/test-helpers/restore-env';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { createTestPrismaClient, testDatabaseUrl } from '../../helpers/test-prisma';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

/** The project the request test creates its ticket in; seeded directly, like its user. */
const PROJECT_SLUG = 'guard';
const PROJECT_KEY = 'GRD';
const CREATOR_EMAIL = 'guard-creator@koda.test';

describeIntegration('the context-less write guard on KodaPrismaClient (US-002)', () => {
  // The mode is read from these two variables at construction time; a test that sets them must not
  // change the mode of the client another test builds.
  restoreEnvAfterEach();

  let guarded: KodaPrismaClient;

  const guardedClient = (): KodaPrismaClient => new KodaPrismaClient({ adapter: createPgAdapter(testDatabaseUrl()) });

  /** Runs fn on a fresh guarded client and disconnects it, so a mode test leaves no pool open. */
  const withGuardedClient = async (fn: (client: KodaPrismaClient) => Promise<void>): Promise<void> => {
    const client = guardedClient();
    try {
      await fn(client);
    } finally {
      await client.$disconnect();
    }
  };

  const userData = (email: string) => ({ email, name: 'Guard', passwordHash: 'not-a-real-hash' });

  let app: NathApplication;
  /** The unguarded client the fixtures seed through and the row assertions read through. */
  let plainDb: PrismaClient;
  let projectId = '';
  let creatorToken = '';

  /** The booted application's client: the object every request, repository and transaction writes through. */
  const appClient = (): PrismaClient => app.get<PrismaService<PrismaClient>>(PrismaService).client;

  beforeAll(async () => {
    await resetDb();
    // The story's test-time mode: no context throws. State it explicitly rather than inheriting it.
    process.env['NODE_ENV'] = 'test';
    delete process.env['ENV_NAME'];
    guarded = guardedClient();

    plainDb = createTestPrismaClient();
    const creator = await plainDb.user.create({
      data: { email: CREATOR_EMAIL, name: 'Guard Creator', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    const project = await plainDb.project.create({
      data: { name: 'Guard', slug: PROJECT_SLUG, key: PROJECT_KEY },
    });
    projectId = project.id;
    // `developer` is the project role that holds ticket.create; the baseline binding every principal
    // created through Prisma carries is added on top.
    await grantBaseline(plainDb, { type: 'USER', id: creator.id });
    await grantRole(plainDb, { type: 'USER', id: creator.id }, 'developer', projectId);

    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    creatorToken = await loginToken(app.getHttpServer(), CREATOR_EMAIL);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
    await plainDb?.$disconnect();
    await guarded?.$disconnect();
  }, TIMEOUT);

  it('AC-1: an interactive transaction with no context rejects with ContextlessWriteError', async () => {
    await expect(
      guarded.$transaction(async (tx) => tx.user.create({ data: userData('guard-transaction@koda.test') })),
    ).rejects.toBeInstanceOf(ContextlessWriteError);
  }, TIMEOUT);

  it('AC-2: the rejected transaction leaves no User row with the email it tried to create', async () => {
    const email = 'guard-transaction-rollback@koda.test';

    await expect(
      guarded.$transaction(async (tx) => tx.user.create({ data: userData(email) })),
    ).rejects.toBeInstanceOf(ContextlessWriteError);

    const reader = createTestPrismaClient();
    try {
      await expect(reader.user.count({ where: { email } })).resolves.toBe(0);
    } finally {
      await reader.$disconnect();
    }
  }, TIMEOUT);

  it('AC-6: a client constructed with ENV_NAME=production records the write instead of throwing', async () => {
    process.env['ENV_NAME'] = 'production';
    process.env['NODE_ENV'] = 'test';

    await withGuardedClient(async (client) => {
      await expect(client.$executeRaw`SELECT 1`).resolves.toBe(1);
    });
  }, TIMEOUT);

  it('AC-7: the mode is read once, so ENV_NAME=production after construction does not stop the throw', async () => {
    delete process.env['ENV_NAME'];
    process.env['NODE_ENV'] = 'test';

    await withGuardedClient(async (client) => {
      process.env['ENV_NAME'] = 'production';

      await expect(client.$executeRaw`SELECT 1`).rejects.toBeInstanceOf(ContextlessWriteError);
    });
  }, TIMEOUT);

  it('AC-3: in the booted application, a client write with no context rejects with ContextlessWriteError', async () => {
    await expect(
      appClient().user.create({ data: userData('guard-app-client@koda.test') }),
    ).rejects.toBeInstanceOf(ContextlessWriteError);

    // The rejection arrived before the statement ran: the write left no row.
    await expect(plainDb.user.count({ where: { email: 'guard-app-client@koda.test' } })).resolves.toBe(0);
  }, TIMEOUT);

  it('AC-4: a user holding ticket.create still creates a ticket through POST …/tickets (201)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/projects/${PROJECT_SLUG}/tickets`)
      .auth(creatorToken, { type: 'bearer' })
      .send({ type: 'BUG', title: 'created under the guard' })
      .expect(201);

    expect(data<{ title: string }>(res).title).toBe('created under the guard');

    // The same client refuses a context-less write here, so the 201 above could only have been written
    // through the request's action context.
    await expect(appClient().user.create({ data: userData('guard-app-client-ac4@koda.test') }))
      .rejects.toBeInstanceOf(ContextlessWriteError);
  }, TIMEOUT);

  it('AC-5: the ticket the request created is a row of the project', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/projects/${PROJECT_SLUG}/tickets`)
      .auth(creatorToken, { type: 'bearer' })
      .send({ type: 'TASK', title: 'row check' })
      .expect(201);
    const ticket = data<{ id: string; ref: string }>(created);

    const row = await plainDb.ticket.findUnique({ where: { id: ticket.id } });
    expect(row).toMatchObject({ projectId, title: 'row check', type: 'TASK', deletedAt: null });
    expect(ticket.ref).toBe(`${PROJECT_KEY}-${row?.number}`);
  }, TIMEOUT);
});
