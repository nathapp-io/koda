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

    // 35 active FACT items (bulk, for the limit=1000 clamp-to-50 assertion)
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

  it('AC1: items/total reflect the seeded active count for a project member', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ limit: '100' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: { kind: string; status: string }[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
    // limit is clamped to 50 server-side, but total must reflect the full active count
    expect(data.total).toBe(activeCount);
    expect(data.items.length).toBeLessThanOrEqual(50);
  });

  it('AC2: kind=DECISION returns only DECISION items and the matching total', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ kind: 'DECISION', limit: '50' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: { kind: string }[]; total: number }>(res);
    expect(data.total).toBe(decisionCount);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((item) => item.kind === 'DECISION')).toBe(true);
  });

  it('AC3: default (no status param) returns only active items with non-expired TTL', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ limit: '50' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: { status: string; subject: string }[]; total: number }>(res);
    expect(data.total).toBe(activeCount);
    expect(data.items.every((item) => item.status === 'active')).toBe(true);
    expect(data.items.some((item) => item.subject === 'ticket:expired')).toBe(false);
  });

  it('AC4: status=superseded returns only superseded items', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ status: 'superseded' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: { status: string }[]; total: number }>(res);
    expect(data.total).toBe(supersededCount);
    expect(data.items.length).toBe(supersededCount);
    expect(data.items.every((item) => item.status === 'superseded')).toBe(true);
  });

  it('AC5: page=2&limit=10 returns the second page of at most 10 items', async () => {
    const page1 = body<{ items: { subject: string; predicate: string }[]; total: number }>(
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/memory`)
        .query({ page: '1', limit: '10' })
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200),
    );
    const page2 = body<{ items: { subject: string; predicate: string }[]; total: number }>(
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/memory`)
        .query({ page: '2', limit: '10' })
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200),
    );

    expect(page2.items.length).toBeLessThanOrEqual(10);
    expect(page2.total).toBe(activeCount);
    const page1Subjects = new Set(page1.items.map((item) => item.subject));
    expect(page2.items.some((item) => page1Subjects.has(item.subject))).toBe(false);
  });

  it('AC6: limit=1000 clamps items to at most 50 while total reflects the full count', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/memory`)
      .query({ limit: '1000' })
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const data = body<{ items: unknown[]; total: number }>(res);
    expect(data.items.length).toBeLessThanOrEqual(50);
    expect(data.total).toBe(activeCount);
  });

  it('accepts subject query param without error', async () => {
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
