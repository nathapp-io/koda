/**
 * US-003: Fix ticket status PATCH no-op — E2E test
 *
 * AC-5: PATCH /api/projects/:slug/tickets/:ref with body { status: 'IN_PROGRESS' }
 *       on a CREATED ticket returns HTTP 200 with data.status === 'IN_PROGRESS'
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

describeIntegration('US-003: Ticket status PATCH E2E', () => {
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
    } catch (_error) {
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
      .send({ email: 'test003@koda.test', name: 'Test User 003', password: 'Test1234!' });

    userAccessToken = body<{ accessToken: string }>(registerRes).accessToken;

    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ name: 'US003 Project', slug: 'us003-proj', key: 'U3' });

    projectSlug = body<{ slug: string }>(projectRes).slug;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('PATCH /api/projects/:slug/tickets/:ref', () => {
    it('AC-5: returns HTTP 200 with data.status IN_PROGRESS when patching a CREATED ticket', async () => {
      const createRes = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Status patch test ticket' })
        .expect(201);

      const ticketRef = body<{ ref: string }>(createRes).ref;

      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}/tickets/${ticketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);

      const ticket = body<{ status: string }>(res);
      expect(ticket.status).toBe('IN_PROGRESS');
    });

    it('AC-5 error: returns 4xx when patching with an invalid transition (CREATED → CLOSED)', async () => {
      const createRes = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Invalid transition test ticket' })
        .expect(201);

      const ticketRef = body<{ ref: string }>(createRes).ref;

      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}/tickets/${ticketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ status: 'CLOSED' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });
});
