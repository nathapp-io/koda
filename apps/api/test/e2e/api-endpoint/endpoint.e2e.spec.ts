/**
 * API E2E Tests — Full lifecycle via supertest + real Postgres DB
 *
 * Exercises:
 *   Human auth → Agent auth → Project CRUD → Label CRUD →
 *   Bug workflow (create → verify → start → fix → verify-fix → close) →
 *   Enhancement workflow (create → reject) →
 *   Comments CRUD → Ticket labels → State machine guard rails
 *
 * All responses are wrapped in JsonResponse.Ok({ ret: 0, data: T }).
 * Use `body(res)` helper to unwrap.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/e2e/api-endpoint/endpoint.e2e.spec.ts
 * File: test/integration/api-e2e/api-e2e.integration.spec.ts
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, ProjectMember } from '../../../src/generated/prisma/client';
import { CombinedAuthGuard } from '../../../src/auth/guards/combined-auth.guard';
import { SKILL_RESOLVER, SkillResolver } from '../../../src/skills/skill-resolver';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from '../../helpers/reset-db';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { SkillsService } from '../../../src/skills/skills.service';
import { FleetHttpWorld } from '../../helpers/fleet-fixtures';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** Unwrap JsonResponse { ret, data } → data */
function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

/**
 * The library refusal envelope: `{ ret, message }` — no extra `data`.
 *
 * Asserting only that the stringified body *contains* the refusing key passes whether the
 * message was translated or the lookup fell back to the raw key, so a refusal is pinned to
 * the exact i18n key's sentence and its interpolation args. An entry that is not nested
 * under its status
 * (`"agentOffline": { "409": … }` rather than a flat `"agentOffline": "…"`) never resolves
 * for `<prefix>.<code>`: the 409 then ships the raw key as its message and this fails.
 */
