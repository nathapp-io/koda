/**
 * HTTP-level integration tests for GET /projects/:slug/memory.
 *
 * These tests boot the full NestJS app with AppFactory and use supertest so
 * that route registration, guard wiring, and which controller actually handles
 * the request are all exercised. Direct-instantiation tests cannot catch
 * duplicate route registration, decorator/query-name mismatches, or a legacy
 * handler shadowing the new one — HTTP-level tests can.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-memory.integration.spec.ts
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../../src/auth/guards/combined-auth.guard';
import { CommonExceptionCode } from '@nathapp/nestjs-common';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const decisionCount = 20;
const factCount = 35;
const supersededCount = 3;
const activeCount = decisionCount + factCount; // excludes the 1 expired-TTL active item

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
      .send({ name: 'Memory Test Project', slug: 'mem-test-proj', key: 'MEMT', description: 'for memory tests' })
      .expect(201);
    projectSlug = body<{ slug: string }>(projectRes).slug;

    // Register a separate non-member user
    const nonMemberRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'memtest-nonmember@koda.test', name: 'Non Member', password: 'Admin1234!Aa' })
      .expect(201);
    nonMemberToken = body<{ accessToken: string }>(nonMemberRes).accessToken;

    const projectRow = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
    const projectId = projectRow.id;

    // 20 active DECISION items (kind filter + pagination coverage)
    await prisma.client.memoryItem.createMany({
      data: Array.from({ length: decisionCount }, (_, i) => ({
        projectId,
        kind: 'DECISION',
        subject: `ticket:${i}`,
        predicate: 'status',
        object: 'IN_PROGRESS',
        status: 'active',
        activeKey: `decision-${i}`,
      })),
    });

    // 35 active FACT items (bulk, for the size=1000 rejection and paging assertions)
    await prisma.client.memoryItem.createMany({
      data: Array.from({ length: factCount }, (_, i) => ({
        projectId,
        kind: 'FACT',
        subject: `ticket:${i}`,
        predicate: 'assigned_to',
        object: `user:${i}`,
        status: 'active',
        activeKey: `fact-${i}`,
      })),
    });

    // 3 superseded items — must not appear in the default (active) filter
    await prisma.client.memoryItem.createMany({
      data: Array.from({ length: supersededCount }, (_, i) => ({
        projectId,
        kind: 'FACT',
        subject: `ticket:sup-${i}`,
        predicate: 'status',
        object: 'DONE',
        status: 'superseded',
        activeKey: null,
      })),
    });

    // 1 active item with an expired TTL — must not appear in the default (active) filter
    await prisma.client.memoryItem.create({
      data: {
        projectId,
        kind: 'FACT',
        subject: 'ticket:expired',
        predicate: 'status',
        object: 'STALE',
        status: 'active',
        ttlAt: new Date('2000-01-01T00:00:00.000Z'),
        activeKey: 'fact-expired',
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('AC1: records/total reflect the seeded active count for a project member', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ size: '100' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ records: { kind: string; status: string }[]; total: number }>(res);
    expect(Array.isArray(data.records)).toBe(true);
    // size=100 covers the full active count in one page
    expect(data.total).toBe(activeCount);
    expect(data.records.length).toBe(activeCount);
  });

  it('AC2: kind=DECISION returns only DECISION items and the matching total', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ kind: 'DECISION', size: '50' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ records: { kind: string }[]; total: number }>(res);
    expect(data.total).toBe(decisionCount);
    expect(data.records.length).toBeGreaterThan(0);
    expect(data.records.every((item) => item.kind === 'DECISION')).toBe(true);
  });

  it('AC3: default (no status param) returns only active items with non-expired TTL', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ size: '50' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ records: { status: string; subject: string }[]; total: number }>(res);
    expect(data.total).toBe(activeCount);
    expect(data.records.every((item) => item.status === 'active')).toBe(true);
    expect(data.records.some((item) => item.subject === 'ticket:expired')).toBe(false);
  });

  it('AC4: status=superseded returns only superseded items', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ status: 'superseded' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ records: { status: string }[]; total: number }>(res);
    expect(data.total).toBe(supersededCount);
    expect(data.records.length).toBe(supersededCount);
    expect(data.records.every((item) => item.status === 'superseded')).toBe(true);
  });

  it('AC5: current=2&size=10 returns the second page of at most 10 records', async () => {
    const page1 = body<{ records: { subject: string; predicate: string }[]; total: number }>(
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/memory`)
        .query({ current: '1', size: '10' })
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200),
    );
    const page2 = body<{ records: { subject: string; predicate: string }[]; total: number }>(
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/memory`)
        .query({ current: '2', size: '10' })
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200),
    );

    expect(page2.records.length).toBeLessThanOrEqual(10);
    expect(page2.total).toBe(activeCount);
    const page1Subjects = new Set(page1.records.map((item) => item.subject));
    expect(page2.records.some((item) => page1Subjects.has(item.subject))).toBe(false);
  });

  it('AC6: size=1000 is rejected with 400', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ size: '1000' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(400);

    // ValidationAppException error envelope: { ret: REQUEST_PARAMETER_ERROR, message } — no data
    expect(res.body.ret).toBe(CommonExceptionCode.REQUEST_PARAMETER_ERROR);
    expect(res.body).not.toHaveProperty('data');
  });

  it('accepts subject query param without error', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ subject: 'ticket:123' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ records: unknown[]; total: number }>(res);
    expect(Array.isArray(data.records)).toBe(true);
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
