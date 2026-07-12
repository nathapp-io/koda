/**
 * HTTP-level integration tests for GET /projects/:slug/memory.
 *
 * These tests boot the full NestJS app with AppFactory and use supertest so
 * that route registration, guard wiring, and which controller actually handles
 * the request are all exercised. Direct-instantiation tests cannot catch
 * duplicate route registration, decorator/query-name mismatches, or a legacy
 * handler shadowing the new one — HTTP-level tests can.
 *
 * Requires a database: run with DATABASE_URL=file:./koda-test.ephemeral.db
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../../src/auth/guards/combined-auth.guard';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

/** Unwrap JsonResponse { ret: 0, data: T } → data */
function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeIntegration('GET /projects/:slug/memory (HTTP route via MemoryReadController)', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  let memberToken: string;
  let nonMemberToken: string;
  let projectSlug: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb();

    app = await AppFactory.create(AppModule);

    const combinedGuard = app.get(CombinedAuthGuard);
    app.setJwtAuthGuard(combinedGuard);

    app
      .useAppGlobalPrefix()
      .useAppGlobalPipes()
      .useAppGlobalFilters()
      .useAppGlobalGuards();

    await app.init();
    httpServer = app.getHttpServer();

    // Register admin user
    const registerRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'memtest-admin@koda.test', name: 'Memory Test Admin', password: 'Admin1234!Aa' })
      .expect(201);
    const adminData = body<{ accessToken: string }>(registerRes);

    // Promote to ADMIN so they can create a project
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const adminUser = await prisma.client.user.findUnique({ where: { email: 'memtest-admin@koda.test' } });
    await prisma.client.user.update({ where: { id: adminUser?.id }, data: { role: 'ADMIN' } });

    // Re-login to get ADMIN-scoped token
    const loginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'memtest-admin@koda.test', password: 'Admin1234!Aa' })
      .expect(200);
    memberToken = body<{ accessToken: string }>(loginRes).accessToken;

    // Create project — creator becomes a member automatically
    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Memory Test Project', slug: 'mem-test-proj', description: 'for memory tests' })
      .expect(201);
    projectSlug = body<{ slug: string }>(projectRes).slug;

    // Register a separate non-member user
    const nonMemberRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'memtest-nonmember@koda.test', name: 'Non Member', password: 'Admin1234!Aa' })
      .expect(201);
    nonMemberToken = body<{ accessToken: string }>(nonMemberRes).accessToken;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('AC1: returns 200 with items array and total for a project member', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: unknown[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThanOrEqual(0);
  });

  it('AC2: accepts kind query param without error', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ kind: 'FACT' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: unknown[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('AC3: returns 200 with default status behaviour when no status param is given', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    body<{ items: unknown[]; total: number }>(res);
  });

  it('AC4: accepts status=superseded query param without error', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ status: 'superseded' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: unknown[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('AC5: accepts page and limit query params and returns valid envelope', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ page: '2', limit: '10' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: unknown[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
  });

  it('AC6: accepts subject query param without error', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ subject: 'ticket:123' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: unknown[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('AC7: returns 404 for an unknown project slug', async () => {
    await request(httpServer)
      .get('/api/projects/does-not-exist-slug/memory')
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(404);
  });

  it('AC8: returns 403 for a user who is not a member of the project', async () => {
    await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .set('Authorization', `Bearer ${nonMemberToken}`)
      .expect(403);
  });

  it('returns 401 when no auth token is provided', async () => {
    await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .expect(401);
  });

  it('project isolation: returns 404 for a different project slug even with valid token', async () => {
    await request(httpServer)
      .get('/api/projects/other-totally-unknown-project/memory')
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(404);
  });
});
