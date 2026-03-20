/**
 * Phase 3 — Step 2: API End-to-End Smoke Tests
 *
 * Spins up the full NestJS app with a real SQLite test database and exercises
 * the complete ticket lifecycle via HTTP:
 *
 *   Human auth → Agent auth → Create project →
 *   Bug workflow (create → verify → assign → fix → verify-fix → close) →
 *   Enhancement workflow (create → reject) →
 *   Comments → Labels → Ticket labels
 *
 * Run: DATABASE_URL=file:./koda-test.db bun run test:integration
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { execSync } from 'child_process';

const DATABASE_URL = process.env.DATABASE_URL;

const describeSmoke = DATABASE_URL ? describe : describe.skip;

describeSmoke('Phase 3 — Step 2: API Smoke Tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let httpServer: any;

  // Auth tokens & IDs — set as tests progress
  let userAccessToken: string;
  let agentApiKey: string;
  let agentSlug: string;
  let projectSlug: string;
  let bugTicketRef: string;
  let enhancementTicketRef: string;
  let labelId: string;
  let commentId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    // Ensure the Prisma schema is applied to the SQLite test DB before using it
    execSync('npx prisma db push --force-reset --skip-generate', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );

    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    httpServer = app.getHttpServer();

    // Clean test data before suite (order matters for FK constraints)
    await prisma.ticketActivity.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.ticketLabel.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.label.deleteMany();
    await prisma.agentProject.deleteMany();
    await prisma.agentCapability.deleteMany();
    await prisma.agentRoleEntry.deleteMany();
    await prisma.project.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Human Auth
  // ─────────────────────────────────────────────────────────────────────────

  describe('1. Human Auth', () => {
    it('POST /api/auth/register — creates a user and returns tokens', async () => {
      const res = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'admin@koda.test', name: 'Koda Admin', password: 'Admin1234!' })
        .expect(201);

      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
      expect(res.body.user.email).toBe('admin@koda.test');
      expect(res.body.user.role).toBe('MEMBER');

      userAccessToken = res.body.accessToken;
    });

    it('POST /api/auth/login — returns tokens with correct credentials', async () => {
      const res = await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'admin@koda.test', password: 'Admin1234!' })
        .expect(200);

      expect(res.body.accessToken).toBeTruthy();
      userAccessToken = res.body.accessToken; // Update stored token
    });

    it('POST /api/auth/login — returns 401 with wrong password', async () => {
      await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'admin@koda.test', password: 'wrongpassword' })
        .expect(401);
    });

    it('GET /api/auth/me — returns current user', async () => {
      const res = await request(httpServer)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.email).toBe('admin@koda.test');
    });

    it('GET /api/auth/me — returns 401 without token', async () => {
      await request(httpServer).get('/api/auth/me').expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Agent Registration & Auth
  // ─────────────────────────────────────────────────────────────────────────

  describe('2. Agent Registration & Auth', () => {
    it('POST /api/agents — creates an agent', async () => {
      const res = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          name: 'Subrina Coder',
          maxConcurrentTickets: 3,
          roles: ['DEVELOPER', 'REVIEWER'],
          capabilities: ['typescript', 'nestjs'],
        })
        .expect(201);

      expect(res.body.name).toBe('Subrina Coder');
      expect(res.body.slug).toBe('subrina-coder');
      expect(res.body.apiKey).toBeTruthy(); // Only returned on creation

      agentApiKey = res.body.apiKey;
      agentSlug = res.body.slug;
    });

    it('GET /api/agents/me — returns agent profile via API key', async () => {
      const res = await request(httpServer)
        .get('/api/agents/me')
        .set('Authorization', `Bearer ${agentApiKey}`)
        .expect(200);

      expect(res.body.slug).toBe('subrina-coder');
    });

    it('GET /api/agents/:slug — returns agent by slug', async () => {
      const res = await request(httpServer)
        .get(`/api/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.slug).toBe(agentSlug);
      expect(res.body.roles).toEqual(expect.arrayContaining(['DEVELOPER', 'REVIEWER']));
      expect(res.body.capabilities).toEqual(expect.arrayContaining(['typescript', 'nestjs']));
    });

    it('POST /api/agents/:slug/rotate-key — rotates API key', async () => {
      const res = await request(httpServer)
        .post(`/api/agents/${agentSlug}/rotate-key`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.apiKey).toBeTruthy();
      expect(res.body.apiKey).not.toBe(agentApiKey);
      agentApiKey = res.body.apiKey; // Update for subsequent tests
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Projects
  // ─────────────────────────────────────────────────────────────────────────

  describe('3. Projects', () => {
    it('POST /api/projects — creates a project', async () => {
      const res = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          name: 'Koda Test',
          key: 'KT',
          description: 'Integration test project',
        })
        .expect(201);

      expect(res.body.slug).toBe('koda-test');
      expect(res.body.key).toBe('KT');
      projectSlug = res.body.slug;
    });

    it('GET /api/projects — lists projects', async () => {
      const res = await request(httpServer)
        .get('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/projects/:slug — returns project details', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.slug).toBe(projectSlug);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Labels
  // ─────────────────────────────────────────────────────────────────────────

  describe('4. Labels', () => {
    it('POST /api/projects/:slug/labels — creates a label', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'bug', color: '#e11d48' })
        .expect(201);

      expect(res.body.name).toBe('bug');
      labelId = res.body.id;
    });

    it('GET /api/projects/:slug/labels — lists labels', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Bug Ticket — Full State Machine
  // ─────────────────────────────────────────────────────────────────────────

  describe('5. Bug Ticket — Full State Machine', () => {
    it('POST /api/projects/:slug/tickets — creates a bug ticket', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          type: 'BUG',
          title: 'Login button not responding',
          description: 'Clicking login does nothing on mobile',
          priority: 'HIGH',
        })
        .expect(201);

      expect(res.body.type).toBe('BUG');
      expect(res.body.status).toBe('CREATED');
      expect(res.body.ref).toMatch(/^KT-\d+$/);
      bugTicketRef = res.body.ref;
    });

    it('GET /api/projects/:slug/tickets — lists tickets', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data ?? res.body)).toBe(true);
    });

    it('GET /api/projects/:slug/tickets/:ref — returns ticket by ref', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.ref).toBe(bugTicketRef);
      expect(res.body.status).toBe('CREATED');
    });

    it('POST .../verify — transitions CREATED → VERIFIED', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/verify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ comment: 'Reproduced on iOS Safari. Null ref at auth.ts:42.' })
        .expect(200);

      expect(res.body.status).toBe('VERIFIED');
    });

    it('POST .../assign — assigns ticket to agent (IN_PROGRESS)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/assign`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug })
        .expect(200);

      expect(res.body.status).toBe('IN_PROGRESS');
    });

    it('POST .../fix — transitions IN_PROGRESS → VERIFY_FIX (via agent API key)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/fix`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({
          comment: 'Fixed null ref in auth.ts:42. PR #17 merged.',
          gitRef: 'v1.0.1:src/auth.ts:42',
        })
        .expect(200);

      expect(res.body.status).toBe('VERIFY_FIX');
    });

    it('POST .../verify-fix — transitions VERIFY_FIX → CLOSED', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/verify-fix`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ comment: 'Confirmed fixed on iOS Safari. All tests pass.' })
        .expect(200);

      expect(res.body.status).toBe('CLOSED');
    });

    it('POST ticket label — attaches label to ticket', async () => {
      // Reopen a fresh ticket for label test
      const createRes = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Label test ticket', priority: 'LOW' })
        .expect(201);

      const ticketRef = createRes.body.ref;

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${ticketRef}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ labelId })
        .expect(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Enhancement Ticket — Reject Flow
  // ─────────────────────────────────────────────────────────────────────────

  describe('6. Enhancement Ticket — Reject Flow', () => {
    it('POST /api/projects/:slug/tickets — creates an enhancement ticket', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          type: 'ENHANCEMENT',
          title: 'Add dark mode toggle',
          priority: 'MEDIUM',
        })
        .expect(201);

      expect(res.body.type).toBe('ENHANCEMENT');
      expect(res.body.status).toBe('CREATED');
      enhancementTicketRef = res.body.ref;
    });

    it('POST .../reject — transitions CREATED → REJECTED', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${enhancementTicketRef}/reject`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ comment: 'Out of scope for MVP. Revisit in Phase 5.' })
        .expect(200);

      expect(res.body.status).toBe('REJECTED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Comments
  // ─────────────────────────────────────────────────────────────────────────

  describe('7. Comments', () => {
    it('POST .../comments — adds a comment to a ticket', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/comments`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Tracking this in the next sprint.', type: 'GENERAL' })
        .expect(201);

      expect(res.body.body).toBe('Tracking this in the next sprint.');
      commentId = res.body.id;
    });

    it('GET .../comments — lists comments on a ticket', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/comments`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('PATCH /api/comments/:id — edits a comment', async () => {
      const res = await request(httpServer)
        .patch(`/api/comments/${commentId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Updated: tracking in Q2 sprint.' })
        .expect(200);

      expect(res.body.body).toBe('Updated: tracking in Q2 sprint.');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. State Machine Guard Rails (invalid transitions)
  // ─────────────────────────────────────────────────────────────────────────

  describe('8. State Machine — Invalid Transitions Blocked', () => {
    let freshTicketRef: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Guard rail test ticket', priority: 'LOW' })
        .expect(201);
      freshTicketRef = res.body.ref;
    });

    it('should reject fix on CREATED ticket (not IN_PROGRESS)', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${freshTicketRef}/fix`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({ comment: 'Premature fix attempt' })
        .expect(400);
    });

    it('should reject verify-fix on CREATED ticket', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${freshTicketRef}/verify-fix`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ comment: 'Premature verify-fix' })
        .expect(400);
    });

    it('should reject close on CREATED ticket', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${freshTicketRef}/close`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(400);
    });
  });
});
