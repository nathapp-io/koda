/**
 * US-003 — HTTP integration coverage for POST /api/projects/:slug/webhooks and
 * PATCH /api/projects/:slug/webhooks/:id against a real database and the real auth chain.
 *
 * The whole app is booted with AppFactory (real guards, pipes, filters — including the
 * global CombinedAuthGuard and the ADMIN-only `@RequiredPermission` gate), and the rows are
 * read back through Prisma, so these tests prove the side effects the acceptance criteria
 * describe ("no webhook row exists", "the stored url is unchanged"), not just status codes.
 *
 * The in-process sibling `src/webhook/webhook-routes.spec.ts` covers the same routes without
 * a database (fake Prisma + a stubbed DNS seam, including the unresolvable-hostname case).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/webhook/webhook-routes.integration.spec.ts
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

const TEST_PASSWORD = 'Admin1234!Aa';
const BLOCKED_URL = 'https://10.0.0.5/hook';
const ALLOWED_URL = 'https://93.184.215.14/hook';
const OTHER_ALLOWED_URL = 'https://93.184.215.15/hook';

/** Unwrap JsonResponse { ret: 0, data: T } → data */
function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  return res.body.data as T;
}

describeIntegration('webhook routes over HTTP (US-003)', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService<PrismaClient>;

  let adminToken: string;
  let memberToken: string;
  let projectASlug: string;
  let projectBSlug: string;
  let projectAId: string;
  let projectBId: string;

  /** Registers a webhook through the API and returns its id (201 expected). */
  async function registerWebhook(slug: string, url: string): Promise<string> {
    const res = await request(httpServer)
      .post(`/api/projects/${slug}/webhooks`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url, events: ['STATUS_CHANGE'] })
      .expect(201);
    return body<{ id: string }>(res).id;
  }

  async function storedUrl(id: string): Promise<string | undefined> {
    const row = await prisma.client.webhook.findUnique({ where: { id } });
    return row?.url;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb();

    app = await AppFactory.create(AppModule);
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    httpServer = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);

    // Register the ADMIN (promoted straight in the database, then re-logged-in so the
    // token carries the ADMIN authority the route guard checks).
    await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'webhook-admin@koda.test', name: 'Webhook Admin', password: TEST_PASSWORD })
      .expect(201);
    const adminUser = await prisma.client.user.findUniqueOrThrow({
      where: { email: 'webhook-admin@koda.test' },
    });
    await prisma.client.user.update({ where: { id: adminUser.id }, data: { role: 'ADMIN' } });
    const loginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'webhook-admin@koda.test', password: TEST_PASSWORD })
      .expect(200);
    adminToken = body<{ accessToken: string }>(loginRes).accessToken;

    // A plain (non-ADMIN) user for the 403 case.
    const memberRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'webhook-member@koda.test', name: 'Webhook Member', password: TEST_PASSWORD })
      .expect(201);
    memberToken = body<{ accessToken: string }>(memberRes).accessToken;

    projectASlug = body<{ slug: string }>(
      await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook Alpha', slug: 'webhook-alpha', key: 'WHKA', description: 'webhook tests' })
        .expect(201),
    ).slug;
    projectBSlug = body<{ slug: string }>(
      await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook Beta', slug: 'webhook-beta', key: 'WHKB', description: 'webhook tests' })
        .expect(201),
    ).slug;

    projectAId = (await prisma.client.project.findUniqueOrThrow({ where: { slug: projectASlug } })).id;
    projectBId = (await prisma.client.project.findUniqueOrThrow({ where: { slug: projectBSlug } })).id;
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('AC9: POST with the blocked destination returns 400 and creates no webhook row', async () => {
    const before = await prisma.client.webhook.count({ where: { projectId: projectAId } });

    const res = await request(httpServer)
      .post(`/api/projects/${projectASlug}/webhooks`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url: BLOCKED_URL, events: ['STATUS_CHANGE'] });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CommonExceptionCode.REQUEST_PARAMETER_ERROR);
    const after = await prisma.client.webhook.count({ where: { projectId: projectAId } });
    expect(after).toBe(before);
    expect(await prisma.client.webhook.count({ where: { projectId: projectAId, url: BLOCKED_URL } })).toBe(0);
  });

  it('AC10: POST with the allowed destination returns 201 and stores the webhook', async () => {
    const res = await request(httpServer)
      .post(`/api/projects/${projectASlug}/webhooks`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url: ALLOWED_URL, events: ['STATUS_CHANGE'] });

    expect(res.status).toBe(201);
    const created = body<{ id: string; url: string }>(res);
    expect(created.url).toBe(ALLOWED_URL);
    expect(await storedUrl(created.id)).toBe(ALLOWED_URL);
  });

  it('AC11: PATCH with an http:// url returns 400 and leaves the stored url unchanged', async () => {
    const id = await registerWebhook(projectASlug, OTHER_ALLOWED_URL);

    const res = await request(httpServer)
      .patch(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url: 'http://93.184.215.15/hook' });

    expect(res.status).toBe(400);
    expect(await storedUrl(id)).toBe(OTHER_ALLOWED_URL);
  });

  it('AC12: PATCH { active: false } returns 200 with data.active false and no data.secret', async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    const res = await request(httpServer)
      .patch(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });

    expect(res.status).toBe(200);
    const data = body<{ id: string; active: boolean }>(res);
    expect(data.active).toBe(false);
    expect(data).not.toHaveProperty('secret');
    const row = await prisma.client.webhook.findUniqueOrThrow({ where: { id } });
    expect(row.active).toBe(false);
  });

  it('AC12 boundary: PATCH { active: true } after a deactivation returns 200 with data.active true', async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);
    await prisma.client.webhook.update({ where: { id }, data: { active: false } });

    const res = await request(httpServer)
      .patch(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true });

    expect(res.status).toBe(200);
    expect(body<{ active: boolean }>(res).active).toBe(true);
  });

  it('AC13: PATCH by a user who is not a global ADMIN returns 403 and does not change the row', async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    const res = await request(httpServer)
      .patch(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ active: false });

    expect(res.status).toBe(403);
    const row = await prisma.client.webhook.findUniqueOrThrow({ where: { id } });
    expect(row.active).toBe(true);
  });

  it('AC14: PATCH of a webhook owned by another project returns 404 and leaves it unchanged', async () => {
    const id = await registerWebhook(projectBSlug, OTHER_ALLOWED_URL);
    expect(await prisma.client.webhook.findUniqueOrThrow({ where: { id } })).toBeDefined();
    expect(projectBId).not.toBe(projectAId);

    const res = await request(httpServer)
      .patch(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url: ALLOWED_URL });

    expect(res.status).toBe(404);
    expect(await storedUrl(id)).toBe(OTHER_ALLOWED_URL);
  });

  it('US-003 review: PATCH { events: null } returns 400 and never stores the string "null"', async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    const res = await request(httpServer)
      .patch(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ events: null });

    expect(res.status).toBe(400);
    const row = await prisma.client.webhook.findUniqueOrThrow({ where: { id } });
    expect(row.events).toBe('["STATUS_CHANGE"]');
  });

  it("Slice 2b: DELETE projects/:slug/webhooks/:id of another project's webhook returns 404 and keeps the row", async () => {
    const id = await registerWebhook(projectBSlug, OTHER_ALLOWED_URL);

    const res = await request(httpServer)
      .delete(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).not.toBeNull();
  });

  it("Slice 2b: DELETE projects/:slug/webhooks/:id of the project's own webhook returns 204 and removes the row", async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    await request(httpServer)
      .delete(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    expect(await prisma.client.webhook.findUnique({ where: { id } })).toBeNull();
  });

  it('Slice 2b: DELETE projects/:slug/webhooks/:id under an unknown slug returns 404 and keeps the row', async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    const res = await request(httpServer)
      .delete(`/api/projects/no-such-project/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).not.toBeNull();
  });

  it('Slice 2b: slug-less DELETE webhooks/:id stays the global-ADMIN cross-project route', async () => {
    const id = await registerWebhook(projectBSlug, OTHER_ALLOWED_URL);

    const asMember = await request(httpServer)
      .delete(`/api/webhooks/${id}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(asMember.status).toBe(403);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).not.toBeNull();

    await request(httpServer)
      .delete(`/api/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).toBeNull();
  });
});