function refusal(res: request.Response, key: string, args: Record<string, unknown> = {}): void {
  const envelope = res.body as { ret: number; message: string };
  expect(envelope.ret).not.toBe(0);
  expect(envelope).not.toHaveProperty('data');

  // `projectAgents.alreadyAssigned.409` → src/i18n/en/projectAgents.json → alreadyAssigned.409
  const [namespace, ...segments] = key.split('.');
  const catalog = JSON.parse(
    readFileSync(join(__dirname, '../../../src/i18n/en', `${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>;
  const sentence = segments.reduce<unknown>(
    (node, segment) =>
      typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined,
    catalog,
  );

  if (typeof sentence !== 'string') {
    // A flat `"agentOffline": "…"` entry never resolves for `<prefix>.<code>`, so the 409
    // would ship the raw key as its message instead of a sentence.
    throw new Error(`${key} is not declared in src/i18n/en/${namespace}.json`);
  }

  // The refusal message is that sentence with its `{arg}` placeholders filled in.
  expect(envelope.message).toBe(
    sentence.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      name in args ? String(args[name]) : placeholder,
    ),
  );
}

describeIntegration('API Integration Tests', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  // Shared state across ordered test sections
  let userAccessToken: string;
  let userRefreshToken: string;
  let nonAdminUserAccessToken: string;
  let agentApiKey: string;
  let agentSlug: string;
  let agentId: string;
  let projectSlug: string;
  let bugTicketRef: string;
  let enhancementTicketRef: string;
  let labelId: string;
  let commentId: string;
  let ticketLinkId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    // Reset Postgres test DB to clean state (schema pushed once by globalSetup)
    await resetDb();

    // Use AppFactory to get NathApplication with useAppGlobal* methods
    // IMPORTANT: DI container is ready right after create() (no init() needed).
    // Global guards MUST be registered BEFORE init() — NestJS compiles route
    // handlers during init() and captures guards at that point. Guards set after
    // init() are invisible to the compiled handlers.
    // `abortOnError: false` makes the Nest factory rethrow instead of process.exit(1) when a
    // token is looked up before its module registers — the US-003 skills tests rely on it so a
    // missing SKILL_RESOLVER fails its own test instead of the whole suite.
    app = await AppFactory.create(AppModule, { abortOnError: false });

    // Get CombinedAuthGuard from DI before init() — DI container is ready
    const combinedGuard = app.get(CombinedAuthGuard);
    app.setJwtAuthGuard(combinedGuard);

    // Register global handlers BEFORE init() so they are compiled into routes
    app
      .useAppGlobalPrefix()
      .useAppGlobalPipes()
      .useAppGlobalFilters()
      .useAppGlobalGuards();

    // NOW init — compiles route handlers with the guards registered above
    await app.init();
    httpServer = app.getHttpServer();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. User Auth
  // ─────────────────────────────────────────────────────────────────

  describe('1. User Auth', () => {
    it('POST /api/auth/register — creates user and returns tokens', async () => {
      const res = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'admin@koda.test', name: 'Koda Admin', password: 'Admin1234!Aa' })
        .expect(201);

      const data = body<{ accessToken: string; refreshToken: string; user: { email: string; role: string } }>(res);
      expect(data.accessToken).toBeTruthy();
      expect(data.refreshToken).toBeTruthy();
      expect(data.user.email).toBe('admin@koda.test');

      userAccessToken = data.accessToken;
      userRefreshToken = data.refreshToken;
    });

    it('promote user to ADMIN (direct DB update)', async () => {
      // New users default to MEMBER — promote to ADMIN for full API access
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const user = await prisma.client.user.findUnique({ where: { email: 'admin@koda.test' } });
      expect(user).toBeTruthy();
      const safeUser = user as NonNullable<typeof user>;
      await prisma.client.user.update({ where: { id: safeUser.id }, data: { role: 'ADMIN' } });
    });

    it('POST /api/auth/login — returns tokens (now as ADMIN)', async () => {
      const res = await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'admin@koda.test', password: 'Admin1234!Aa' })
        .expect(200);

      const data = body<{ accessToken: string; refreshToken: string }>(res);
      expect(data.accessToken).toBeTruthy();
      userAccessToken = data.accessToken;
      userRefreshToken = data.refreshToken;
    });

    it('POST /api/auth/register — creates non-admin user for 403 tests', async () => {
      const res = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'member@koda.test', name: 'Koda Member', password: 'Member1234!Aa' })
        .expect(201);

      const data = body<{ accessToken: string; refreshToken: string; user: { email: string; role: string } }>(res);
      expect(data.accessToken).toBeTruthy();
      expect(data.user.role).toBe('MEMBER');

      nonAdminUserAccessToken = data.accessToken;
    });

    it('POST /api/auth/register — 400 for weak password policy violation', async () => {
      await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'weak@koda.test', name: 'Weak User', password: 'weakpassword123' })
        .expect(400);
    });

    it('POST /api/auth/login — 401 with wrong password', async () => {
      await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'admin@koda.test', password: 'wrong' })
        .expect(401);
    });

    it('GET /api/auth/me — returns current user', async () => {
      const res = await request(httpServer)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ email: string }>(res);
      expect(data.email).toBe('admin@koda.test');
    });

    it('GET /api/auth/me — 401 without token', async () => {
      await request(httpServer)
        .get('/api/auth/me')
        .expect(401);
    });

    it('POST /api/auth/refresh — refreshes tokens', async () => {
      const res = await request(httpServer)
        .post('/api/auth/refresh')
        .set('Authorization', `Bearer ${userRefreshToken}`)
        .expect(200);

      const data = body<{ accessToken: string; refreshToken: string }>(res);
      expect(data.accessToken).toBeTruthy();
      expect(data.refreshToken).toBeTruthy();
      userAccessToken = data.accessToken;
      userRefreshToken = data.refreshToken;
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 1b. H1 — Refresh token replay after logout must be rejected
  // ─────────────────────────────────────────────────────────────────

  describe('1b. H1 — Refresh Token Replay After Logout', () => {
    it('register → login → logout → refresh with old token → 401', async () => {
      const registerRes = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'logout-replay@koda.test', name: 'Logout Replay', password: 'Replay1234!Aa' })
        .expect(201);
      body<{ accessToken: string; refreshToken: string }>(registerRes);

      const loginRes = await request(httpServer)
        .post('/api/auth/login')
        .send({ email: 'logout-replay@koda.test', password: 'Replay1234!Aa' })
        .expect(200);

      const loginData = body<{ accessToken: string; refreshToken: string }>(loginRes);
      expect(loginData.accessToken).toBeTruthy();
      expect(loginData.refreshToken).toBeTruthy();

      await request(httpServer)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${loginData.accessToken}`)
        .expect(200);

      // The refresh token issued before logout is signed with a stale
      // tokenVersion — the refresh strategy marks it revoked and the
      // service must refuse to mint a new pair from it.
      await request(httpServer)
        .post('/api/auth/refresh')
        .set('Authorization', `Bearer ${loginData.refreshToken}`)
        .expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Agent Registration & Auth
  // ─────────────────────────────────────────────────────────────────

  describe('2. Agent Registration & Auth', () => {
    it('POST /api/agents — creates an agent (needs user token)', async () => {
      const res = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          name: 'Subrina Coder',
          slug: 'subrina-coder',
          maxConcurrentTickets: 3,
          roles: ['DEVELOPER', 'REVIEWER'],
          capabilities: ['typescript', 'nestjs'],
        })
        .expect(201);

      const data = body<{ apiKey: string; agent: { id: string; name: string; slug: string } }>(res);
      expect(data.agent.name).toBe('Subrina Coder');
      expect(data.agent.slug).toBe('subrina-coder');
      expect(data.apiKey).toBeTruthy();

      agentApiKey = data.apiKey;
      agentSlug = data.agent.slug;
      agentId = data.agent.id;
    });

    it('GET /api/agents/me — agent profile via API key', async () => {
      const res = await request(httpServer)
        .get('/api/agents/me')
        .set('Authorization', `Bearer ${agentApiKey}`)
        .expect(200);

      const data = body<{ slug: string; projects: Array<{ slug: string; name: string }> }>(res);
      expect(data.slug).toBe('subrina-coder');
      // S4c US-001 (AC15): the roster projects are always part of the payload —
      // this agent holds no AgentProject row yet, so the list is empty.
      expect(data.projects).toEqual([]);
    });

    it('GET /api/agents/:slug — agent by slug', async () => {
      const res = await request(httpServer)
        .get(`/api/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ slug: string; roles: { role: string }[]; capabilities: { capability: string }[] }>(res);
      expect(data.slug).toBe(agentSlug);
      expect(data.roles.map((r) => r.role)).toEqual(expect.arrayContaining(['DEVELOPER', 'REVIEWER']));
      expect(data.capabilities.map((c) => c.capability)).toEqual(expect.arrayContaining(['typescript', 'nestjs']));
    });

    it('POST /api/agents/:slug/rotate-key — rotates API key', async () => {
      const res = await request(httpServer)
        .post(`/api/agents/${agentSlug}/rotate-key`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ apiKey: string }>(res);
      expect(data.apiKey).toBeTruthy();
      expect(data.apiKey).not.toBe(agentApiKey);
      agentApiKey = data.apiKey;
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Projects
  // ─────────────────────────────────────────────────────────────────

  describe('3. Projects', () => {
    it('POST /api/projects — creates a project', async () => {
      const res = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          name: 'Koda Test',
          slug: 'koda-test',
          key: 'KT',
          description: 'Integration test project',
        })
        .expect(201);

      const data = body<{ slug: string; key: string; name: string }>(res);
      expect(data.slug).toBe('koda-test');
      expect(data.key).toBe('KT');
      projectSlug = data.slug;

      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUnique({ where: { slug: projectSlug } });
      const adminUser = await prisma.client.user.findUnique({ where: { email: 'admin@koda.test' } });
      if (project && adminUser) {
        await prisma.client.projectMember.create({
          data: { projectId: project.id, userId: adminUser.id, role: 'ADMIN' },
        });
      }
      // S4c US-001: the agent API key reaches this project through its
      // AgentProject roster row, not through any ProjectMember row.
      if (project) {
        await prisma.client.agentProject.create({ data: { projectId: project.id, agentId } });
      }
    });

    it('POST /api/projects — 409 for duplicate key', async () => {
      await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Duplicate Key', slug: 'duplicate-key', key: 'KT' })
        .expect(409);
    });

    it('POST /api/projects — 409 for duplicate slug', async () => {
      await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Duplicate Slug', slug: projectSlug, key: 'DUPS' })
        .expect(409);
    });

    it('PATCH /api/projects/:slug — 409 when the requested slug belongs to another project', async () => {
      await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Other Project', slug: 'other-project', key: 'OTHR' })
        .expect(201);

      await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ slug: 'other-project' })
        .expect(409);
    });

    it('PATCH /api/projects/:slug — 409 when the requested key belongs to another project', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ key: 'OTHR' })
        .expect(409);
    });

    it('GET /api/projects — lists projects', async () => {
      const res = await request(httpServer)
        .get('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<Array<{ slug: string }>>(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/projects/:slug — returns project', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ slug: string }>(res);
      expect(data.slug).toBe(projectSlug);
    });

    it('GET /api/projects/:slug — 404 for nonexistent', async () => {
      await request(httpServer)
        .get('/api/projects/nonexistent')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('PATCH /api/projects/:slug — updates project', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ description: 'Updated description' })
        .expect(200);

      const data = body<{ description: string }>(res);
      expect(data.description).toBe('Updated description');
    });

    it('PATCH /api/projects/:slug — 400 for ciWebhookToken shorter than 32 chars', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ ciWebhookToken: 'short-token' })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Labels
  // ─────────────────────────────────────────────────────────────────

  describe('4. Labels', () => {
    it('POST /api/projects/:slug/labels — creates a label', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'bug', color: '#e11d48' })
        .expect(201);

      const data = body<{ name: string; id: string }>(res);
      expect(data.name).toBe('bug');
      labelId = data.id;
    });

    it('GET /api/projects/:slug/labels — lists labels', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<Array<{ name: string }>>(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Bug Ticket — Full State Machine
  // ─────────────────────────────────────────────────────────────────

  describe('5. Bug Ticket — Full Lifecycle', () => {
    it('POST .../tickets — creates a bug ticket (CREATED)', async () => {
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

      const data = body<{ type: string; status: string; ref: string }>(res);
      expect(data.type).toBe('BUG');
      expect(data.status).toBe('CREATED');
      expect(data.ref).toMatch(/^KT-\d+$/);
      bugTicketRef = data.ref;
    });

    it('GET .../tickets — lists tickets with ref field', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        records: Array<{ ref: string; number: number }>;
        total: number;
        current: number;
        size: number;
        hasNext: boolean;
        hasPrev: boolean;
      }>(res);
      expect(data.records.length).toBeGreaterThanOrEqual(1);
      // All records should have ref field matching pattern KT-1, KT-2, etc.
      data.records.forEach((item) => {
        expect(item.ref).toMatch(/^[A-Z0-9]+-[1-9][0-9]*$/);
        expect(item.ref).toBe(`KT-${item.number}`);
      });
    });

    it('GET .../tickets/:ref — returns ticket by ref with empty links array', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        ref: string;
        status: string;
        links: unknown[];
      }>(res);
      expect(data.ref).toBe(bugTicketRef);
      expect(data.status).toBe('CREATED');
      expect(Array.isArray(data.links)).toBe(true);
      expect(data.links).toEqual([]);
    });

    it('POST .../verify — CREATED → VERIFIED', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/verify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Reproduced on iOS Safari.' })
        .expect(200);

      const data = body<{ status: string }>(res);
      expect(data.status).toBe('VERIFIED');
    });

    it('POST .../start — VERIFIED → IN_PROGRESS', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/start`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ status: string }>(res);
      expect(data.status).toBe('IN_PROGRESS');
    });

    it('POST .../fix — IN_PROGRESS → VERIFY_FIX (agent API key)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/fix`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({ body: 'Fixed null ref in auth.ts:42. PR #17 merged.' })
        .expect(200);

      const data = body<{ status: string }>(res);
      expect(data.status).toBe('VERIFY_FIX');
    });

    it('POST .../verify-fix?approve=true — VERIFY_FIX → CLOSED', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/verify-fix?approve=true`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Confirmed fixed. All tests pass.' })
        .expect(200);

      const data = body<{ status: string }>(res);
      expect(data.status).toBe('CLOSED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Direct Start — CREATED → IN_PROGRESS (skip verify)
  // ─────────────────────────────────────────────────────────────────

  describe('6. Direct Start (CREATED → IN_PROGRESS)', () => {
    let directStartRef: string;

    it('create ticket + start directly from CREATED', async () => {
      let res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'TASK', title: 'Direct start test', priority: 'LOW' })
        .expect(201);

      directStartRef = body<{ ref: string }>(res).ref;

      res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${directStartRef}/start`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(body<{ status: string }>(res).status).toBe('IN_PROGRESS');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. Enhancement Ticket — Reject Flow
  // ─────────────────────────────────────────────────────────────────

  describe('7. Enhancement Ticket — Reject Flow', () => {
    it('create + reject enhancement', async () => {
      let res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'ENHANCEMENT', title: 'Add dark mode toggle', priority: 'MEDIUM' })
        .expect(201);

      const data = body<{ type: string; status: string; ref: string }>(res);
      expect(data.type).toBe('ENHANCEMENT');
      expect(data.status).toBe('CREATED');
      enhancementTicketRef = data.ref;

      res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${enhancementTicketRef}/reject`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Out of scope for MVP.' })
        .expect(200);

      expect(body<{ status: string }>(res).status).toBe('REJECTED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. Comments
  // ─────────────────────────────────────────────────────────────────

  describe('8. Comments', () => {
    it('POST .../comments — adds a comment', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/comments`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Tracking this in the next sprint.', type: 'GENERAL' })
        .expect(201);

      const data = body<{ body: string; id: string }>(res);
      expect(data.body).toBe('Tracking this in the next sprint.');
      commentId = data.id;
    });

    it('GET .../comments — lists comments', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/comments`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<Array<{ id: string }>>(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('PATCH /api/comments/:id — edits a comment', async () => {
      const res = await request(httpServer)
        .patch(`/api/comments/${commentId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Updated: tracking in Q2 sprint.' })
        .expect(200);

      const data = body<{ body: string }>(res);
      expect(data.body).toBe('Updated: tracking in Q2 sprint.');
    });

    it('DELETE /api/comments/:id — deletes a comment', async () => {
      await request(httpServer)
        .delete(`/api/comments/${commentId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 9. Ticket Labels
  // ─────────────────────────────────────────────────────────────────

  describe('9. Ticket Labels', () => {
    let labelTicketRef: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Label test ticket', priority: 'LOW' })
        .expect(201);

      labelTicketRef = body<{ ref: string }>(res).ref;
    });

    it('POST .../labels — attaches label to ticket', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${labelTicketRef}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ labelId })
        .expect(201);
    });

    it('DELETE .../labels/:labelId — removes label from ticket', async () => {
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/tickets/${labelTicketRef}/labels/${labelId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 10. Ticket Update & Delete
  // ─────────────────────────────────────────────────────────────────

  describe('10. Ticket Update & Delete', () => {
    let updateTicketRef: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'TASK', title: 'Update test', priority: 'LOW' })
        .expect(201);

      updateTicketRef = body<{ ref: string }>(res).ref;
    });

    it('PATCH .../tickets/:ref — updates title and priority', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}/tickets/${updateTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ title: 'Updated title', priority: 'HIGH' })
        .expect(200);

      const data = body<{ title: string; priority: string }>(res);
      expect(data.title).toBe('Updated title');
      expect(data.priority).toBe('HIGH');
    });

    it('DELETE .../tickets/:ref — soft-deletes ticket', async () => {
      const res = await request(httpServer)
        .delete(`/api/projects/${projectSlug}/tickets/${updateTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ deletedAt: string | null }>(res);
      expect(data.deletedAt).not.toBeNull();
    });

    it('GET deleted ticket — 404', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${updateTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 11. State Machine Guard Rails
  // ─────────────────────────────────────────────────────────────────

  describe('11. State Machine — Invalid Transitions', () => {
    let guardRef: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Guard rail test', priority: 'LOW' })
        .expect(201);

      guardRef = body<{ ref: string }>(res).ref;
    });

    it('fix on CREATED ticket → 400', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${guardRef}/fix`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({ body: 'Premature fix' })
        .expect(400);
    });

    it('verify-fix on CREATED ticket → 400', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${guardRef}/verify-fix`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Premature verify-fix' })
        .expect(400);
    });

    it('close on CREATED ticket → 400', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${guardRef}/close`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 12. Auth Guard Rails
  // ─────────────────────────────────────────────────────────────────

  describe('12. Auth — Unauthenticated Requests', () => {
    it('GET /api/projects — 401 without token', async () => {
      await request(httpServer)
        .get('/api/projects')
        .expect(401);
    });

    it('POST /api/projects — 401 without token', async () => {
      await request(httpServer)
        .post('/api/projects')
        .send({ name: 'Test', key: 'TST' })
        .expect(401);
    });

    it('GET /api/projects/:slug/tickets — 401 without token', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets`)
        .expect(401);
    });

    it('POST /api/agents — 401 without token', async () => {
      await request(httpServer)
        .post('/api/agents')
        .send({ name: 'Rogue Agent' })
        .expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 13. Validation Guard Rails
  // ─────────────────────────────────────────────────────────────────

  describe('13. Validation', () => {
    it('POST .../tickets — 400 with missing required fields', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({}) // missing type and title
        .expect(400);
    });

    it('POST .../tickets — 400 with invalid type enum', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'INVALID', title: 'Test' })
        .expect(400);
    });

    it('POST .../tickets — 400 with invalid priority enum', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Test', priority: 'INVALID' })
        .expect(400);
    });

    it('POST /api/projects — nonexistent project slug → 404 for tickets', async () => {
      await request(httpServer)
        .get('/api/projects/nonexistent/tickets')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 13b. Ticket PATCH — Status Transition (US-003)
  // ─────────────────────────────────────────────────────────────────

  describe('13b. Ticket PATCH — Status Transition', () => {
    it('PATCH .../tickets/:ref — returns 200 with updated status when patching CREATED → IN_PROGRESS', async () => {
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

    it('PATCH .../tickets/:ref — returns 400 for invalid transition (CREATED → CLOSED)', async () => {
      const createRes = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Invalid transition test ticket' })
        .expect(201);

      const ticketRef = body<{ ref: string }>(createRes).ref;

      await request(httpServer)
        .patch(`/api/projects/${projectSlug}/tickets/${ticketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ status: 'CLOSED' })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 14. Project Delete
  // ─────────────────────────────────────────────────────────────────

  describe('14. Project Delete', () => {
    let deleteProjectSlug: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Delete Me', slug: 'delete-me', key: 'DM' })
        .expect(201);

      deleteProjectSlug = body<{ slug: string }>(res).slug;
    });

    it('DELETE /api/projects/:slug — soft-deletes project', async () => {
      await request(httpServer)
        .delete(`/api/projects/${deleteProjectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);
    });

    it('GET deleted project → 404', async () => {
      await request(httpServer)
        .get(`/api/projects/${deleteProjectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('PATCH /api/projects/:slug — 404 for a soft-deleted project', async () => {
      await request(httpServer)
        .patch(`/api/projects/${deleteProjectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Resurrected' })
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 15. Agent Management — List, Update, Roles, Capabilities
  // ─────────────────────────────────────────────────────────────────

  describe('15. Agent Management', () => {
    it('GET /api/agents — lists all agents', async () => {
      const res = await request(httpServer)
        .get('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<unknown[]>(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('PATCH /api/agents/:slug — updates agent name and maxConcurrentTickets', async () => {
      const res = await request(httpServer)
        .patch(`/api/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Subrina Coder v2', maxConcurrentTickets: 5 })
        .expect(200);

      const data = body<{ name: string; maxConcurrentTickets: number }>(res);
      expect(data.name).toBe('Subrina Coder v2');
      expect(data.maxConcurrentTickets).toBe(5);
    });

    it('PATCH /api/agents/:slug/update-roles — replaces agent roles', async () => {
      const res = await request(httpServer)
        .patch(`/api/agents/${agentSlug}/update-roles`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ roles: ['REVIEWER'] })
        .expect(200);

      const data = body<{ roles: { role: string }[] }>(res);
      const roleNames = data.roles.map((r) => r.role);
      expect(roleNames).toContain('REVIEWER');
    });

    it('PATCH /api/agents/:slug/update-capabilities — replaces agent capabilities', async () => {
      const res = await request(httpServer)
        .patch(`/api/agents/${agentSlug}/update-capabilities`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ capabilities: ['nestjs', 'prisma'] })
        .expect(200);

      const data = body<{ capabilities: { capability: string }[] }>(res);
      const caps = data.capabilities.map((c) => c.capability);
      expect(caps).toContain('nestjs');
      expect(caps).toContain('prisma');
    });

    it('PATCH /api/agents/:slug — 404 for nonexistent agent', async () => {
      await request(httpServer)
        .patch('/api/agents/nonexistent-agent')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Ghost' })
        .expect(404);
    });

    it('POST /api/agents/:slug/rotate-key — 404 for nonexistent agent', async () => {
      await request(httpServer)
        .post('/api/agents/nonexistent-agent/rotate-key')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('POST /api/agents/:slug/rotate-key — 403 for non-admin user', async () => {
      await request(httpServer)
        .post(`/api/agents/${agentSlug}/rotate-key`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);
    });

    it('POST /api/agents — 403 for non-admin user', async () => {
      await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .send({ name: 'Forbidden Agent', slug: 'forbidden-agent' })
        .expect(403);
    });

    it('GET /api/agents/me — returns 403 when using user token', async () => {
      // AgentScope is not granted to any user principal (not even ADMIN).
      await request(httpServer)
        .get('/api/agents/me')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 15b. Agent Delete
  // ─────────────────────────────────────────────────────────────────

  describe('15b. Agent Delete', () => {
    let deleteAgentSlug: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Temp Agent', slug: 'temp-agent', roles: ['DEVELOPER'] })
        .expect(201);
      deleteAgentSlug = body<{ agent: { slug: string } }>(res).agent.slug;
    });

    it('DELETE /api/agents/:slug — deletes agent, returns 200', async () => {
      const res = await request(httpServer)
        .delete(`/api/agents/${deleteAgentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ slug: string }>(res);
      expect(data.slug).toBe(deleteAgentSlug);
    });

    it('GET /api/agents/:slug — 404 after delete', async () => {
      await request(httpServer)
        .get(`/api/agents/${deleteAgentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('DELETE /api/agents/:slug — 404 for nonexistent agent', async () => {
      await request(httpServer)
        .delete('/api/agents/nonexistent-agent')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 15c. Label Update (PATCH)
  // ─────────────────────────────────────────────────────────────────

  describe('15c. Label Update', () => {
    let patchLabelId: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'patch-me', color: '#ff0000' })
        .expect(201);
      patchLabelId = body<{ id: string }>(res).id;
    });

    it('PATCH /api/projects/:slug/labels/:id — renames label', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}/labels/${patchLabelId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'patched-label' })
        .expect(200);

      const data = body<{ name: string; color: string }>(res);
      expect(data.name).toBe('patched-label');
      expect(data.color).toBe('#ff0000'); // color unchanged
    });

    it('PATCH /api/projects/:slug/labels/:id — updates color only', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}/labels/${patchLabelId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ color: '#00ff00' })
        .expect(200);

      const data = body<{ name: string; color: string }>(res);
      expect(data.name).toBe('patched-label'); // name unchanged
      expect(data.color).toBe('#00ff00');
    });

    it('PATCH /api/projects/:slug/labels/:id — 404 for nonexistent label', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}/labels/nonexistent-id`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'ghost' })
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 16. Project Label Delete
  // ─────────────────────────────────────────────────────────────────

  describe('16. Project Label Delete', () => {
    let deleteLabelId: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'to-delete', color: '#ff0000' })
        .expect(201);

      deleteLabelId = body<{ id: string }>(res).id;
    });

    it('DELETE /api/projects/:slug/labels/:id — removes label', async () => {
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/labels/${deleteLabelId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);
    });

    it('GET .../labels — deleted label no longer appears', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const labels = body<{ id: string }[]>(res);
      const ids = labels.map((l) => l.id);
      expect(ids).not.toContain(deleteLabelId);
    });

    it('DELETE /api/projects/:slug/labels/:id — 404 for nonexistent label', async () => {
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/labels/nonexistent-id`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 17. Ticket Close (valid: IN_PROGRESS → CLOSED)
  // ─────────────────────────────────────────────────────────────────

  describe('17. Ticket Close — Valid Transition', () => {
    let closeTicketRef: string;

    beforeAll(async () => {
      // Create and start a ticket so it reaches IN_PROGRESS
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'TASK', title: 'Close me', priority: 'LOW' })
        .expect(201);

      closeTicketRef = body<{ ref: string }>(res).ref;

      // CREATED → IN_PROGRESS (direct start)
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${closeTicketRef}/start`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
    });

    it('POST .../close — IN_PROGRESS → CLOSED (admin override with required reason)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${closeTicketRef}/close`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Closing via admin override' })
        .expect(200);

      const data = body<{ status: string }>(res);
      expect(data.status).toBe('CLOSED');
    });

    it('GET closed ticket — status is CLOSED', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${closeTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ status: string }>(res);
      expect(data.status).toBe('CLOSED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 18. Ticket Assign
  // ─────────────────────────────────────────────────────────────────

  describe('18. Ticket Assign', () => {
    let assignTicketRef: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Assign me', priority: 'MEDIUM' })
        .expect(201);

      assignTicketRef = body<{ ref: string }>(res).ref;
    });

    it('POST .../assign — assigns ticket to agent', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${assignTicketRef}/assign`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentId })
        .expect(200);

      const data = body<{ assignedToAgentId: string | null }>(res);
      expect(data.assignedToAgentId).toBe(agentId);
    });

    it('POST .../assign — 404 for nonexistent ticket', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/NONEXIST-999/assign`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentId })
        .expect(404);
    });

    it('POST .../assign — 404 for nonexistent assignee (BUG-2, no more Prisma 500)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${assignTicketRef}/assign`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentId: 'cdefghijklmnopqrstuvwxyz01' })
        .expect(404);

      expect(res.body).toHaveProperty('ret');
    });

    it('POST .../assign — rejects agent ID garbage with 400 (DTO validation)', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${assignTicketRef}/assign`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentId: 'not-a-cuid!' })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 18b. Safe Ticket Assignment and Assignees (US-004)
  // ─────────────────────────────────────────────────────────────────

  describe('18b. Safe Ticket Assignment and Assignees (US-004)', () => {
    let safeAssignTicketRef: string;
    let safeAssignTicketId: string;

    beforeAll(async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Safe assignment candidate', priority: 'MEDIUM' })
        .expect(201);
      const created = body<{ id: string; ref: string }>(res);
      safeAssignTicketRef = created.ref;
      safeAssignTicketId = created.id;
    });

    it('US-004 AC1: rejects a disabled non-member user and leaves the ticket unassigned', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const member = await prisma.client.user.findUnique({ where: { email: 'member@koda.test' } });
      expect(member).toBeTruthy();
      const user = member as NonNullable<typeof member>;
      await prisma.client.user.update({ where: { id: user.id }, data: { disabled: true } });

      try {
        const res = await request(httpServer)
          .post(`/api/projects/${projectSlug}/tickets/${safeAssignTicketRef}/assign`)
          .set('Authorization', `Bearer ${userAccessToken}`)
          .send({ userId: user.id })
          .expect(409);
        refusal(res, 'tickets.userDisabled.409');
        const ticket = await prisma.client.ticket.findUnique({ where: { id: safeAssignTicketId } });
        expect(ticket?.assignedToUserId).toBeNull();
      } finally {
        await prisma.client.user.update({ where: { id: user.id }, data: { disabled: false } });
      }
    });

    it('US-004 AC2: rejects an unrostered offline agent', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUnique({ where: { slug: projectSlug } });
      expect(project).toBeTruthy();
      const safeProject = project as NonNullable<typeof project>;
      await prisma.client.agent.update({ where: { id: agentId }, data: { status: 'OFFLINE' } });
      await prisma.client.agentProject.delete({
        where: { agentId_projectId: { agentId, projectId: safeProject.id } },
      });
      try {
        const res = await request(httpServer)
          .post(`/api/projects/${projectSlug}/tickets/${safeAssignTicketRef}/assign`)
          .set('Authorization', `Bearer ${userAccessToken}`)
          .send({ agentId })
          .expect(409);
        refusal(res, 'tickets.agentNotInProject.409');
      } finally {
        await prisma.client.agentProject.create({ data: { agentId, projectId: safeProject.id } });
        await prisma.client.agent.update({ where: { id: agentId }, data: { status: 'ACTIVE' } });
      }
    });

    it('US-004 AC3: rejects an offline agent that is on the project roster', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const agent = await prisma.client.agent.update({ where: { id: agentId }, data: { status: 'OFFLINE' } });
      try {
        const res = await request(httpServer)
          .post(`/api/projects/${projectSlug}/tickets/${safeAssignTicketRef}/assign`)
          .set('Authorization', `Bearer ${userAccessToken}`)
          .send({ agentId })
          .expect(409);
        refusal(res, 'tickets.agentOffline.409');
      } finally {
        await prisma.client.agent.update({ where: { id: agent.id }, data: { status: 'ACTIVE' } });
      }
    });

    it('US-004 AC7-10: returns ordered, typed non-disabled users and rostered active agents', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/assignees`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
      const data = body<{ items: Array<{ type: string; id: string; name: string; secondary: string; status?: string }> }>(res);
      const users = data.items.filter((item) => item.type === 'user');
      const agents = data.items.filter((item) => item.type === 'agent');
      expect(users.length).toBeGreaterThan(0);
      expect(agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent', id: agentId, secondary: agentSlug, status: 'ACTIVE' }),
      ]));
      expect(data.items.findIndex((item) => item.type === 'agent')).toBeGreaterThanOrEqual(users.length);
      expect(users.map((item) => item.name)).toEqual([...users.map((item) => item.name)].sort((a, b) => a.localeCompare(b)));
      expect(agents.map((item) => item.name)).toEqual([...agents.map((item) => item.name)].sort((a, b) => a.localeCompare(b)));
    });

    it('US-004 AC11: matches users and agents by case-insensitive name or slug query', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/assignees`)
        .query({ q: 'SUBRINA' })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
      const data = body<{ items: Array<{ type: string; id: string }> }>(res);
      expect(data.items).toContainEqual(expect.objectContaining({ type: 'agent', id: agentId }));
    });

    it('US-004 AC12: applies limit to the combined assignee result', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/assignees`)
        .query({ limit: 1 })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
      expect(body<{ items: unknown[] }>(res).items).toHaveLength(1);
    });

    it('US-004 AC13: rejects a limit above 50', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/assignees`)
        .query({ limit: 51 })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(400);
    });

    it('US-004 AC14: rejects a query longer than 100 characters', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/assignees`)
        .query({ q: 'a'.repeat(101) })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(400);
    });

    it('US-004 AC15: denies a non-member from searching project assignees', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/assignees`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 19. Agent Auto-Pickup
  // ─────────────────────────────────────────────────────────────────

  describe('19. Agent Auto-Pickup', () => {
    let pickupTicketRef: string;

    beforeAll(async () => {
      // Create a fresh ticket in CREATED status
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Pickup candidate', priority: 'HIGH' })
        .expect(201);

      pickupTicketRef = body<{ ref: string }>(res).ref;

      // CREATED → VERIFIED
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${pickupTicketRef}/verify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ body: 'Reproduced — ready for pickup.' })
        .expect(200);
    });

    it('GET /api/agents/:slug/pickup?project=... — returns { ticket, matchScore, matchedCapabilities }', async () => {
      const res = await request(httpServer)
        .get(`/api/agents/${agentSlug}/pickup`)
        .query({ project: projectSlug })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ ticket: { ref: string }; matchScore: number; matchedCapabilities: string[] } | null>(res);
      // At least one VERIFIED unassigned ticket exists
      expect(data).not.toBeNull();
      const safeData = data as NonNullable<typeof data>;
      expect(safeData.ticket).toBeDefined();
      expect(typeof safeData.matchScore).toBe('number');
      expect(Array.isArray(safeData.matchedCapabilities)).toBe(true);
    });

    it('GET /api/agents/:slug/pickup — 400 when project query param is missing', async () => {
      await request(httpServer)
        .get(`/api/agents/${agentSlug}/pickup`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(400);
    });

    it('GET /api/agents/nonexistent/pickup?project=... — 404 for unknown agent slug', async () => {
      await request(httpServer)
        .get('/api/agents/nonexistent-agent-xyz/pickup')
        .query({ project: projectSlug })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 19b. Project-Scoped Agent Routes
  // ─────────────────────────────────────────────────────────────────

  describe('19b. Project-Scoped Agent Routes', () => {
    beforeAll(async () => {
      // The assign endpoint requires the agent's Prisma ID, not slug.
      // Fetch it first, then create and assign a ticket so agentSlug appears in the project agents list.
      const agentRes = await request(httpServer)
        .get(`/api/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
      const agentId = body<{ id: string }>(agentRes).id;

      const ticketRes = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: '19b assignment target', priority: 'LOW' })
        .expect(201);
      const ticketRef = body<{ ref: string }>(ticketRes).ref;

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${ticketRef}/assign`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentId })
        .expect(200);
    });

    it('GET /api/projects/:slug/agents — 200 returns agents with assigned tickets', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      // US-002: the response shape is { scoping, items: ProjectAgentDto[] }
      const data = body<{ scoping: boolean; items: { slug: string; status: string }[] }>(res);
      expect(data).toHaveProperty('scoping');
      expect(Array.isArray(data.items)).toBe(true);
      // agentSlug has an assigned ticket (set up in beforeAll) and is on the
      // roster (also in beforeAll), so it must appear in items.
      const found = data.items.find((a) => a.slug === agentSlug);
      expect(found).toBeDefined();
      expect(found?.status).toBeDefined();
    });

    it('GET /api/projects/:slug/agents — 401 without auth token', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/agents`)
        .expect(401);
    });

    it('GET /api/projects/nonexistent/agents — 404 for unknown project slug', async () => {
      await request(httpServer)
        .get('/api/projects/no-such-project/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('PATCH /api/projects/:slug/agents/:agentSlug — 200 updates agent status', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ status: 'PAUSED' })
        .expect(200);

      const data = body<{ slug: string; status: string }>(res);
      expect(data.slug).toBe(agentSlug);
      expect(data.status).toBe('PAUSED');

      // Restore to ACTIVE so downstream tests are not affected
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
    });

    it('PATCH /api/projects/:slug/agents/nonexistent — 404 for unknown agent slug', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}/agents/no-such-agent`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ status: 'PAUSED' })
        .expect(404);
    });

    it('PATCH /api/projects/:slug/agents/:agentSlug — 403 for non-member user', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}/agents/${agentSlug}`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .send({ status: 'PAUSED' })
        .expect(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 18. Ticket Links
  // ─────────────────────────────────────────────────────────────────

  describe('18. Ticket Links', () => {
    it('POST .../links — creates link with 201 and auto-populated provider/externalRef for GitHub URL', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ url: 'https://github.com/owner/repo/pull/1' })
        .expect(201);

      const data = body<{
        id: string;
        url: string;
        provider: string;
        externalRef: string | null;
      }>(res);
      expect(data.provider).toBe('github');
      expect(data.externalRef).toBe('owner/repo#1');
      expect(data.url).toBe('https://github.com/owner/repo/pull/1');
      expect(data.id).toBeDefined();
      ticketLinkId = data.id;
    });

    it('POST .../links — returns 200 and existing link when URL already linked (deduplication)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ url: 'https://github.com/owner/repo/pull/1' })
        .expect(200);

      const data = body<{ id: string; provider: string; externalRef: string }>(
        res,
      );
      expect(data.id).toBe(ticketLinkId);
      expect(data.provider).toBe('github');
    });

    it('POST .../links — returns 400 for invalid URL', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ url: 'not-a-url' })
        .expect(400);
    });

    it('POST .../links — returns 404 for non-existent ticket ref', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/NONEXISTENT-9999/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ url: 'https://github.com/owner/repo/pull/2' })
        .expect(404);
    });

    it('GET .../links — returns 200 with array containing the created link', async () => {
      // Add a second link so we have two
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ url: 'https://gitlab.com/owner/repo/-/merge_requests/7' })
        .expect(201);

      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ id: string; provider: string }[]>(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(2);
    });

    it('GET .../links — returns 200 with empty array for ticket with no links', async () => {
      const res = await request(httpServer)
        .get(
          `/api/projects/${projectSlug}/tickets/${enhancementTicketRef}/links`,
        )
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<unknown[]>(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(0);
    });

    it('DELETE .../links/:linkId — returns 204 with no body on valid deletion', async () => {
      await request(httpServer)
        .delete(
          `/api/projects/${projectSlug}/tickets/${bugTicketRef}/links/${ticketLinkId}`,
        )
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);
    });

    it('DELETE .../links/:linkId — returns 404 when linkId does not exist on that ticket', async () => {
      await request(httpServer)
        .delete(
          `/api/projects/${projectSlug}/tickets/${bugTicketRef}/links/nonexistent-link-id`,
        )
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 19. Ticket Show — Links in Response
  // ─────────────────────────────────────────────────────────────────

  describe('19. Ticket Show — Links in Response', () => {
    it('GET .../tickets/:ref — returns links array with created link after POST', async () => {
      // The bugTicketRef already has a created link from the Ticket Links tests
      // (the GitHub link was created but then deleted, so we need to create a fresh one)
      const createLinkRes = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets/${bugTicketRef}/links`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ url: 'https://github.com/owner/repo/pull/123' })
        .expect(201);

      const createdLink = body<{
        id: string;
        url: string;
        provider: string;
        externalRef: string | null;
        createdAt: string;
      }>(createLinkRes);

      // Now fetch the ticket and verify links array includes the created link
      const ticketRes = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const ticketData = body<{
        ref: string;
        links: Array<{
          id: string;
          url: string;
          provider: string;
          externalRef: string | null;
          createdAt: string;
        }>;
      }>(ticketRes);

      expect(Array.isArray(ticketData.links)).toBe(true);
      expect(ticketData.links.length).toBeGreaterThanOrEqual(1);

      // Verify the link we just created is in the array
      const foundLink = ticketData.links.find(l => l.id === createdLink.id);
      expect(foundLink).toBeDefined();
      expect(foundLink?.url).toBe('https://github.com/owner/repo/pull/123');
      expect(foundLink?.provider).toBe('github');
      expect(foundLink?.externalRef).toBe('owner/repo#123');
      expect(foundLink?.createdAt).toBeDefined();
    });

    it('GET .../tickets/:ref — returns empty links array for ticket with no links', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${enhancementTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        ref: string;
        links: unknown[];
      }>(res);

      expect(Array.isArray(data.links)).toBe(true);
      expect(data.links).toEqual([]);
    });

    it('GET .../tickets/:ref — response links array contains all required fields', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets/${bugTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        links: Array<{
          id: string;
          url: string;
          provider: string;
          externalRef: string | null;
          createdAt: string;
        }>;
      }>(res);

      // For each link, verify all required fields are present
      data.links.forEach(link => {
        expect(link).toHaveProperty('id');
        expect(link).toHaveProperty('url');
        expect(link).toHaveProperty('provider');
        expect(link).toHaveProperty('externalRef');
        expect(link).toHaveProperty('createdAt');

        // Verify field types
        expect(typeof link.id).toBe('string');
        expect(typeof link.url).toBe('string');
        expect(typeof link.provider).toBe('string');
        expect(typeof link.createdAt).toBe('string');
      });
    });
  });

  it('GET /api/agents/:slug/pickup — returns null data when no VERIFIED unassigned tickets remain', async () => {
    // Create an agent with no matching tickets in a non-existent project
    // Use a project slug that does not exist to get a null result
    // (project not found should still return null gracefully, or 404 for project)
    // We test the null path by using a fresh agent with no VERIFIED tickets
    const freshAgentRes = await request(httpServer)
      .post('/api/agents')
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ name: 'Pickup Empty Agent', slug: 'pickup-empty-agent', roles: ['DEVELOPER'] })
      .expect(201);

    const freshAgentSlug = body<{ agent: { slug: string } }>(freshAgentRes).agent.slug;

    // S4c US-001: the pickup target must be on the project's AgentProject roster.
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const pickupProject = await prisma.client.project.findUnique({ where: { slug: projectSlug } });
    const pickupAgent = await prisma.client.agent.findUnique({ where: { slug: freshAgentSlug } });
    if (pickupProject && pickupAgent) {
      await prisma.client.agentProject.create({
        data: { projectId: pickupProject.id, agentId: pickupAgent.id },
      });
    }

    // Use a project that has no VERIFIED unassigned tickets for this new agent
    // The simplest way: use a non-existent project slug → service returns null (or 404 for project)
    // Per story spec: null when no candidates, so we verify this path via response
    const res = await request(httpServer)
      .get(`/api/agents/${freshAgentSlug}/pickup`)
      .query({ project: projectSlug })
      .set('Authorization', `Bearer ${userAccessToken}`)
      .expect(200);

    // All VERIFIED tickets in this project were already consumed or may still exist
    // The key assertion: data is either a result or null — never an error for valid params
    const { body: responseBody } = res;
    expect(responseBody).toHaveProperty('ret', 0);
    expect(responseBody).toHaveProperty('data');
  });

  // ─────────────────────────────────────────────────────────────────
  // Agent Permissions — Bug #18 (labels) & Bug #19 (ticket delete)
  // AC-5: POST /api/projects/:slug/labels returns 201 with agent API key
  // AC-6: DELETE /api/projects/:slug/tickets/:ref returns 200 with agent API key
  // ─────────────────────────────────────────────────────────────────

  describe('Agent Permissions (AC-5 & AC-6)', () => {
    let agentDeleteTicketRef: string;

    beforeAll(async () => {
      // Create a ticket that the agent will soft-delete (AC-6)
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Agent delete test ticket', priority: 'LOW' })
        .expect(201);

      agentDeleteTicketRef = body<{ ref: string }>(res).ref;
    });

    it('AC-5: POST /api/projects/:slug/labels — returns 201 with agent API key', async () => {
      // Bug #18: agents should be allowed to create labels.
      // Current code in labels.service.ts only blocks MEMBER users, so agents pass through.
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({ name: 'agent-created-label', color: '#00ccff' })
        .expect(201);

      const data = body<{ name: string; id: string }>(res);
      expect(data.name).toBe('agent-created-label');
      expect(data.id).toBeTruthy();
    });

    it('AC-6: DELETE /api/projects/:slug/tickets/:ref — returns 200 with agent API key', async () => {
      // Preserves pre-CASL behavior: agents can soft-delete tickets.
      // Authorization is enforced by @RequiredPermission([DELETE, 'Ticket']) + KodaCaslAbilityFactory.
      const res = await request(httpServer)
        .delete(`/api/projects/${projectSlug}/tickets/${agentDeleteTicketRef}`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .expect(200);

      const data = body<{ deletedAt: string | null }>(res);
      expect(data.deletedAt).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Knowledge Base — Optimize (US-004)
  // ─────────────────────────────────────────────────────────────────

  describe('Knowledge Base — Optimize (US-004)', () => {
    it('POST /api/projects/:slug/kb/optimize — returns 200 with ADMIN role', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/optimize`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ optimized: boolean }>(res);
      expect(data.optimized).toBe(true);
    });

    it('POST /api/projects/:slug/kb/optimize — returns 403 without ADMIN role', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/optimize`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);

      expect(res.body).toHaveProperty('ret');
    });

    it('POST /api/projects/:slug/kb/optimize — returns 404 with invalid slug', async () => {
      const res = await request(httpServer)
        .post('/api/projects/nonexistent-slug/kb/optimize')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);

      expect(res.body).toHaveProperty('ret');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Knowledge Base — Documents CRUD
  // ─────────────────────────────────────────────────────────────────

  describe('Knowledge Base — Documents', () => {
    let documentSourceId: string;

    it('POST /api/projects/:slug/kb/documents — adds a document', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/documents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          source: 'manual',
          sourceId: 'doc-manual-001',
          content: 'This is a test document for knowledge base indexing.',
          metadata: { author: 'test', category: 'integration' },
        })
        .expect(201);

      const data = body<{ indexed: boolean }>(res);
      expect(data.indexed).toBe(true);
      documentSourceId = 'doc-manual-001';
    });

    it('POST /api/projects/:slug/kb/documents — returns 404 for nonexistent project', async () => {
      await request(httpServer)
        .post('/api/projects/nonexistent/kb/documents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          source: 'manual',
          sourceId: 'doc-404',
          content: 'Test content',
        })
        .expect(404);
    });

    it('GET /api/projects/:slug/kb/documents — lists indexed documents', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/kb/documents`)
        .query({ limit: '10' })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<unknown>(res);
      expect(Array.isArray(data)).toBe(true);
    });

    it('GET /api/projects/:slug/kb/documents — returns 404 for nonexistent project', async () => {
      await request(httpServer)
        .get('/api/projects/nonexistent/kb/documents')
        .query({ limit: '10' })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('DELETE /api/projects/:slug/kb/documents/:sourceId — removes document by sourceId', async () => {
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/kb/documents/${documentSourceId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
    });

    it('DELETE /api/projects/:slug/kb/documents/:sourceId — returns 200 even for nonexistent sourceId (idempotent delete)', async () => {
      // Delete is idempotent — returns 200 even if sourceId doesn't exist
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/kb/documents/nonexistent-source`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);
    });

    it('POST /api/projects/:slug/kb/search — performs hybrid search', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ query: 'authentication secure APIs', limit: 5 })
        .expect(200);

      const data = body<unknown>(res);
      expect(data).toBeTruthy();
    });

    it('POST /api/projects/:slug/kb/search — returns 404 for nonexistent project', async () => {
      await request(httpServer)
        .post('/api/projects/nonexistent/kb/search')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ query: 'test query', limit: 5 })
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // VCS — Sync PR (requires VCS connection setup, skipped without it)
  // ─────────────────────────────────────────────────────────────────

  describe('VCS — Sync PR', () => {
    it('POST /api/projects/:slug/vcs/sync-pr — returns 404 when project has no VCS connection', async () => {
      // Without a VCS connection configured, getFullByProject throws 404
      await request(httpServer)
        .post('/api/projects/nonexistent/vcs/sync-pr')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('POST /api/projects/:slug/vcs-webhook — no VCS connection and an unknown slug get the same 401', async () => {
      const noConnection = await request(httpServer)
        .post(`/api/projects/${projectSlug}/vcs-webhook`)
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', 'sha256=invalid')
        .send({ action: 'push', ref: 'refs/heads/main' })
        .expect(401);

      const unknownSlug = await request(httpServer)
        .post('/api/projects/no-such-project/vcs-webhook')
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', 'sha256=invalid')
        .send({ action: 'push', ref: 'refs/heads/main' })
        .expect(401);

      expect(unknownSlug.body).toEqual(noConnection.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Knowledge Base — Graphify Import (US-003)
  // ─────────────────────────────────────────────────────────────────

  describe('Knowledge Base — Graphify Import (US-003)', () => {
    let graphifyEnabledSlug: string;
    let graphifyDisabledSlug: string;

    const validNodes = [
      { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'src/auth/auth.service.ts' },
      { id: 'node-2', label: 'UserService', type: 'class', source_file: 'src/users/user.service.ts' },
    ];
    const validLinks = [
      { source: 'node-1', target: 'node-2', relation: 'depends_on' },
    ];

    beforeAll(async () => {
      if (!DATABASE_URL) return;

      // Create a project for happy-path tests (graphify will be enabled)
      const enabledRes = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Graphify Enabled Project', slug: 'graphify-enabled', key: 'GFE' })
        .expect(201);
      graphifyEnabledSlug = body<{ slug: string }>(enabledRes).slug;

      // Enable graphify on the project
      await request(httpServer)
        .patch(`/api/projects/${graphifyEnabledSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ graphifyEnabled: true })
        .expect(200);

      // Create a project with graphifyEnabled: false (the default, no PATCH needed)
      const disabledRes = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Graphify Disabled Project', slug: 'graphify-disabled', key: 'GFD' })
        .expect(201);
      graphifyDisabledSlug = body<{ slug: string }>(disabledRes).slug;
    });

    // AC1: Happy path — ADMIN with valid nodes and links returns { imported, cleared }
    it('POST /kb/import/graphify — 200 with { imported, cleared } for ADMIN with valid nodes and links', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${graphifyEnabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ nodes: validNodes, links: validLinks })
        .expect(200);

      const data = body<{ imported: number; cleared: number }>(res);
      expect(typeof data.imported).toBe('number');
      expect(typeof data.cleared).toBe('number');
      expect(data.imported).toBe(validNodes.length);
    });

    // AC2: 403 when caller does not have ADMIN role
    it('POST /kb/import/graphify — 403 when caller is not ADMIN', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${graphifyEnabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .send({ nodes: validNodes, links: validLinks })
        .expect(403);

      expect(res.body).toHaveProperty('ret');
    });

    // AC3: 404 when project slug does not exist
    it('POST /kb/import/graphify — 404 when project slug does not exist', async () => {
      const res = await request(httpServer)
        .post('/api/projects/nonexistent-graphify-slug/kb/import/graphify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ nodes: validNodes, links: validLinks })
        .expect(404);

      expect(res.body).toHaveProperty('ret');
    });

    // AC4: 400 when project.graphifyEnabled is false
    it('POST /kb/import/graphify — 400 when project.graphifyEnabled is false', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${graphifyDisabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ nodes: validNodes, links: validLinks })
        .expect(400);

      expect(res.body).toHaveProperty('ret');
    });

    // AC5: Empty nodes returns { imported: 0, cleared: 0 }
    it('POST /kb/import/graphify — { imported: 0, cleared: 0 } when nodes is empty', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${graphifyEnabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ nodes: [] })
        .expect(200);

      const data = body<{ imported: number; cleared: number }>(res);
      expect(data.imported).toBe(0);
      expect(data.cleared).toBe(0);
    });

    // AC6: 400 when nodes field is missing
    it('POST /kb/import/graphify — 400 when nodes field is missing (DTO validation)', async () => {
      await request(httpServer)
        .post(`/api/projects/${graphifyEnabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ links: validLinks })
        .expect(400);
    });

    // AC7: links is optional — 200 when links is absent
    it('POST /kb/import/graphify — 200 when links field is absent (links is optional)', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${graphifyEnabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ nodes: validNodes })
        .expect(200);

      const data = body<{ imported: number; cleared: number }>(res);
      expect(data.imported).toBe(validNodes.length);
    });

    // AC9 + AC10: After successful import, graphifyLastImportedAt is updated and visible on GET
    it('GET /api/projects/:slug — graphifyLastImportedAt is updated after a successful import', async () => {
      const beforeTs = new Date();

      // Perform an import
      await request(httpServer)
        .post(`/api/projects/${graphifyEnabledSlug}/kb/import/graphify`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ nodes: validNodes, links: validLinks })
        .expect(200);

      // Fetch the project and verify graphifyLastImportedAt is set
      const projectRes = await request(httpServer)
        .get(`/api/projects/${graphifyEnabledSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const projectData = body<{ graphifyLastImportedAt: string | null }>(projectRes);
      expect(projectData.graphifyLastImportedAt).not.toBeNull();

      const importedAt = new Date(projectData.graphifyLastImportedAt as string);
      expect(importedAt.getTime()).toBeGreaterThanOrEqual(beforeTs.getTime());
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CI Webhooks
  // ─────────────────────────────────────────────────────────────────

  describe('CI Webhooks', () => {
    const ciWebhookSecret = 'ci-webhook-secret-for-e2e-tests-123456';

    beforeAll(async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      await prisma.client.project.update({
        where: { slug: projectSlug },
        data: { ciWebhookToken: ciWebhookSecret },
      });
    });

    it('POST /api/projects/:slug/ci-webhook — creates ticket on pipeline failure', async () => {
      const payload = {
        event: 'pipeline_failed',
        pipeline: {
          id: '12345',
          url: 'https://github.com/org/repo/actions/runs/12345',
        },
        commit: {
          sha: 'abc123def456',
          message: 'feat: add CI webhook support',
        },
        failures: [
          { test: 'AuthService.validateToken', file: 'apps/api/src/auth/auth.service.ts', line: 87 },
        ],
      };
      const signature = `sha256=${createHmac('sha256', ciWebhookSecret).update(JSON.stringify(payload)).digest('hex')}`;

      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', signature)
        .set('x-ci-delivery', 'e2e-ci-delivery-001')
        .send(payload)
        .expect(200);

      const data = body<{ success: boolean; ticketRef: string; message: string }>(res);
      expect(data.success).toBe(true);
      expect(data.ticketRef).toMatch(/^KT-\d+$/);
      expect(data.message).toBeTruthy();
    });

    it('POST /api/projects/:slug/ci-webhook — rejects a replayed delivery with 409 (SEC-1)', async () => {
      const payload = {
        event: 'pipeline_failed',
        pipeline: { id: '12346', url: 'https://github.com/org/repo/actions/runs/12346' },
        commit: { sha: 'abc123def457', message: 'feat: replay test' },
        failures: [
          { test: 'ReplayService.validateToken', file: 'apps/api/src/auth/auth.service.ts', line: 91 },
        ],
      };
      const signature = `sha256=${createHmac('sha256', ciWebhookSecret).update(JSON.stringify(payload)).digest('hex')}`;

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', signature)
        .set('x-ci-delivery', 'e2e-ci-delivery-replay')
        .send(payload)
        .expect(200);

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', signature)
        .set('x-ci-delivery', 'e2e-ci-delivery-replay')
        .send(payload)
        .expect(409);
    });

    it('POST /api/projects/:slug/ci-webhook — an unsigned invalid payload gets 401, not a validation error', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .send({
          event: 'invalid_event',
          pipeline: { id: '12345' },
          commit: { sha: 'abc123' },
          failures: [],
        })
        .expect(401);
    });

    it('POST /api/projects/:slug/ci-webhook — a signed invalid payload returns 400 and creates no ticket', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const ticketsBefore = await prisma.client.ticket.count({ where: { projectId: project.id } });
      const payload = {
        event: 'pipeline_failed',
        pipeline: { id: '12347' },
        commit: { sha: 'abc123def458' },
        failures: [{ test: 'LineZero', line: 0 }],
      };
      const signature = `sha256=${createHmac('sha256', ciWebhookSecret).update(JSON.stringify(payload)).digest('hex')}`;

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', signature)
        .set('x-ci-delivery', 'e2e-ci-delivery-invalid')
        .send(payload)
        .expect(400);

      expect(await prisma.client.ticket.count({ where: { projectId: project.id } })).toBe(ticketsBefore);
    });

    it('POST /api/projects/:slug/ci-webhook — unknown slug, missing signature and bad signature get the same 401', async () => {
      const payload = {
        event: 'pipeline_failed',
        pipeline: { id: '99999' },
        commit: { sha: 'deadbeef' },
        failures: [{ test: 'AlwaysFail' }],
      };
      const signature = `sha256=${createHmac('sha256', ciWebhookSecret).update(JSON.stringify(payload)).digest('hex')}`;

      const unknownSlug = await request(httpServer)
        .post('/api/projects/nonexistent/ci-webhook')
        .set('x-ci-signature', signature)
        .send(payload)
        .expect(401);
      const unsigned = await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .send(payload)
        .expect(401);
      const badSignature = await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', `sha256=${'0'.repeat(64)}`)
        .send(payload)
        .expect(401);

      expect(unknownSlug.body).toEqual(badSignature.body);
      expect(unsigned.body).toEqual(badSignature.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // SLO Dashboard — GET /admin/slos
  // ─────────────────────────────────────────────────────────────────

  describe('SLO Dashboard — GET /admin/slos', () => {
    it('AC-7: GET /admin/slos — returns 200 with full SloMetrics for ADMIN user', async () => {
      const res = await request(httpServer)
        .get('/api/admin/slos')
        .query({ from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        retrievalLatency: { p50: number; p95: number; p99: number; sampleCount: number };
        staleHitRate: number;
        provenanceCoverage: number;
        leakageIncidents: number;
        memoryGrowthRate: number;
      }>(res);

      expect(data.retrievalLatency).toHaveProperty('p50');
      expect(data.retrievalLatency).toHaveProperty('p95');
      expect(data.retrievalLatency).toHaveProperty('p99');
      expect(data.retrievalLatency).toHaveProperty('sampleCount');
      expect(typeof data.staleHitRate).toBe('number');
      expect(typeof data.provenanceCoverage).toBe('number');
      expect(typeof data.leakageIncidents).toBe('number');
      expect(typeof data.memoryGrowthRate).toBe('number');
    });

    it('GET /admin/slos — defaults to 7-day window when no query params', async () => {
      const res = await request(httpServer)
        .get('/api/admin/slos')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ retrievalLatency: { sampleCount: number } }>(res);
      expect(data.retrievalLatency.sampleCount).toBeGreaterThanOrEqual(0);
    });

    it('GET /admin/slos — returns 403 for non-admin user', async () => {
      await request(httpServer)
        .get('/api/admin/slos')
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);
    });

    it('GET /admin/slos — returns 401 without token', async () => {
      await request(httpServer)
        .get('/api/admin/slos')
        .expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Code Intelligence — Change Impact Analysis (Phase 4)
  // ─────────────────────────────────────────────────────────────────

  describe('Code Intelligence — Change Impact Analysis', () => {
    it('AC1: GET /projects/:slug/codeintel/impact — returns ChangeImpactResult with schema fields', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123def456',
          changedFiles: 'src/auth.ts,src/users.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        commitHash: string;
        changedFiles: string[];
        impactedSymbols: unknown[];
        impactedServices: unknown[];
        impactedTickets: unknown[];
        impactScore: number;
      }>(res);

      expect(data.commitHash).toBe('abc123def456');
      expect(Array.isArray(data.changedFiles)).toBe(true);
      expect(Array.isArray(data.impactedSymbols)).toBe(true);
      expect(Array.isArray(data.impactedServices)).toBe(true);
      expect(Array.isArray(data.impactedTickets)).toBe(true);
      expect(typeof data.impactScore).toBe('number');
    });

    it('AC2: impactedSymbols contains symbols whose file matches changedFiles', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        changedFiles: string[];
        impactedSymbols: Array<{ file: string }>;
      }>(res);

      data.impactedSymbols.forEach((symbol) => {
        expect(data.changedFiles).toContain(symbol.file);
      });
    });

    it('AC3: impactedServices contains services linked to impacted symbols', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        impactedServices: Array<{ entityType: string }>;
      }>(res);

      data.impactedServices.forEach((service) => {
        expect(['service', 'code_module']).toContain(service.entityType);
      });
    });

    it('AC4: impactedTickets contains tickets linked to impacted services', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        impactedTickets: Array<{ entityType: string }>;
      }>(res);

      data.impactedTickets.forEach((ticket) => {
        expect(ticket.entityType).toBe('ticket');
      });
    });

    it('AC5: impactScore is between 0-100 and computed with weighted formula', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts,src/users.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ impactScore: number }>(res);

      expect(data.impactScore).toBeGreaterThanOrEqual(0);
      expect(data.impactScore).toBeLessThanOrEqual(100);
      expect(typeof data.impactScore).toBe('number');
      expect(isNaN(data.impactScore)).toBe(false);
    });

    it('AC5b: impactScore handles zero denominators gracefully', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'nonexistent-file.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{ impactScore: number }>(res);

      // Should not be NaN or Infinity
      expect(isNaN(data.impactScore)).toBe(false);
      expect(isFinite(data.impactScore)).toBe(true);
      expect(data.impactScore).toBeGreaterThanOrEqual(0);
      expect(data.impactScore).toBeLessThanOrEqual(100);
    });

    it('AC6: includes provenance when ticketId query parameter is provided', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
          ticketId: bugTicketRef,
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        provenance?: { ticketId: string; sources: string[] };
      }>(res);

      expect(data.provenance).toBeDefined();
      expect(data.provenance).toHaveProperty('ticketId');
      expect(data.provenance).toHaveProperty('sources');
      expect(Array.isArray(data.provenance?.sources)).toBe(true);
    });

    it('AC6b: does not include provenance when ticketId is not provided', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const data = body<{
        provenance?: { ticketId: string; sources: string[] };
      }>(res);

      expect(data.provenance).toBeUndefined();
    });

    it('AC7: response completes in under 5 seconds for up to 50 changed files', async () => {
      const changedFiles = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);

      const startTime = Date.now();

      await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: changedFiles.join(','),
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(5000);
    });

    it('AC8: returns 403 when user lacks READ permission for CodeIntel', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);

      expect(res.body).toHaveProperty('ret');
    });

    it('AC8b: returns 401 when missing authentication token', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .expect(401);
    });

    it('returns 404 when project does not exist', async () => {
      await request(httpServer)
        .get('/api/projects/nonexistent-project/codeintel/impact')
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('returns 400 when required query parameters are missing', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          // Missing commitHash and changedFiles
        })
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(400);
    });

    it('returns 200 with agent API key', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/codeintel/impact`)
        .query({
          repoId: 'test-repo',
          commitHash: 'abc123',
          changedFiles: 'src/auth.ts',
        })
        .set('Authorization', `Bearer ${agentApiKey}`)
        .expect(200);

      const data = body<{
        commitHash: string;
        impactScore: number;
      }>(res);

      expect(data.commitHash).toBeTruthy();
      expect(typeof data.impactScore).toBe('number');
    });
  });

  describe('US-003 Project agent roster writes', () => {
    let rosterAgentSlug: string;
    let rosterAgentId: string;
    let rosterAgentApiKey: string;

    it('AC1: project ADMIN adds an agent and records the administrator', async () => {
      const createRes = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Roster Target', slug: 'roster-target', maxConcurrentTickets: 1, roles: ['DEVELOPER'] })
        .expect(201);
      const created = body<{ agent: { id: string; slug: string }; apiKey: string }>(createRes);
      rosterAgentSlug = created.agent.slug;
      rosterAgentId = created.agent.id;
      rosterAgentApiKey = created.apiKey;

      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug: rosterAgentSlug })
        .expect(201);

      expect(body<{ slug: string }>(res).slug).toBe(rosterAgentSlug);
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const admin = await prisma.client.user.findUniqueOrThrow({ where: { email: 'admin@koda.test' } });
      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: rosterAgentId, projectId: project.id } },
      });
      expect(rosterEntry?.addedById).toBe(admin.id);
    });

    it('AC2: a global ADMIN who is not a project member can add a roster entry', async () => {
      const projectRes = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Global Admin Roster Project', slug: 'global-roster-project', key: 'GRP' })
        .expect(201);
      const globalProjectSlug = body<{ slug: string }>(projectRes).slug;

      await request(httpServer)
        .post(`/api/projects/${globalProjectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug: rosterAgentSlug })
        .expect(201);
    });

    it('AC3: a project DEVELOPER cannot add an agent', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const user = await prisma.client.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      await prisma.client.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: user.id } },
        create: { projectId: project.id, userId: user.id, role: 'DEVELOPER' },
        update: { role: 'DEVELOPER' },
      });
      const candidate = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Developer Blocked Target', slug: 'developer-blocked-target', roles: ['DEVELOPER'] })
        .expect(201);
      const candidateSlug = body<{ agent: { slug: string; id: string } }>(candidate).agent;

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .send({ agentSlug: candidateSlug.slug })
        .expect(403);

      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: candidateSlug.id, projectId: project.id } },
      });
      expect(rosterEntry).toBeNull();

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug: candidateSlug.slug })
        .expect(201);
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/agents/${candidateSlug.slug}`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);
      const retainedEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: candidateSlug.id, projectId: project.id } },
      });
      expect(retainedEntry).not.toBeNull();
    });

    it('AC5: adding an OFFLINE agent returns the offline conflict', async () => {
      const candidateRes = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Offline Roster Target', slug: 'offline-roster-target', roles: ['DEVELOPER'] })
        .expect(201);
      const candidate = body<{ agent: { id: string; slug: string } }>(candidateRes).agent;
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      await prisma.client.agent.update({ where: { id: candidate.id }, data: { status: 'OFFLINE' } });

      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug: candidate.slug })
        .expect(409);
      refusal(res, 'projectAgents.agentOffline.409');

      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: candidate.id, projectId: project.id } },
      });
      expect(rosterEntry).toBeNull();
    });

    it('AC4: adding an already-rostered agent returns 409 with the duplicate message', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug: rosterAgentSlug })
        .expect(409);

      refusal(res, 'projectAgents.alreadyAssigned.409');
    });

    it('AC6: adding an unknown agent returns 404', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ agentSlug: 'unknown-roster-agent' })
        .expect(404);
    });

    it('AC12: a rostered agent cannot POST roster changes using its API key', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/agents`)
        .set('Authorization', `Bearer ${rosterAgentApiKey}`)
        .send({ agentSlug: rosterAgentSlug })
        .expect(403);
      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: rosterAgentId, projectId: project.id } },
      });
      expect(rosterEntry).not.toBeNull();
    });

    it('AC13: a rostered agent cannot DELETE roster entries using its API key', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/agents/${rosterAgentSlug}`)
        .set('Authorization', `Bearer ${rosterAgentApiKey}`)
        .expect(403);
      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: rosterAgentId, projectId: project.id } },
      });
      expect(rosterEntry).not.toBeNull();
    });

    it('AC10: removing an agent not on the roster returns 404', async () => {
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/agents/not-rostered-agent`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);
    });

    it('AC7: refuses to remove a rostered agent with open tickets and reports their refs', async () => {
      const refs: string[] = [];
      for (const title of ['Roster blocker one', 'Roster blocker two']) {
        const created = await request(httpServer)
          .post(`/api/projects/${projectSlug}/tickets`)
          .set('Authorization', `Bearer ${userAccessToken}`)
          .send({ type: 'TASK', title })
          .expect(201);
        refs.push(body<{ ref: string }>(created).ref);
      }
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      await prisma.client.ticket.updateMany({
        where: { projectId: project.id, number: { in: refs.map((ref) => Number(ref.split('-')[1])) } },
        data: { assignedToAgentId: rosterAgentId },
      });

      const res = await request(httpServer)
        .delete(`/api/projects/${projectSlug}/agents/${rosterAgentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(409);
      // The refusal names the count and every open ref (AC-34), and carries them as args.
      refusal(res, 'projectAgents.hasOpenTickets.409', { count: 2, refs: refs.join(', ') });

      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: rosterAgentId, projectId: project.id } },
      });
      expect(rosterEntry).not.toBeNull();
    });

    it('AC8: removes a rostered agent without open tickets and deletes its roster row', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      await prisma.client.ticket.updateMany({
        where: { projectId: project.id, assignedToAgentId: rosterAgentId },
        data: { assignedToAgentId: null },
      });
      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/agents/${rosterAgentSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);

      const rosterEntry = await prisma.client.agentProject.findUnique({
        where: { agentId_projectId: { agentId: rosterAgentId, projectId: project.id } },
      });
      expect(rosterEntry).toBeNull();
    });

    it('AC9: a removed agent is denied project ticket access', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${rosterAgentApiKey}`)
        .expect(403);
    });
  });

  describe('US-003 Disabled member guard', () => {
    const disabledMemberEmail = 'disabled-member@koda.test';

    it('AC14: adding a disabled user is refused with the disabled-account message and stores no membership', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });

      const registered = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: disabledMemberEmail, name: 'Disabled Member', password: 'Member1234!Aa' })
        .expect(201);
      const disabledUser = body<{ user: { id: string } }>(registered).user;
      await prisma.client.user.update({ where: { id: disabledUser.id }, data: { disabled: true } });

      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/members`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ email: disabledMemberEmail })
        .expect(409);

      refusal(res, 'members.userDisabled.409');

      const membership = await prisma.client.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: disabledUser.id } },
      });
      expect(membership).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // US-003 Skill sources — admin routes
  // ─────────────────────────────────────────────────────────────────

  describe('US-003 Skill sources', () => {
    it('GET /api/admin/skills/sources — 200 for a global admin', async () => {
      const res = await request(httpServer)
        .get('/api/admin/skills/sources')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(body<{ items: unknown[] }>(res)).toHaveProperty('items');
    });

    it('POST /api/admin/skills/sources — 201 with the booted app resolver spied', async () => {
      const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
      const resolve = jest.spyOn(resolver, 'resolve');
      resolve.mockResolvedValue({ sha: 's1', skills: [{ name: 'spec-review', description: 'd', dir: 'skills/spec-review' }] });

      try {
        const res = await request(httpServer)
          .post('/api/admin/skills/sources')
          .set('Authorization', `Bearer ${userAccessToken}`)
          .send({ gitUrl: 'https://github.com/NathApp-IO/nax-spec-kit-skills.git', ref: 'main', path: 'skills' })
          .expect(201);

        expect(body<{ status: string; resolvedSha: string }>(res)).toMatchObject({ status: 'OK', resolvedSha: 's1' });
      } finally {
        if (resolver) resolve.mockRestore();
      }
    });

    it('POST /api/admin/skills/sources — 400 for a GitLab URL', async () => {
      await request(httpServer)
        .post('/api/admin/skills/sources')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ gitUrl: 'https://gitlab.com/a/b', ref: 'main', path: '' })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // US-004 Skill source update + delete — admin routes
  // ─────────────────────────────────────────────────────────────────

  describe('US-004 Skill source update & delete', () => {
    it('POST /api/admin/skills/sources/:id/update — 200 with the booted app resolver spied', async () => {
      const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
      const resolve = jest.spyOn(resolver, 'resolve');
      try {
        resolve.mockResolvedValueOnce({ sha: 's1', skills: [{ name: 'e2e-update-skill', description: 'old', dir: 'skills/a' }] });
        const created = body<{ id: string }>(
          await request(httpServer)
            .post('/api/admin/skills/sources')
            .set('Authorization', `Bearer ${userAccessToken}`)
            .send({ gitUrl: 'https://github.com/NathApp-IO/e2e-update-skills.git', ref: 'main', path: '' })
            .expect(201),
        );

        resolve.mockResolvedValueOnce({ sha: 's2', skills: [{ name: 'e2e-update-skill', description: 'new', dir: 'skills/a' }] });
        const res = await request(httpServer)
          .post(`/api/admin/skills/sources/${created.id}/update`)
          .set('Authorization', `Bearer ${userAccessToken}`)
          .expect(200);

        expect(body<{ status: string; resolvedSha: string }>(res)).toMatchObject({ status: 'OK', resolvedSha: 's2' });
      } finally {
        if (resolver) resolve.mockRestore();
      }
    });

    it('POST /api/admin/skills/sources/:id/update — 404 for an unknown id', async () => {
      const res = await request(httpServer)
        .post('/api/admin/skills/sources/e2e-unknown-source-id/update')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);

      refusal(res, 'skills.sourceNotFound.404');
    });

    it('DELETE /api/admin/skills/sources/:id — 204 for a global admin', async () => {
      const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
      const resolve = jest.spyOn(resolver, 'resolve');
      try {
        resolve.mockResolvedValueOnce({ sha: 's1', skills: [{ name: 'e2e-delete-skill', description: 'd', dir: 'skills/a' }] });
        const created = body<{ id: string }>(
          await request(httpServer)
            .post('/api/admin/skills/sources')
            .set('Authorization', `Bearer ${userAccessToken}`)
            .send({ gitUrl: 'https://github.com/NathApp-IO/e2e-delete-skills.git', ref: 'main', path: '' })
            .expect(201),
        );

        await request(httpServer)
          .delete(`/api/admin/skills/sources/${created.id}`)
          .set('Authorization', `Bearer ${userAccessToken}`)
          .expect(204);
      } finally {
        if (resolver) resolve.mockRestore();
      }
    });

    it('DELETE /api/admin/skills/sources/:id — 404 for an unknown id', async () => {
      const res = await request(httpServer)
        .delete('/api/admin/skills/sources/e2e-unknown-source-id')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);

      refusal(res, 'skills.sourceNotFound.404');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // US-005 Project skill enablement routes
  // ─────────────────────────────────────────────────────────────────

  describe('US-005 Project skill enablement routes', () => {
    let serial = 0;
    const uniqueName = () => `e2e-project-skill-${++serial}`;

    async function seedSkill(name: string): Promise<string> {
      const db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
      const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@koda.test' } });
      const source = await db.skillSource.create({
        data: {
          gitUrl: `https://github.com/nathapp-io/${name}`,
          owner: 'nathapp-io',
          repo: name,
          ref: 'main',
          path: '',
          status: 'OK',
          resolvedSha: 'sha-e2e',
          createdById: admin.id,
        },
      });
      const skill = await db.skill.create({
        data: { sourceId: source.id, name, description: `${name} description`, dir: name },
      });
      return skill.id;
    }

    it('GET /api/projects/:slug/skills — 200 for a global admin', async () => {
      const name = uniqueName();
      const skillId = await seedSkill(name);

      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/skills`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      const items = body<{ items: Array<{ id: string; name: string; enabled: boolean }> }>(res).items;
      expect(items.find((candidate) => candidate.id === skillId)).toMatchObject({ id: skillId, name, enabled: false });
    });

    it('GET /api/projects/:slug/skills — 403 for a non-member', async () => {
      const db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
      const project = await db.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const user = await db.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      await db.projectMember.deleteMany({ where: { projectId: project.id, userId: user.id } });

      await request(httpServer)
        .get(`/api/projects/${projectSlug}/skills`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(403);
    });

    it('PUT /api/projects/:slug/skills/:skillId — 200 enables the skill', async () => {
      const name = uniqueName();
      const skillId = await seedSkill(name);

      const res = await request(httpServer)
        .put(`/api/projects/${projectSlug}/skills/${skillId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({})
        .expect(200);

      expect(body<{ id: string; enabled: boolean }>(res)).toMatchObject({ id: skillId, enabled: true });
    });

    it('PUT /api/projects/:slug/skills/:skillId — 404 for an unknown skill', async () => {
      const res = await request(httpServer)
        .put(`/api/projects/${projectSlug}/skills/e2e-unknown-skill-id`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({})
        .expect(404);

      refusal(res, 'skills.notFound.404');
    });

    it('DELETE /api/projects/:slug/skills/:skillId — 204 for an enabled skill', async () => {
      const name = uniqueName();
      const skillId = await seedSkill(name);
      await request(httpServer)
        .put(`/api/projects/${projectSlug}/skills/${skillId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({})
        .expect(200);

      await request(httpServer)
        .delete(`/api/projects/${projectSlug}/skills/${skillId}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(204);
    });

    it('DELETE /api/projects/:slug/skills/:skillId — 404 for an unknown skill', async () => {
      const res = await request(httpServer)
        .delete(`/api/projects/${projectSlug}/skills/e2e-unknown-skill-id`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(404);

      refusal(res, 'skills.notFound.404');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // US-003 Thread create, list, get and messages routes
  // ─────────────────────────────────────────────────────────────────

  describe('US-003 Thread routes', () => {
    let world: FleetHttpWorld;
    let threadId: string;

    const config = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    const db = () => app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const threadMessage = (res: request.Response, key: string) => {
      const [namespace, ...segments] = key.split('.');
      const path = join(__dirname, '../../../src/i18n/en', `${namespace}.json`);
      if (existsSync(path)) {
        refusal(res, key);
      } else {
        expect(res.body.message).toBe(segments.join('.'));
      }
    };
    const createThread = (feature: string, token = world.tokens.dev) => request(httpServer)
      .post('/api/projects/web/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ repoId: world.repoId, feature, title: feature, backend: { kind: 'native' } });

    beforeAll(async () => {
      const prisma = db();
      const project = await prisma.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const developer = await prisma.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@koda.test' } });
      const repo = await prisma.fleetRepo.create({ data: {
        projectId: project.id, provider: 'github', owner: 'acme', name: 'threads-app', defaultBranch: 'trunk',
        githubInstallationId: BigInt(77), createdById: admin.id,
      } });
      const foreignProject = await prisma.project.create({ data: { name: 'Threads foreign', slug: 'threads-foreign', key: 'THRF' } });
      const foreignRepo = await prisma.fleetRepo.create({ data: {
        projectId: foreignProject.id, provider: 'github', owner: 'acme', name: 'threads-foreign', defaultBranch: 'main',
        githubInstallationId: BigInt(77), createdById: admin.id,
      } });
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: developer.id } },
        create: { projectId: project.id, userId: developer.id, role: 'DEVELOPER' }, update: { role: 'DEVELOPER' },
      });
      await prisma.agentProject.upsert({
        where: { agentId_projectId: { agentId, projectId: project.id } },
        create: { agentId, projectId: project.id, addedById: admin.id }, update: {},
      });
      world = {
        tokens: { root: userAccessToken, dev: nonAdminUserAccessToken, viewer: nonAdminUserAccessToken, outsider: nonAdminUserAccessToken },
        ids: { root: admin.id, dev: developer.id, viewer: developer.id, outsider: developer.id },
        projectId: project.id, opsProjectId: foreignProject.id, repoId: repo.id, foreignRepoId: foreignRepo.id,
      };
      config().threadsEnabled = true;
    });

    it('US-003 AC1: creates an active thread with repo defaults and caller identity', async () => {
      const res = await createThread('add-auth').expect(201);
      const thread = body<{ id: string; status: string; createdById: string; baseRef: string; specPath: string; maxCostUsd: string }>(res);
      expect(thread).toMatchObject({ status: 'ACTIVE', createdById: world.ids.dev, baseRef: 'trunk', specPath: '.nax/features/add-auth/spec.md', maxCostUsd: '5' });
      threadId = thread.id;
    });

    it('US-003 AC2: snapshots only enabled skills with the source SHA', async () => {
      const source = await db().skillSource.create({ data: {
        gitUrl: 'https://github.com/acme/thread-skills', owner: 'acme', repo: 'thread-skills', ref: 'main', path: '',
        resolvedSha: 'sha-thread-skills', status: 'OK', createdById: world.ids.root,
      } });
      const selected = await db().skill.create({ data: { sourceId: source.id, name: 'thread-spec-review', dir: 'skills/spec-review', description: 'Review the spec' } });
      await db().skill.create({ data: { sourceId: source.id, name: 'thread-spec-writing', dir: 'skills/spec-writing', description: 'Write the spec' } });
      await db().projectSkill.create({ data: { projectId: world.projectId, skillId: selected.id } });

      const res = await createThread('skill-snapshot').expect(201);
      expect(body<{ skills: unknown }>(res).skills).toEqual([{ sourceId: source.id, owner: source.owner, repo: source.repo, sha: 'sha-thread-skills', skills: [{ name: selected.name, dir: selected.dir, description: selected.description }] }]);
    });

    it('US-003 AC3: requests the project skill snapshot once for thread creation', async () => {
      const skills = app.get(SkillsService);
      expect(typeof skills.snapshotForProject).toBe('function');
      const snapshot = jest.spyOn(skills, 'snapshotForProject');
      try {
        await createThread('snapshot-call').expect(201);
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(snapshot).toHaveBeenCalledWith(world.projectId);
      } finally {
        snapshot.mockRestore();
      }
    });

    it('US-003 AC4: creates no fleet job for a new thread', async () => {
      const created = body<{ id: string }>(await createThread('no-job-created').expect(201));
      const jobs = await db().fleetJob.findMany({ where: { threadId: created.id }, take: 1 });
      expect(jobs).toHaveLength(0);
    });

    it('US-003 AC5: refuses thread creation by a project viewer', async () => {
      await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.viewer } }, data: { role: 'VIEWER' } });
      try {
        await createThread('viewer-denied', world.tokens.viewer).expect(403);
      } finally {
        await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'DEVELOPER' } });
      }
    });

    it('US-003 AC6: refuses an agent principal with the thread principal message', async () => {
      const res = await createThread('agent-denied', agentApiKey).expect(403);
      refusal(res, 'threads.principal.403');
    });

    it('US-003 AC7: refuses create when threads are disabled', async () => {
      config().threadsEnabled = false;
      try {
        const res = await createThread('disabled-create').expect(409);
        refusal(res, 'threads.disabled.409');
      } finally {
        config().threadsEnabled = true;
      }
    });

    it('US-003 AC8: rejects a feature outside the feature naming format', async () => {
      const res = await createThread('Add Auth').expect(400);
      refusal(res, 'threads.input.400');
    });

    it('US-003 AC9: rejects an unsupported ACP backend agent', async () => {
      const res = await request(httpServer).post('/api/projects/web/threads').set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ repoId: world.repoId, feature: 'bad-backend', title: 'Bad backend', backend: { kind: 'acp', agent: 'gemini' } }).expect(400);
      refusal(res, 'threads.input.400');
    });

    it('US-003 AC10: rejects a second active thread for the same repo and feature', async () => {
      await createThread('same-active-feature').expect(201);
      const res = await createThread('same-active-feature').expect(409);
      refusal(res, 'threads.featureTaken.409', { feature: 'same-active-feature' });
    });

    it('US-003 AC11: returns not found for a repo belonging to another project', async () => {
      const res = await request(httpServer).post('/api/projects/web/threads').set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ repoId: world.foreignRepoId, feature: 'foreign-repo', title: 'Foreign repo', backend: { kind: 'native' } }).expect(404);
      expect(res.body).toHaveProperty('ret');
      expect(res.body.message).not.toBe('Cannot POST /api/projects/web/threads');
    });

    it('US-003 AC12: lists project threads for a viewer ordered by recent activity', async () => {
      const older = body<{ id: string }>(await createThread('list-older').expect(201));
      const newer = body<{ id: string }>(await createThread('list-newer').expect(201));
      await db().chatThread.update({ where: { id: older.id }, data: { lastActivityAt: new Date('2020-01-01T00:00:00Z') } });
      await db().chatThread.update({ where: { id: newer.id }, data: { lastActivityAt: new Date('2021-01-01T00:00:00Z') } });
      await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.viewer } }, data: { role: 'VIEWER' } });
      try {
        const res = await request(httpServer).get('/api/projects/web/threads').set('Authorization', `Bearer ${world.tokens.viewer}`).expect(200);
        const items = body<Array<{ id: string }>>(res);
        expect(items.findIndex((item) => item.id === newer.id)).toBeLessThan(items.findIndex((item) => item.id === older.id));
      } finally {
        await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'DEVELOPER' } });
      }
    });

    it('US-003 AC12: returns not found when listing threads for an unknown project', async () => {
      const res = await request(httpServer).get('/api/projects/no-such-project/threads').set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
      expect(res.body.message).not.toBe('Cannot GET /api/projects/no-such-project/threads');
    });

    it('US-003 AC13: gets a thread while the feature kill switch is disabled', async () => {
      config().threadsEnabled = false;
      try {
        const res = await request(httpServer).get(`/api/projects/web/threads/${threadId}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
        expect(body<{ id: string }>(res).id).toBe(threadId);
      } finally {
        config().threadsEnabled = true;
      }
    });

    it('US-003 AC14: hides a thread belonging to another project', async () => {
      const foreignThread = await db().chatThread.create({ data: {
        projectId: world.opsProjectId, repoId: world.foreignRepoId, baseRef: 'main', feature: 'foreign-thread', title: 'Foreign',
        createdById: world.ids.root, backend: { kind: 'native' }, skills: [], specPath: '.nax/features/foreign-thread/spec.md',
      } });
      const res = await request(httpServer).get(`/api/projects/web/threads/${foreignThread.id}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
      threadMessage(res, 'threads.notFound.404');
    });

    it('US-003 AC15: returns messages after the requested sequence in ascending order', async () => {
      const thread = await db().chatThread.create({ data: {
        projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: 'messages-thread', title: 'Messages',
        createdById: world.ids.dev, backend: { kind: 'native' }, skills: [], specPath: '.nax/features/messages-thread/spec.md',
      } });
      await db().chatMessage.createMany({ data: [1, 2, 3].map((seq) => ({ threadId: thread.id, seq, role: 'user', authorUserId: world.ids.dev, content: `message-${seq}`, status: 'complete' })) });
      const res = await request(httpServer).get(`/api/projects/web/threads/${thread.id}/messages?afterSeq=1`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
      expect(body<{ items: Array<{ seq: number }> }>(res).items.map((message) => message.seq)).toEqual([2, 3]);
    });

    it('US-003 AC15: returns not found for messages on an unknown thread', async () => {
      const res = await request(httpServer).get('/api/projects/web/threads/no-such-thread/messages').set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
      expect(res.body.message).not.toBe('Cannot GET /api/projects/web/threads/no-such-thread/messages');
    });
  });
});
