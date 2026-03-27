/**
 * US-002: Remove empty-description guard in ticket create
 *
 * Acceptance Criteria:
 * 1. When TicketsService.create() is called with description === '', it returns a ticket where description === null
 * 2. When TicketsService.create() is called with description === undefined, it returns a ticket where description === null
 * 3. When TicketsService.create() is called with description === 'some text', it returns a ticket where description === 'some text'
 * 4. When POST /api/projects/:slug/tickets is called with { type: 'BUG', title: 'T', description: '' }, it returns HTTP 201 with response body data.description === null
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { execSync } from 'child_process';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeIntegration('US-002: Empty Description Support', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let userAccessToken: string;
  let projectSlug: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    try {
      execSync('bunx prisma db push --force-reset --skip-generate', {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL },
      });
    } catch (error) {
      // Database reset may fail if schema is already in sync
    }

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

    const registerRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'test@koda.test', name: 'Test User', password: 'Test1234!' });

    userAccessToken = body<{ accessToken: string }>(registerRes).accessToken;

    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ name: 'Test Project', slug: 'test-proj', key: 'TP' });

    projectSlug = body<{ slug: string }>(projectRes).slug;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('POST /api/projects/:slug/tickets', () => {
    it('AC-4: should allow empty description and return null', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Test Ticket', description: '' })
        .expect(201);

      const ticket = body<{ description: string | null }>(res);
      expect(ticket.description).toBeNull();
    });

    it('AC-2: should allow undefined description and return null', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Test Ticket with undefined desc' })
        .expect(201);

      const ticket = body<{ description: string | null }>(res);
      expect(ticket.description).toBeNull();
    });

    it('AC-3: should preserve non-empty description', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Test Ticket with desc', description: 'This is a description' })
        .expect(201);

      const ticket = body<{ description: string }>(res);
      expect(ticket.description).toBe('This is a description');
    });
  });
});
