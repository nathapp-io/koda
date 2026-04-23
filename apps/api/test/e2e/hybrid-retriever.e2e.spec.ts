/**
 * Hybrid Retriever E2E Tests
 *
 * End-to-end tests for POST /projects/:slug/kb/search via HybridRetrieverService.
 * RED PHASE: These tests fail because HybridRetrieverService is not yet wired into
 * the controller. The implementer will wire it as AC11 requires.
 *
 * Acceptance Criteria:
 * AC3:  Search returns existing KB response fields plus Phase 0 provenance fields
 * AC4:  Returns 403 when caller lacks admin/developer/agent/viewer project role
 * AC11: HybridRetrieverService is wired into RagController as primary search path
 * AC12: Controller applies compatibility filters including graphifyEnabled
 *
 * @see RagController
 * @see HybridRetrieverService
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { execSync } from 'child_process';
import { AppModule } from '../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeIntegration('Hybrid Retriever — KB Search E2E', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  let adminAccessToken: string;
  let developerAccessToken: string;
  let viewerAccessToken: string;
  let outsiderAccessToken: string;
  let projectSlug: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    execSync('bunx prisma db push --force-reset --skip-generate', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL },
    });

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
      .send({ email: 'hybrid-admin@koda.test', name: 'Hybrid Admin', password: 'Admin1234!' })
      .expect(201);
    body<{ id: string }>(adminRegisterRes);

    const adminLoginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'hybrid-admin@koda.test', password: 'Admin1234!' })
      .expect(200);
    adminAccessToken = body<{ accessToken: string }>(adminLoginRes).accessToken;

    const devRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'hybrid-developer@koda.test', name: 'Hybrid Dev', password: 'Dev1234!' })
      .expect(201);
    developerAccessToken = body<{ accessToken: string }>(
      await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'hybrid-developer@koda.test', password: 'Dev1234!' })
        .expect(200),
    ).accessToken;

    const viewerRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'hybrid-viewer@koda.test', name: 'Hybrid Viewer', password: 'Viewer1234!' })
      .expect(201);
    viewerAccessToken = body<{ accessToken: string }>(
      await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'hybrid-viewer@koda.test', password: 'Viewer1234!' })
        .expect(200),
    ).accessToken;

    const outsiderRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'hybrid-outsider@koda.test', name: 'Hybrid Outsider', password: 'Outsider1234!' })
      .expect(201);
    outsiderAccessToken = body<{ accessToken: string }>(
      await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'hybrid-outsider@koda.test', password: 'Outsider1234!' })
        .expect(200),
    ).accessToken;

    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Hybrid E2E Project', slug: 'hybrid-e2e-project', key: 'HYE' })
      .expect(201);
    projectSlug = body<{ slug: string }>(projectRes).slug;

    await request(httpServer)
      .post(`/api/projects/${projectSlug}/kb/documents`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        source: 'ticket',
        sourceId: 'HYE-1',
        content: 'Memory leak in worker pool on high load',
        metadata: { ref: 'HYE-1', type: 'BUG' },
      })
      .expect(201);

    await request(httpServer)
      .post(`/api/projects/${projectSlug}/kb/documents`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        source: 'doc',
        sourceId: 'doc-auth-001',
        content: 'Authentication guide: how to configure JWT tokens',
        metadata: { title: 'Auth Guide' },
      })
      .expect(201);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('AC11: HybridRetrieverService wired as primary search path', () => {
    it('response includes scores array from HybridRetrieverService', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'authentication', limit: 5 })
        .expect(200);

      const data = body<{ scores?: Array<Record<string, number>> }>(res);
      expect(data).toHaveProperty('scores');
      expect(Array.isArray(data.scores)).toBe(true);
      expect(data.scores.length).toBeGreaterThan(0);

      const firstScore = data.scores[0];
      expect(firstScore).toHaveProperty('vectorScore');
      expect(firstScore).toHaveProperty('lexicalScore');
      expect(firstScore).toHaveProperty('entityScore');
      expect(firstScore).toHaveProperty('recencyScore');
      expect(firstScore).toHaveProperty('finalScore');
    });
  });

  describe('AC3: Search returns KB response fields plus Phase 0 provenance', () => {
    it('returns results with source, sourceId, content, score, similarity, metadata, createdAt, provenance', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'authentication', limit: 5 })
        .expect(200);

      const data = body<{ results: Array<Record<string, unknown>> }>(res);
      expect(data.results.length).toBeGreaterThan(0);

      const first = data.results[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('source');
      expect(first).toHaveProperty('sourceId');
      expect(first).toHaveProperty('content');
      expect(first).toHaveProperty('score');
      expect(first).toHaveProperty('similarity');
      expect(first).toHaveProperty('metadata');
      expect(first).toHaveProperty('createdAt');
      expect(first).toHaveProperty('provenance');
    });

    it('response includes retrievedAt at response level', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);

      const data = body<{ provenance: { retrievedAt: string } }>(res);
      expect(data.provenance).toHaveProperty('retrievedAt');
      expect(data.provenance.retrievedAt).toBeDefined();
    });

    it('provenance includes indexedAt and sourceProjectId per result', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'memory leak', limit: 5 })
        .expect(200);

      const data = body<{ results: Array<{ provenance: { indexedAt: string; sourceProjectId: string } }> }>(res);
      expect(data.results.length).toBeGreaterThan(0);
      for (const result of data.results) {
        expect(result.provenance).toHaveProperty('indexedAt');
        expect(result.provenance).toHaveProperty('sourceProjectId');
        expect(typeof result.provenance.indexedAt).toBe('string');
        expect(typeof result.provenance.sourceProjectId).toBe('string');
      }
    });
  });

  describe('AC4: Returns 403 when caller lacks project role', () => {
    it('returns 403 for user with no project role', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${outsiderAccessToken}`)
        .send({ query: 'authentication', limit: 5 })
        .expect(403);
    });

    it('returns 200 for admin', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);
    });

    it('returns 200 for developer', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${developerAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);
    });
  });

  describe('Search behavior', () => {
    it('returns 404 for nonexistent project', async () => {
      await request(httpServer)
        .post('/api/projects/nonexistent-project-slug/kb/search')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(404);
    });

    it('respects limit parameter', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 2 })
        .expect(200);

      const data = body<{ results: Array<unknown> }>(res);
      expect(data.results.length).toBeLessThanOrEqual(2);
    });

    it('uses default limit of 20 when omitted', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth' })
        .expect(200);

      const data = body<{ results: Array<unknown> }>(res);
      expect(data.results.length).toBeLessThanOrEqual(20);
    });

    it('caps limit at 50 when exceeded', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 100 })
        .expect(200);

      const data = body<{ results: Array<unknown> }>(res);
      expect(data.results.length).toBeLessThanOrEqual(50);
    });
  });
});
