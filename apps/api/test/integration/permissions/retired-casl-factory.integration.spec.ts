/**
 * Permissions P1 US-005 — the custom CASL factory is gone and the retired IN_PROGRESS -> VERIFIED
 * state-machine rule changes no HTTP outcome, over the real booted app + Postgres.
 *
 * AC-4 boots `AppModule` (which is what `bootHttpApp` does) and asks the container for the
 * `CaslAbilityFactory` token `@nathapp/nestjs-auth` exports: with koda's own factory removed from the
 * auth module options, nestjs-auth answers with its default `JwtCaslAbilityFactory`.
 *
 * AC-5 is the regression anchor for the deleted rule: a PATCH that asks an IN_PROGRESS ticket to move
 * to VERIFIED still answers 400 with the `tickets` prefix (the missing-rule branch of
 * `validateTransition`), and the ticket keeps its status.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/retired-casl-factory.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { CaslAbilityFactory, JwtCaslAbilityFactory } from '@nathapp/nestjs-auth';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

const readI18n = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, string>;

/** The sentence a `ValidationAppException({}, 'tickets')` answers: the `tickets` prefix, code -2. */
const TICKETS_VALIDATION = readI18n('tickets')['-2'];

describeIntegration('retired CASL factory and IN_PROGRESS -> VERIFIED (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;

  const tokens: Record<string, string> = {};

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    body?: Record<string, unknown>,
  ) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  /**
   * Permissions P1l (US-005): the create route takes no role. `'ADMIN'` means "create it, then bind
   * the global `admin` role" — the binding is the admin, and it mirrors `User.role = 'ADMIN'`.
   */
  const createUser = async (who: string, role: 'MEMBER' | 'ADMIN'): Promise<void> => {
    await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
    }).expect(201);
    if (role === 'ADMIN') {
      const user = await db.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` }, select: { id: true } });
      await grantRole(db, { type: 'USER', id: user.id }, 'admin');
    }
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** A ticket of p1 in the named status, built through the real transition routes as the Owner. */
  const ticketIn = async (status: 'CREATED' | 'IN_PROGRESS'): Promise<string> => {
    const created = await asRoot('post', `/api/projects/${P1_SLUG}/tickets`, { type: 'BUG', title: 'retired rule' }).expect(201);
    const ref = data<{ ref: string }>(created).ref;
    if (status !== 'CREATED') {
      await asRoot('post', `/api/projects/${P1_SLUG}/tickets/${ref}/verify`, { body: 'looks right' }).expect(200);
      await asRoot('post', `/api/projects/${P1_SLUG}/tickets/${ref}/start`).expect(200);
    }
    return ref;
  };

  const statusOf = async (ref: string): Promise<string> => {
    const res = await asRoot('get', `/api/projects/${P1_SLUG}/tickets/${ref}`).expect(200);
    return data<{ status: string }>(res).status;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    // A global admin: the `admin` binding, which mirrors the legacy user-row role ADMIN.
    await createUser('gadmin', 'ADMIN');
    await asRoot('post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-4: the container answers CaslAbilityFactory with the nestjs-auth default JwtCaslAbilityFactory', () => {
    const factory = app.get(CaslAbilityFactory, { strict: false });

    expect(factory).toBeInstanceOf(JwtCaslAbilityFactory);
  }, TIMEOUT);

  it('AC-5: a global admin PATCHing an IN_PROGRESS ticket to VERIFIED gets 400 tickets and the status stays', async () => {
    const ref = await ticketIn('IN_PROGRESS');

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/tickets/${ref}`)
      .set(auth('gadmin'))
      .send({ status: 'VERIFIED' });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(-2);
    expect(res.body.message).toBe(TICKETS_VALIDATION);
    await expect(statusOf(ref)).resolves.toBe('IN_PROGRESS');
  }, TIMEOUT);
});
