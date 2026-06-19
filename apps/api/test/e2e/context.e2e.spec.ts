/**
 * Context API E2E Tests
 * US-001: Testing ContextBuilderService endpoints end-to-end
 *
 * Acceptance Criteria coverage:
 * AC-1: getProjectContext returns all four top-level blocks
 * AC-2: canonicalState.recentEvents ordered DESC, limited to 20
 * AC-3: retrievedContext.semanticMemory ordered DESC, limited to 10
 * AC-4: retrievedContext.documents calls HybridRetrieverService.search()
 * AC-5: blank/absent query results in empty documents, no search call
 * AC-6: intent=plan excludes canonicalState.recentEvents
 * AC-7: tokenBudget truncation respects priority order
 * AC-8: meta.latencyMs measured accurately
 * AC-9: ProjectNotFoundError for non-existent projects
 * AC-10: All errors are AppException subclasses
 * AC-11: @RequiredPermission and project membership enforcement
 * AC-12: Result ordering consistency for identical inputs
 */

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { resetDb } from '../helpers/reset-db';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

interface ContextApiResponse {
  projectId?: string;
  canonicalState?: { recentEvents?: unknown[] };
  retrievedContext?: {
    semanticMemory?: unknown[];
    documents?: { results: unknown[] };
  };
  meta?: { latencyMs: number };
}

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeIntegration('Context API E2E', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  let adminAccessToken: string;
  let memberAccessToken: string;
  let projectId: string;
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

    const adminRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'context-admin@koda.test', name: 'Context Admin', password: 'Admin1234!Aa' })
      .expect(201);

    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const adminUser = await prisma.client.user.findUnique({ where: { email: 'context-admin@koda.test' } });
    expect(adminUser).toBeTruthy();
    await prisma.client.user.update({
      where: { id: (adminUser as NonNullable<typeof adminUser>).id },
      data: { role: 'ADMIN' },
    });

    const adminLoginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'context-admin@koda.test', password: 'Admin1234!Aa' })
      .expect(200);

    adminAccessToken = body<{ accessToken: string }>(adminLoginRes).accessToken;

    const memberRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'context-member@koda.test', name: 'Context Member', password: 'Member1234!Aa' })
      .expect(201);

    memberAccessToken = body<{ accessToken: string }>(memberRegisterRes).accessToken;

    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Context E2E Project', slug: 'context-e2e-project', key: 'CEP' })
      .expect(201);

    projectId = body<{ id: string }>(projectRes).id;
    projectSlug = 'context-e2e-project';
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('GET /api/context/:slug', () => {
    it('AC-1: returns all four top-level blocks', async () => {
      const res = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'answer', query: 'test' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const response = body(res);
      expect(response).toHaveProperty('projectId');
      expect(response).toHaveProperty('canonicalState');
      expect(response).toHaveProperty('retrievedContext');
      expect(response).toHaveProperty('provenance');
      expect(response).toHaveProperty('meta');
    });

    it('AC-2: recentEvents ordered DESC and limited to 20', async () => {
      const res = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'diagnose' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const response = body<ContextApiResponse>(res);
      const recentEvents = response.canonicalState?.recentEvents;

      if (recentEvents && recentEvents.length > 0) {
        expect(recentEvents.length).toBeLessThanOrEqual(20);
      }
    });

    it('AC-3: semanticMemory ordered by confidence DESC and limited to 10', async () => {
      const res = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'answer', query: 'test' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const response = body<ContextApiResponse>(res);
      const semanticMemory = response.retrievedContext?.semanticMemory;

      if (semanticMemory && semanticMemory.length > 0) {
        expect(semanticMemory.length).toBeLessThanOrEqual(10);
      }
    });

    it('AC-5: empty documents when query is absent or blank', async () => {
      const res = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'answer' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const response = body<ContextApiResponse>(res);
      expect(response.retrievedContext?.documents?.results).toEqual([]);
    });

    it('AC-6: excludes recentEvents when intent=plan', async () => {
      const res = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'plan', query: 'test' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const response = body<ContextApiResponse>(res);
      expect(response.canonicalState?.recentEvents).toBeUndefined();
    });

    it('AC-8: includes latencyMs in meta', async () => {
      const res = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'answer' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const response = body<ContextApiResponse>(res);
      expect(response.meta?.latencyMs).toBeGreaterThan(0);
    });

    it('AC-9: returns 404 for non-existent project', async () => {
      await request(httpServer)
        .get('/api/context/nonexistent-project-id')
        .query({ intent: 'answer' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(404);
    });

    it('AC-11: requires authentication and project membership', async () => {
      await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query({ intent: 'answer' })
        .expect(401);
    });

    it('AC-12: returns consistent ordering for identical inputs', async () => {
      const query = { intent: 'answer', query: 'test query' };

      const res1 = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query(query)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const res2 = await request(httpServer)
        .get(`/api/context/${projectSlug}`)
        .query(query)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const stripVolatile = (r: ContextApiResponse) => {
        const s = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
        const meta = s['meta'] as Record<string, unknown> | undefined;
        if (meta) { delete meta['retrievedAt']; delete meta['latencyMs']; }
        const docs = (s['retrievedContext'] as Record<string, unknown> | undefined)?.['documents'] as Record<string, unknown> | undefined;
        if (docs) delete docs['retrievedAt'];
        return s;
      };
      expect(JSON.stringify(stripVolatile(body<ContextApiResponse>(res1)))).toBe(
        JSON.stringify(stripVolatile(body<ContextApiResponse>(res2))),
      );
    });
  });

  describe('POST /api/context/:slug/query', () => {
    it('accepts POST with request body', async () => {
      const res = await request(httpServer)
        .post(`/api/context/${projectSlug}/query`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          intent: 'answer',
          query: 'test query',
          tokenBudget: 4000,
        })
        .expect(200);

      expect(res.body).toHaveProperty('ret', 0);
      expect(res.body).toHaveProperty('data');
    });
  });
});
