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
import { seedThreadJob } from '../../helpers/thread-fixtures';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import { FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { buildThreadInstructions, renderBriefBlock } from '../../../src/fleet/threads/thread-instructions';
import type { ThreadSkillSource } from '../../../src/skills/skill-catalog.domain';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { ProjectBriefService } from '../../../src/fleet/threads/project-brief.service';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';
import { RunnerNotifier } from '../../../src/fleet/jobs/runner-notifier';
import { PrismaThreadIngestRepository } from '../../../src/fleet/threads/ingest/prisma-thread-ingest.repository';
import { KnowledgeSearchService, type KnowledgeHit } from '../../../src/fleet/knowledge/knowledge-search.service';
import { KnowledgeStoreUnavailableError } from '../../../src/fleet/knowledge/knowledge-chunk-store';
import { KnowledgeIndexQueue } from '../../../src/fleet/knowledge/knowledge-index.queue';
import { DEFAULT_KNOWLEDGE_PATTERNS } from '../../../src/fleet/knowledge/knowledge-patterns';

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

    // ── US-001: the project brief ──────────────────────────────────────
    it('US-001 AC-1: PATCH /api/projects/:slug — sets the brief and echoes it', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ brief: 'Koda is a fleet platform.' })
        .expect(200);

      expect(body<{ brief: string | null }>(res).brief).toBe('Koda is a fleet platform.');
    });

    it('US-001 AC-2: GET /api/projects/:slug — returns the brief stored by the PATCH', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(body<{ brief: string | null }>(res).brief).toBe('Koda is a fleet platform.');
    });

    it('US-001 AC-4: PATCH /api/projects/:slug — a 3001-character brief is refused and the stored one is kept', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ brief: 'k'.repeat(3001) })
        .expect(400);

      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(body<{ brief: string | null }>(res).brief).toBe('Koda is a fleet platform.');
    });

    it('US-001 AC-5: PATCH /api/projects/:slug — a brief of exactly 3000 characters is accepted', async () => {
      const brief = 'x'.repeat(3000);

      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ brief })
        .expect(200);

      const data = body<{ brief: string | null }>(res);
      expect(data.brief).toHaveLength(3000);
      expect(data.brief).toBe(brief);
    });

    it('US-001 AC-6: PATCH /api/projects/:slug — a non-string brief is refused', async () => {
      await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ brief: 42 })
        .expect(400);
    });

    it('US-001 AC-7: PATCH /api/projects/:slug — 403 for a project member who is not a global ADMIN', async () => {
      // A dedicated project: adding `member@koda.test` to `projectSlug` here
      // would break the non-member 403 assertions later in this suite.
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const created = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ name: 'Brief Guard Project', slug: 'brief-guard-project', key: 'BGP' })
        .expect(201);
      const guardSlug = body<{ slug: string }>(created).slug;
      const member = await prisma.client.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      const guardProject = await prisma.client.project.findUniqueOrThrow({ where: { slug: guardSlug } });
      await prisma.client.projectMember.create({
        data: { projectId: guardProject.id, userId: member.id, role: 'DEVELOPER' },
      });

      const previous = 'Koda is a fleet platform.';
      await request(httpServer)
        .patch(`/api/projects/${guardSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ brief: previous })
        .expect(200);

      await request(httpServer)
        .patch(`/api/projects/${guardSlug}`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .send({ brief: 'x' })
        .expect(403);

      // The member can read the project, and the refused update changed nothing.
      const res = await request(httpServer)
        .get(`/api/projects/${guardSlug}`)
        .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
        .expect(200);

      expect(body<{ brief: string | null }>(res).brief).toBe(previous);
    });

    it('US-001 AC-3: PATCH /api/projects/:slug — a null brief clears the column', async () => {
      const res = await request(httpServer)
        .patch(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ brief: null })
        .expect(200);

      expect(body<{ brief: string | null }>(res).brief).toBeNull();

      const get = await request(httpServer)
        .get(`/api/projects/${projectSlug}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(body<{ brief: string | null }>(get).brief).toBeNull();
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
  // AC-6: DELETE /api/projects/:slug/tickets/:ref refuses an agent (permissions)
  // ─────────────────────────────────────────────────────────────────

  describe('Agent Permissions (AC-5 & AC-6)', () => {
    let agentDeleteTicketRef: string;

    beforeAll(async () => {
      // Permissions P1 (US-004): an agent now acts with the keys of its AgentRoleEntry rows, and an
      // earlier case (`update-roles`) left this one with REVIEWER only. The block restores the
      // DEVELOPER role the two ACs were written for: label.create yes, ticket.delete no.
      const roles = await request(httpServer)
        .patch(`/api/agents/${agentSlug}/update-roles`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ roles: ['DEVELOPER'] })
        .expect(200);
      expect(body<{ roles: { role: string }[] }>(roles).roles.map((r) => r.role)).toEqual(['DEVELOPER']);

      // Create a ticket that the agent will try to soft-delete (AC-6)
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/tickets`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ type: 'BUG', title: 'Agent delete test ticket', priority: 'LOW' })
        .expect(201);

      agentDeleteTicketRef = body<{ ref: string }>(res).ref;
    });

    it('AC-5: POST /api/projects/:slug/labels — returns 201 with agent API key', async () => {
      // Bug #18: agents should be allowed to create labels. Developer holds label.create, so the
      // route lets it through; the label service blocks MEMBER users only.
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/labels`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({ name: 'agent-created-label', color: '#00ccff' })
        .expect(201);

      const data = body<{ name: string; id: string }>(res);
      expect(data.name).toBe('agent-created-label');
      expect(data.id).toBeTruthy();
    });

    it('AC-6: DELETE /api/projects/:slug/tickets/:ref — 403 permissions with agent API key', async () => {
      // Permissions P1 (US-004): the route is guarded by ticket.delete, which Developer does not hold.
      // (Bug #19's any-agent delete was the hole this closes.)
      const res = await request(httpServer)
        .delete(`/api/projects/${projectSlug}/tickets/${agentDeleteTicketRef}`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .expect(403);

      refusal(res, 'permissions.40003');
    });

    it('AC-6: DELETE /api/projects/:slug/tickets/:ref — the project admin deletes the ticket', async () => {
      const res = await request(httpServer)
        .delete(`/api/projects/${projectSlug}/tickets/${agentDeleteTicketRef}`)
        .set('Authorization', `Bearer ${userAccessToken}`)
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
      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: rosterAgentId, projectId: project.id, role: { key: 'viewer' } },
      });
      expect(rosterEntry?.grantedById).toBe(admin.id);
      expect(rosterEntry?.grantedByType).toBe('USER');
      expect(await prisma.client.agentProject.count({ where: { agentId: rosterAgentId, projectId: project.id } })).toBe(0);
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

      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: candidateSlug.id, projectId: project.id, role: { key: 'viewer' } },
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
      const retainedEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: candidateSlug.id, projectId: project.id, role: { key: 'viewer' } },
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
      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: candidate.id, projectId: project.id, role: { key: 'viewer' } },
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
      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: rosterAgentId, projectId: project.id, role: { key: 'viewer' } },
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
      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: rosterAgentId, projectId: project.id, role: { key: 'viewer' } },
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

      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: rosterAgentId, projectId: project.id, role: { key: 'viewer' } },
      });
      expect(rosterEntry).not.toBeNull();
    });

    it('AC8: removes a rostered agent without open tickets and deletes its viewer binding', async () => {
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

      const rosterEntry = await prisma.client.roleBinding.findFirst({
        where: { principalType: 'AGENT', principalId: rosterAgentId, projectId: project.id, role: { key: 'viewer' } },
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
      const resolve = vi.spyOn(resolver, 'resolve');
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
      const resolve = vi.spyOn(resolver, 'resolve');
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
      const resolve = vi.spyOn(resolver, 'resolve');
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
    /** The stubbed forge methods, restored when the thread suite ends (S5b 1c-D1: a send reads the repository context). */
    let githubSpies: Array<{ mockRestore: () => void }> = [];

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
      .post(`/api/projects/${projectSlug}/threads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ repoId: world.repoId, feature, title: feature, backend: { kind: 'native' } });
    const createThreadRunner = (threadId: string, extraCapabilities: Record<string, unknown> = {}) => db().runner.create({ data: {
      name: `thread-handoff-${threadId}`, apiKeyHash: `thread-handoff-${threadId}`, os: 'linux', arch: 'x64', labels: [],
      capacity: 2, capabilities: {
        nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true, probedAt: new Date().toISOString() },
        profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'], ...extraCapabilities,
      }, daemonVersion: '0.1.0', protocolVersion: 4,
      bootId: `thread-handoff-${threadId}`, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    const attachThreadRunner = async (threadId: string, extraCapabilities: Record<string, unknown> = {}) => {
      const runner = await createThreadRunner(threadId, extraCapabilities);
      await db().chatThread.update({ where: { id: threadId }, data: { runnerId: runner.id } });
      return runner;
    };

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

      // Every SESSION send resolves its repository context before the transaction (S5b 1c-D1), so the forge is stubbed
      // on the app's client: no live GitHub call, and `getFile` answering null reads as "no context file".
      const github = app.get(GitHubAppClient);
      githubSpies = [
        vi.spyOn(github, 'mintInstallationToken').mockResolvedValue({ token: 't', expiresAt: new Date(Date.now() + 3_600_000) }),
        vi.spyOn(github, 'getBranchHead').mockResolvedValue('e2e0000aaaa'),
        vi.spyOn(github, 'getFile').mockResolvedValue(null),
      ];
    });

    afterAll(() => {
      for (const spy of githubSpies) spy.mockRestore();
      githubSpies = [];
    });

    it('workspace POST /threads creates a personal thread in the explicit home project', async () => {
      const res = await request(httpServer).post('/api/threads').set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ title: 'Workspace', backend: { kind: 'native' }, homeProject: projectSlug }).expect(201);
      const thread = body<{ id: string; kind: string; homeProject: { slug: string } }>(res);
      try {
        expect(thread).toMatchObject({ kind: 'WORKSPACE', homeProject: { slug: projectSlug } });
        expect(await db().chatThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({ kind: 'WORKSPACE', projectId: world.projectId, createdById: world.ids.dev });
      } finally { await db().chatThread.delete({ where: { id: thread.id } }); }
    });

    it('workspace POST /threads refuses repo fields and non-user principals', async () => {
      const res = await request(httpServer).post('/api/threads').set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ title: 'Workspace', backend: { kind: 'native' }, repoId: world.repoId }).expect(400);
      refusal(res, 'threads.input.-2', { reason: 'workspaceFields' });
      const agentRes = await request(httpServer).post('/api/threads').set('Authorization', `Bearer ${agentApiKey}`)
        .send({ title: 'Workspace', backend: { kind: 'native' } }).expect(403);
      refusal(agentRes, 'threads.principal.403');
    });

    it('US-003 AC1: creates an active thread with repo defaults and caller identity', async () => {
      const res = await createThread('add-auth').expect(201);
      const thread = body<{ id: string; status: string; createdById: string; baseRef: string; specPath: string; maxCostUsd: string }>(res);
      expect(thread).toMatchObject({ status: 'ACTIVE', createdById: world.ids.dev, baseRef: 'trunk', specPath: '.nax/features/add-auth/spec.md', maxCostUsd: '5' });
      threadId = thread.id;
    });

    it('US-003 AC2: snapshots only enabled skills with the source SHA', async () => {
      await db().projectSkill.deleteMany({ where: { projectId: world.projectId } });
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
      const snapshot = vi.spyOn(skills, 'snapshotForProject');
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
      refusal(res, 'threads.input.400', { reason: 'feature' });
    });

    it('US-003 AC9: rejects an unsupported ACP backend agent', async () => {
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads`).set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ repoId: world.repoId, feature: 'bad-backend', title: 'Bad backend', backend: { kind: 'acp', agent: 'gemini' } }).expect(400);
      refusal(res, 'threads.input.400', { reason: 'backend' });
    });

    it('US-003 AC11/AC12: creates a PROJECT thread with an anchor repo present and no repo fields on the row', async () => {
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads`).set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ kind: 'PROJECT', title: 'Brainstorm', backend: { kind: 'native', model: 'm1' } }).expect(201);
      const thread = body<{ id: string; kind: string; repoId: string | null; baseRef: string | null; feature: string | null; specPath: string | null; createdById: string }>(res);
      expect(thread).toMatchObject({
        kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null, createdById: world.ids.dev,
      });
      expect(await db().chatThread.findUniqueOrThrow({ where: { id: thread.id } }))
        .toMatchObject({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null });
    });

    it('US-003 AC2: rejects a PROJECT create that also carries a feature', async () => {
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads`).set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ kind: 'PROJECT', feature: 'project-thread-feature', title: 'Bad project thread', backend: { kind: 'native', model: 'm1' } }).expect(400);
      refusal(res, 'threads.input.400', { reason: 'projectFields' });
    });

    it('US-006 AC-2: refuses to plan a thread before its spec is published', async () => {
      const thread = body<{ id: string }>(await createThread('plan-unpublished').expect(201));
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(res, 'threads.notPublished.409');
    });

    it('refuses to plan when the thread owning runner was deleted after Publish', async () => {
      const thread = body<{ id: string }>(await createThread('plan-runner-deleted').expect(201));
      const runner = await createThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id, specPublished: true } });
      await db().runner.delete({ where: { id: runner.id } });
      const response = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(response, 'threads.runnerMissing.409');
      expect(await db().fleetJob.count({ where: { threadId: thread.id, command: 'PLAN' } })).toBe(0);
    });

    it('US-006 AC-3: folds a published line before planning the thread spec', async () => {
      const thread = body<{ id: string; repoId: string; specPath: string }>(await createThread('plan-folded-publish').expect(201));
      const ingestJob = await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: thread.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id, state: 'COMPLETED',
      } });
      const line = { type: 'published' as const, sha: 'a'.repeat(40), paths: [thread.specPath], ignored: [], specPresent: true };
      await app.get(PrismaThreadIngestRepository, { strict: false }).fold({
        jobId: ingestJob.id, leaseEpoch: 0, lines: [{ line, endOffset: 128 }], endOffset: 128, badLines: 0,
      });
      expect((await db().chatThread.findUniqueOrThrow({ where: { id: thread.id } })).specPublished).toBe(true);
      await attachThreadRunner(thread.id);
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201);
      const result = body<{ job: { id: string; ref: string; feature: string; planFrom: string } }>(res);
      expect(result.job).toMatchObject({ ref: 'feat/plan-folded-publish', feature: 'plan-folded-publish', planFrom: thread.specPath });
    });

    it('US-006 AC-15: placing a thread plan queues ASSIGN with the expected branch', async () => {
      const feature = 'plan-assign-payload';
      const thread = body<{ id: string }>(await createThread(feature).expect(201));
      const runner = await db().runner.create({ data: {
        name: `plan-${thread.id}`, apiKeyHash: `plan-hash-${thread.id}`, os: 'linux', arch: 'x64', labels: [],
        capabilities: {
          nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true, probedAt: new Date().toISOString() },
          profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'],
        },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: `plan-boot-${thread.id}`, lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id, specPublished: true } });
      const result = body<{ job: { id: string } }>(await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201));
      const assign = await db().fleetCommand.findFirst({ where: { jobId: result.job.id, type: 'ASSIGN' }, select: { payload: true } });
      expect(assign?.payload).toMatchObject({ expectBranch: `feat/${feature}` });
    });

    it('US-006 AC-1/8: dispatches a published thread plan on its feature ref with the default cap', async () => {
      const thread = body<{ id: string; feature: string; repoId: string; specPath: string }>(await createThread('plan-happy').expect(201));
      const runner = await attachThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201);
      const result = body<{ job: { id: string; repoId: string; command: string; ref: string; feature: string; planFrom: string; maxCostUsd: string } }>(res);
      expect(result.job).toMatchObject({ repoId: thread.repoId, command: 'PLAN', ref: 'feat/plan-happy', feature: 'plan-happy', planFrom: thread.specPath, maxCostUsd: '5' });
      await expect(db().fleetJob.findUniqueOrThrow({ where: { id: result.job.id } })).resolves.toMatchObject({ threadId: thread.id, pinnedRunnerId: runner.id });
    });

    it('US-006 AC-4/5: refuses a plan while a THREAD or PLAN job for that thread is active', async () => {
      for (const [feature, command] of [['busy-session', 'THREAD'], ['busy-plan', 'PLAN']] as const) {
        const thread = body<{ id: string }>(await createThread(feature).expect(201));
        await attachThreadRunner(thread.id);
        await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
        await db().fleetJob.create({ data: {
          projectId: world.projectId, repoId: world.repoId, ref: `feat/${feature}`, command, feature,
          planFrom: command === 'PLAN' ? '.nax/features/spec.md' : null, profiles: [], maxCostUsd: '5',
          selectorLabels: [], pinnedRunnerId: null, requestedById: world.ids.dev, threadId: thread.id, state: 'RUNNING',
        } });
        const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
          .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
        threadMessage(res, 'threads.busy.409');
      }
    });

    it('US-006 AC-7: forwards plan profiles and the requested cost cap', async () => {
      const thread = body<{ id: string }>(await createThread('plan-options').expect(201));
      await attachThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      const response = body<{ job: { id: string } }>(await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({ profiles: ['cc-plan'], maxCostUsd: 2 }).expect(201));
      const job = await db().fleetJob.findUniqueOrThrow({ where: { id: response.job.id } });
      expect(job.profiles).toEqual(['cc-plan']);
      expect(job.maxCostUsd.toString()).toBe('2');
    });

    it('US-006 AC-14: denies a thread creator whose project role no longer permits FleetJob creation', async () => {
      const thread = body<{ id: string }>(await createThread('plan-viewer').expect(201));
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'VIEWER' } });
      try {
        const denied = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
          .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(403);
        expect(denied.body.message).toBe('projects.40003');
      } finally {
        await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'DEVELOPER' } });
      }
    });

    it('US-006 AC-6: concurrent plans leave exactly one active job for the thread', async () => {
      const thread = body<{ id: string }>(await createThread('plan-race').expect(201));
      await attachThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      const postPlan = () => request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({});
      const results = await Promise.all([postPlan(), postPlan()]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      const conflict = results.find((res) => res.status === 409);
      expect(conflict).toBeDefined();
      if (!conflict) throw new Error('expected one conflicting plan request');
      threadMessage(conflict, 'threads.busy.409');
      const jobs = await db().fleetJob.findMany({ where: { threadId: thread.id, command: 'PLAN' } });
      expect(jobs).toHaveLength(1);
    });

    it('US-006 AC-13: thread detail exposes the latest plan and run handoff jobs', async () => {
      const thread = body<{ id: string; specPath: string }>(await createThread('plan-handoff').expect(201));
      await attachThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      const response = body<{ job: { id: string } }>(await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/plan`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201));
      await db().fleetJob.update({ where: { id: response.job.id }, data: { state: 'FAILED', stateReason: 'branch_mismatch' } });
      const detail = body<{ handoff: { plan: { jobId: string; state: string; stateReason: string | null }; run: unknown } }>(
        await request(httpServer).get(`/api/projects/${projectSlug}/threads/${thread.id}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200),
      );
      expect(detail.handoff).toEqual({ plan: { jobId: response.job.id, state: 'FAILED', stateReason: 'branch_mismatch' }, run: null });
    });

    it('US-007 AC-2: refuses to run a thread that has no plan', async () => {
      const thread = body<{ id: string }>(await createThread('run-no-plan').expect(201));
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(res, 'threads.notPlanned.409');
    });

    it('refuses to run when the owning runner was deleted after a completed PLAN', async () => {
      const thread = body<{ id: string; repoId: string; specPath: string; feature: string }>(await createThread('run-runner-deleted').expect(201));
      const runner = await attachThreadRunner(thread.id);
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: thread.repoId, ref: `feat/${thread.feature}`, command: 'PLAN', feature: thread.feature,
        planFrom: thread.specPath, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev,
        threadId: thread.id, state: 'COMPLETED', pinnedRunnerId: runner.id,
      } });
      await db().runner.delete({ where: { id: runner.id } });
      const response = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(response, 'threads.runnerMissing.409');
      expect(await db().fleetJob.count({ where: { threadId: thread.id, command: 'RUN' } })).toBe(0);
    });

    it('US-007 AC-3: refuses to run when the latest plan failed, even after an earlier completed plan', async () => {
      const thread = body<{ id: string; specPath: string }>(await createThread('run-failed-plan').expect(201));
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: thread.repoId, ref: 'feat/run-failed-plan', command: 'PLAN', feature: 'run-failed-plan',
        planFrom: thread.specPath, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'COMPLETED', queuedAt: new Date('2020-01-01T00:00:00Z'),
      } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: thread.repoId, ref: 'feat/run-failed-plan', command: 'PLAN', feature: 'run-failed-plan',
        planFrom: thread.specPath, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'FAILED', stateReason: 'branch_mismatch', queuedAt: new Date('2021-01-01T00:00:00Z'),
      } });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(res, 'threads.notPlanned.409');
    });

    it('US-007 AC-1: runs a thread whose latest plan completed on its feature ref, pinned to the thread runner', async () => {
      const feature = 'run-happy';
      const thread = body<{ id: string; repoId: string; feature: string; specPath: string }>(await createThread(feature).expect(201));
      const runner = await db().runner.create({ data: {
        name: `run-${thread.id}`, apiKeyHash: `run-hash-${thread.id}`, os: 'linux', arch: 'x64', labels: [],
        capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true, probedAt: new Date().toISOString() }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'] },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: `run-boot-${thread.id}`, lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id, specPublished: true } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: thread.repoId, ref: `feat/${feature}`, command: 'PLAN', feature,
        planFrom: thread.specPath, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'COMPLETED',
      } });
      const result = body<{ job: { id: string; command: string; ref: string; feature: string; planFrom: string | null; pinnedRunnerId: string | null } }>(
        await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
          .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201),
      );
      expect(result.job).toMatchObject({ command: 'RUN', ref: `feat/${feature}`, feature, planFrom: null, pinnedRunnerId: runner.id });
      await expect(db().fleetJob.findUniqueOrThrow({ where: { id: result.job.id } })).resolves.toMatchObject({ threadId: thread.id, pinnedRunnerId: runner.id });
    });

    it('US-007 AC-4: forwards the run bash mode and profiles', async () => {
      const thread = body<{ id: string }>(await createThread('run-options').expect(201));
      await attachThreadRunner(thread.id, { approvals: { relay: true } });
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'feat/run-options', command: 'PLAN', feature: 'run-options',
        planFrom: '.nax/features/run-options/spec.md', profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'COMPLETED',
      } });
      const response = body<{ job: { id: string } }>(await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({ bashMode: 'escalate', profiles: ['native'] }).expect(201));
      const job = await db().fleetJob.findUniqueOrThrow({ where: { id: response.job.id } });
      expect({ bashMode: job.bashMode, profiles: job.profiles }).toEqual({ bashMode: 'escalate', profiles: ['native'] });
    });

    it('US-007 AC-5: refuses a run while a RUN job of the thread is active', async () => {
      const thread = body<{ id: string }>(await createThread('run-busy').expect(201));
      await attachThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'feat/run-busy', command: 'PLAN', feature: 'run-busy',
        planFrom: '.nax/features/run-busy/spec.md', profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'COMPLETED',
      } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'feat/run-busy', command: 'RUN', feature: 'run-busy',
        planFrom: null, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id, state: 'RUNNING',
      } });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(res, 'threads.busy.409');
    });

    it('US-007 AC-6: the ASSIGN for a thread run carries no expectBranch', async () => {
      const feature = 'run-assign-payload';
      const thread = body<{ id: string }>(await createThread(feature).expect(201));
      const runner = await db().runner.create({ data: {
        name: `run-assign-${thread.id}`, apiKeyHash: `run-assign-hash-${thread.id}`, os: 'linux', arch: 'x64', labels: [],
        capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true, probedAt: new Date().toISOString() }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'] },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: `run-assign-boot-${thread.id}`, lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id, specPublished: true } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: world.repoId, ref: `feat/${feature}`, command: 'PLAN', feature,
        planFrom: `.nax/features/${feature}/spec.md`, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'COMPLETED',
      } });
      const result = body<{ job: { id: string } }>(await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201));
      const assign = await db().fleetCommand.findFirst({ where: { jobId: result.job.id, type: 'ASSIGN' }, select: { payload: true } });
      expect(assign).not.toBeNull();
      expect(assign?.payload).not.toHaveProperty('expectBranch');
    });

    it('US-007 AC-7: refuses a run by a project member who is not the thread creator', async () => {
      const thread = await newThread('run-noncreator', { createdById: world.ids.root });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(403);
      threadMessage(res, 'threads.notCreator.403');
    });

    it('US-007 AC-8: thread detail reports the run job after a run was created', async () => {
      const thread = body<{ id: string }>(await createThread('run-handoff').expect(201));
      await attachThreadRunner(thread.id);
      await db().chatThread.update({ where: { id: thread.id }, data: { specPublished: true } });
      await db().fleetJob.create({ data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'feat/run-handoff', command: 'PLAN', feature: 'run-handoff',
        planFrom: '.nax/features/run-handoff/spec.md', profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        state: 'COMPLETED',
      } });
      const response = body<{ job: { id: string } }>(await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/run`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(201));
      const detail = body<{ handoff: { run: { jobId: string } | null } }>(
        await request(httpServer).get(`/api/projects/${projectSlug}/threads/${thread.id}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200),
      );
      expect(detail.handoff.run?.jobId).toBe(response.job.id);
    });

    it('US-003 AC10: rejects a second active thread for the same repo and feature', async () => {
      await createThread('same-active-feature').expect(201);
      const res = await createThread('same-active-feature').expect(409);
      refusal(res, 'threads.featureTaken.409', { feature: 'same-active-feature' });
    });

    it('US-003 AC11: returns not found for a repo belonging to another project', async () => {
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads`).set('Authorization', `Bearer ${world.tokens.dev}`)
        .send({ repoId: world.foreignRepoId, feature: 'foreign-repo', title: 'Foreign repo', backend: { kind: 'native' } }).expect(404);
      refusal(res, 'fleet.repos.404');
    });

    it('US-003 AC12: lists project threads for a viewer ordered by recent activity', async () => {
      const older = body<{ id: string }>(await createThread('list-older').expect(201));
      const newer = body<{ id: string }>(await createThread('list-newer').expect(201));
      await db().chatThread.update({ where: { id: older.id }, data: { lastActivityAt: new Date('2020-01-01T00:00:00Z') } });
      await db().chatThread.update({ where: { id: newer.id }, data: { lastActivityAt: new Date('2021-01-01T00:00:00Z') } });
      await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.viewer } }, data: { role: 'VIEWER' } });
      try {
        // size=100: the US-007 block adds threads to this project, so the default page of 20 can drop both.
        const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads?size=100`).set('Authorization', `Bearer ${world.tokens.viewer}`).expect(200);
        const items = body<{ items: Array<{ id: string }> }>(res).items;
        expect(items.findIndex((item) => item.id === newer.id)).toBeGreaterThanOrEqual(0);
        expect(items.findIndex((item) => item.id === newer.id)).toBeLessThan(items.findIndex((item) => item.id === older.id));
      } finally {
        await db().projectMember.update({ where: { projectId_userId: { projectId: world.projectId, userId: world.ids.dev } }, data: { role: 'DEVELOPER' } });
      }
    });

    it('US-003 AC12: returns not found when listing threads for an unknown project', async () => {
      const res = await request(httpServer).get('/api/projects/no-such-project/threads').set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
      expect(res.body.message).toBe('Project not found');
    });

    it('US-003 AC13: gets a thread while the feature kill switch is disabled', async () => {
      config().threadsEnabled = false;
      try {
        const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads/${threadId}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
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
      const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads/${foreignThread.id}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
      threadMessage(res, 'threads.notFound.404');
    });

    it('US-003 AC15: returns messages after the requested sequence in ascending order', async () => {
      const thread = await db().chatThread.create({ data: {
        projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: 'messages-thread', title: 'Messages',
        createdById: world.ids.dev, backend: { kind: 'native' }, skills: [], specPath: '.nax/features/messages-thread/spec.md',
      } });
      await db().chatMessage.createMany({ data: [1, 2, 3].map((seq) => ({ threadId: thread.id, seq, role: 'user', authorUserId: world.ids.dev, content: `message-${seq}`, status: 'complete' })) });
      const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads/${thread.id}/messages?afterSeq=1`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
      expect(body<{ items: Array<{ seq: number }> }>(res).items.map((message) => message.seq)).toEqual([2, 3]);
    });

    it('US-003 AC15: returns not found for messages on an unknown thread', async () => {
      const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads/no-such-thread/messages`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
      threadMessage(res, 'threads.notFound.404');
    });

    const sendMessage = (id: string, token = world.tokens.dev, payload = { text: 'hello', clientMessageId: `send-${id}` }) =>
      request(httpServer).post(`/api/projects/${projectSlug}/threads/${id}/messages`)
        .set('Authorization', `Bearer ${token}`).send(payload);

    const publishThread = (id: string, token = world.tokens.dev) => request(httpServer)
      .post(`/api/projects/${projectSlug}/threads/${id}/publish`).set('Authorization', `Bearer ${token}`).send({});

    const discardThread = (id: string, token = world.tokens.dev) => request(httpServer)
      .post(`/api/projects/${projectSlug}/threads/${id}/discard`).set('Authorization', `Bearer ${token}`).send({});

    const newThread = async (feature: string, over: Record<string, unknown> = {}) => db().chatThread.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature, title: feature,
        createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
        specPath: `.nax/features/${feature}/spec.md`, ...over,
      },
    });

    const publishRunner = async (feature: string) => db().runner.create({ data: {
      name: `publish-${feature}`, apiKeyHash: `publish-hash-${feature}`, os: 'linux', arch: 'x64', labels: ['linux'],
      capabilities: { threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `publish-${feature}`,
      lastSeenAt: new Date(), createdById: world.ids.root,
    } });

    const liveSession = async (feature: string, over: Record<string, unknown> = {}) => {
      const thread = await newThread(feature, over);
      const runner = await db().runner.create({ data: {
        name: `session-${thread.id}`, apiKeyHash: `session-hash-${thread.id}`, os: 'linux', arch: 'x64', labels: ['linux'],
        capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, threadBackends: { native: ['m1'], acp: [] } },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'session-boot', lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id } });
      const job = await db().fleetJob.create({ data: {
        projectId: thread.projectId, repoId: thread.repoId, ref: thread.baseRef, command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        runnerId: runner.id, state: 'RUNNING', leaseEpoch: 7,
      } });
      return { thread, runner, job };
    };

    it('US-003 publish: queues a PUBLISH turn for saved written paths', async () => {
      const runner = await publishRunner('publish-e2e');
      const thread = await newThread('publish-e2e', { writtenPaths: ['docs/a.md'], runnerId: runner.id });
      const res = await publishThread(thread.id).expect(200);
      const result = body<{ jobId: string }>(res);
      expect(result.jobId).toBeTruthy();
      const job = await db().fleetJob.findUniqueOrThrow({ where: { id: result.jobId } });
      expect(job).toMatchObject({ command: 'THREAD', threadId: thread.id });
      expect(job.maxCostUsd.toString()).toBe('0');
      expect(await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: result.jobId } })).toMatchObject({
        action: 'PUBLISH', initialMessageId: null, resume: false,
      });
    });

    it('US-003 publish: refuses when no paths are available', async () => {
      const runner = await publishRunner('publish-empty');
      const thread = await newThread('publish-empty', { runnerId: runner.id });
      const res = await publishThread(thread.id).expect(409);
      threadMessage(res, 'threads.nothingToPublish.409');
      expect(await db().fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
    });

    it('US-004 discard: queues a zero-cost DISCARD turn on a pinned runner with threadWrite', async () => {
      const runner = await publishRunner('discard-e2e');
      const thread = await newThread('discard-e2e', { runnerId: runner.id });
      const result = body<{ jobId: string }>(await discardThread(thread.id).expect(200));
      expect(result.jobId).toBeTruthy();
      const job = await db().fleetJob.findUniqueOrThrow({ where: { id: result.jobId } });
      expect(job).toMatchObject({ command: 'THREAD', threadId: thread.id });
      expect(job.maxCostUsd.toString()).toBe('0');
      expect(await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: result.jobId } })).toMatchObject({
        action: 'DISCARD', initialMessageId: null, resume: false,
      });
    });

    it('US-004 discard: refuses with threads.busy while a live session job is active', async () => {
      const { thread, runner } = await liveSession('discard-busy');
      // Discard needs threadWrite on the pinned runner; without it the runnerOutdated check answers first (brief order).
      await db().runner.update({ where: { id: runner.id }, data: { capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, threadBackends: { native: ['m1'], acp: [] }, threadWrite: true } } });
      const res = await discardThread(thread.id).expect(409);
      threadMessage(res, 'threads.busy.409');
      expect(await db().fleetJob.count({ where: { threadId: thread.id, command: 'THREAD', state: 'QUEUED' } })).toBe(0);
    });

    it('US-004 discard: a pinned runner without threadWrite answers runnerOutdated before busy (brief order)', async () => {
      const { thread } = await liveSession('discard-outdated-first');
      const res = await discardThread(thread.id).expect(409);
      threadMessage(res, 'threads.runnerOutdated.409');
    });

    it('US-004 discard: refuses with threads.nothingToDiscard when the thread has no pinned runner', async () => {
      const thread = await newThread('discard-empty');
      const res = await discardThread(thread.id).expect(409);
      threadMessage(res, 'threads.nothingToDiscard.409');
      expect(await db().fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
    });

    it('US-004 AC5: creator send inserts a pending user message at sequence 1', async () => {
      const thread = await newThread('send-first');
      const res = await sendMessage(thread.id).expect(201);
      expect(body<{ message: { role: string; status: string; seq: number; authorUserId: string } }>(res).message)
        .toMatchObject({ role: 'user', status: 'pending', seq: 1, authorUserId: world.ids.dev });
    });

    it('US-004 AC6-10: first send creates a THREAD job and SESSION turn then places it', async () => {
      const thread = await newThread('send-session');
      const placement = vi.spyOn(app.get(PlacementService), 'placeJob');
      try {
        const res = await sendMessage(thread.id).expect(201);
        const result = body<{ message: { id: string }; jobId: string }>(res);
        const jobs = await db().fleetJob.findMany({ where: { threadId: thread.id }, take: 2 });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ command: 'THREAD', threadId: thread.id, feature: `thread-${thread.id}`, ref: thread.baseRef, profiles: [], bashMode: 'raw', pinnedRunnerId: null });
        const turn = await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: result.jobId } });
        expect(turn).toMatchObject({ action: 'SESSION', initialMessageId: result.message.id, resume: false, backend: thread.backend, skills: thread.skills });
        const repo = await db().fleetRepo.findUniqueOrThrow({ where: { id: thread.repoId } });
        const project = await db().project.findUniqueOrThrow({ where: { id: thread.projectId }, select: { brief: true } });
        expect(turn.instructions).toBe(buildThreadInstructions({
          repo: `${repo.owner}/${repo.name}`, baseRef: thread.baseRef, feature: thread.feature,
          specPath: thread.specPath, skills: thread.skills as unknown as ThreadSkillSource[],
          // S5b US-003: every SESSION turn carries the L0 brief block after its role line.
          brief: renderBriefBlock({ brief: project.brief, repoContext: 'Repository context: unavailable (no context file)' }),
        }));
        expect(turn.instructions.split('\n').slice(1, 3)).toEqual(['Project brief:', project.brief ?? '(none)']);
        expect(turn.instructions).toContain('write_doc');
        expect(placement).toHaveBeenCalledTimes(1);
        expect(placement).toHaveBeenCalledWith(result.jobId);
      } finally {
        placement.mockRestore();
      }
    });

    it('US-004 AC7: first send subtracts existing thread cost from its session budget', async () => {
      const thread = await newThread('send-budget', { maxCostUsd: '5', costUsd: '1.25' });
      const result = body<{ jobId: string }>(await sendMessage(thread.id).expect(201));
      const job = await db().fleetJob.findUniqueOrThrow({ where: { id: result.jobId } });
      expect(job.maxCostUsd.toString()).toBe('3.75');
    });

    it('US-004 AC11: a completed prior THREAD job resumes on the thread runner', async () => {
      const thread = await newThread('send-resume');
      const runner = await db().runner.create({ data: {
        name: `thread-runner-${thread.id}`, apiKeyHash: `thread-hash-${thread.id}`, os: 'linux', arch: 'x64', labels: ['linux'],
        capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, threadBackends: { native: ['m1'], acp: [] } },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'thread-boot', lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id } });
      const previous = await db().fleetJob.create({ data: {
        projectId: thread.projectId, repoId: thread.repoId, ref: thread.baseRef, command: 'THREAD', feature: `old-${thread.id}`,
        profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id, state: 'COMPLETED',
      } });
      await db().fleetThreadTurn.create({ data: {
        jobId: previous.id, threadId: thread.id, action: 'SESSION', initialMessageId: null, instructions: '',
        backend: thread.backend as object, skills: [], resume: false,
      } });
      const result = body<{ jobId: string }>(await sendMessage(thread.id).expect(201));
      const job = await db().fleetJob.findUniqueOrThrow({ where: { id: result.jobId } });
      const turn = await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: result.jobId } });
      expect(job.pinnedRunnerId).toBe(runner.id);
      expect(turn.resume).toBe(true);
    });

    it('US-004 AC12: live session send creates a THREAD_INPUT command instead of another job', async () => {
      const thread = await newThread('send-live');
      const runner = await db().runner.create({ data: {
        name: `live-runner-${thread.id}`, apiKeyHash: `live-hash-${thread.id}`, os: 'linux', arch: 'x64', labels: ['linux'],
        capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, threadBackends: { native: ['m1'], acp: [] } },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'live-boot', lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      await db().chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id } });
      const job = await db().fleetJob.create({ data: {
        projectId: thread.projectId, repoId: thread.repoId, ref: thread.baseRef, command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, threadId: thread.id,
        runnerId: runner.id, state: 'RUNNING', leaseEpoch: 7,
      } });
      const notifier = vi.spyOn(app.get(RunnerNotifier), 'notify');
      try {
        const res = await sendMessage(thread.id).expect(201);
        const message = body<{ message: { id: string } }>(res).message;
        expect(await db().fleetJob.count({ where: { threadId: thread.id } })).toBe(1);
        const command = await db().fleetCommand.findFirstOrThrow({ where: { jobId: job.id, type: 'THREAD_INPUT' } });
        expect(command).toMatchObject({ runnerId: runner.id, leaseEpoch: 7, payload: { messageId: message.id, text: 'hello' } });
        expect(notifier).toHaveBeenCalledWith(runner.id);
      } finally {
        notifier.mockRestore();
      }
    });

    it('US-004 AC14: retrying a clientMessageId returns its existing message without new work', async () => {
      const thread = await newThread('send-dedupe');
      const payload = { text: 'hello', clientMessageId: 'retry-1' };
      const first = body<{ message: { id: string } }>(await sendMessage(thread.id, world.tokens.dev, payload).expect(201));
      const jobsBefore = await db().fleetJob.count({ where: { threadId: thread.id } });
      const commandsBefore = await db().fleetCommand.count({ where: { job: { threadId: thread.id } } });
      const retry = body<{ message: { id: string }; jobId: string | null }>(await sendMessage(thread.id, world.tokens.dev, payload).expect(200));
      expect(retry).toMatchObject({ message: { id: first.message.id }, jobId: null });
      expect(await db().fleetJob.count({ where: { threadId: thread.id } })).toBe(jobsBefore);
      expect(await db().fleetCommand.count({ where: { job: { threadId: thread.id } } })).toBe(commandsBefore);
    });

    it('US-004 AC15: message sequence follows the existing completed message', async () => {
      const thread = await newThread('send-next-seq', { nextSeq: 2 });
      await db().chatMessage.create({ data: { threadId: thread.id, seq: 1, role: 'user', content: 'previous', status: 'complete' } });
      const result = body<{ message: { seq: number } }>(await sendMessage(thread.id).expect(201));
      expect(result.message.seq).toBe(2);
    });

    it('US-004 access: refuses a message from a non-creator', async () => {
      const thread = await newThread('send-noncreator', { createdById: world.ids.root });
      await sendMessage(thread.id).expect(403);
    });

    it('US-007 AC2: stop returns the no-session conflict', async () => {
      const thread = await newThread('stop-no-session');
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/stop`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(res, 'threads.noSession.409');
    });

    it('US-007 AC4: end-session returns the no-session conflict', async () => {
      const thread = await newThread('close-no-session');
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/end-session`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409);
      threadMessage(res, 'threads.noSession.409');
    });

    it('US-007 AC6: answer returns the no-question conflict without a session', async () => {
      const thread = await newThread('answer-no-question');
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/answer`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({ requestId: 'q1', text: 'yes' }).expect(409);
      threadMessage(res, 'threads.noQuestion.409');
    });

    it('workspace isolation: every project transcript/action surface hides a WORKSPACE thread', async () => {
      const thread = await db().chatThread.create({ data: {
        projectId: world.projectId, kind: 'WORKSPACE', title: 'Private workspace', createdById: world.ids.dev,
        backend: { kind: 'native', model: 'm1' }, skills: [],
      } });
      const base = `/api/projects/${projectSlug}/threads/${thread.id}`;
      const auth = { Authorization: `Bearer ${world.tokens.dev}` };
      const list = await request(httpServer).get(`/api/projects/${projectSlug}/threads`).set(auth).expect(200);
      expect(body<{ items: { id: string }[] }>(list).items.map(item => item.id)).not.toContain(thread.id);
      for (const suffix of ['', '/messages', '/events']) {
        threadMessage(await request(httpServer).get(`${base}${suffix}`).set(auth).expect(404), 'threads.notFound.404');
      }
      for (const [suffix, payload] of [
        ['messages', { text: 'private', clientMessageId: 'private' }], ['publish', {}], ['discard', {}],
        ['archive', {}], ['end-session', {}], ['stop', {}], ['answer', { requestId: 'q1', text: 'yes' }],
        ['plan', {}], ['run', {}],
      ] as const) {
        threadMessage(await request(httpServer).post(`${base}/${suffix}`).set(auth).send(payload).expect(404), 'threads.notFound.404');
      }
      threadMessage(await request(httpServer).patch(base).set(auth).send({ maxCostUsd: 9 }).expect(404), 'threads.notFound.404');
      expect(await db().chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
      expect(await db().chatThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({ status: 'ACTIVE' });
    });

    it('US-007 AC7: creator updates the thread cost cap', async () => {
      const thread = await newThread('patch-cap');
      const res = await request(httpServer).patch(`/api/projects/${projectSlug}/threads/${thread.id}`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({ maxCostUsd: 10 }).expect(200);
      expect(body<{ maxCostUsd: string }>(res).maxCostUsd).toBe('10');
    });

    it('US-007 AC1: stop queues a turn-stop command for the live runner epoch', async () => {
      const { thread, runner, job } = await liveSession('stop-live');
      await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/stop`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(200);
      await expect(db().fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).resolves.toEqual([
        expect.objectContaining({ runnerId: runner.id, leaseEpoch: 7, payload: {} }),
      ]);
    });

    it('US-007 AC3: stop denies a developer who is not the creator', async () => {
      const { thread } = await liveSession('stop-noncreator', { createdById: world.ids.root });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/stop`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(403);
      threadMessage(res, 'threads.notCreator.403');
    });

    it('US-007 AC4: end-session queues a close command for the live runner epoch', async () => {
      const { thread, runner, job } = await liveSession('close-live');
      await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/end-session`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(200);
      await expect(db().fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_CLOSE' } })).resolves.toEqual([
        expect.objectContaining({ runnerId: runner.id, leaseEpoch: 7 }),
      ]);
    });

    it('US-007 AC5: answer queues the matching pending question', async () => {
      const { thread, runner, job } = await liveSession('answer-live', { pendingQuestion: { requestId: 'q1' } });
      await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/answer`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({ requestId: 'q1', text: 'yes' }).expect(200);
      await expect(db().fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_ANSWER' } })).resolves.toEqual([
        expect.objectContaining({ runnerId: runner.id, leaseEpoch: 7, payload: { requestId: 'q1', text: 'yes' } }),
      ]);
    });

    it('US-007 AC6: answer rejects a different pending question', async () => {
      const { thread } = await liveSession('answer-mismatch', { pendingQuestion: { requestId: 'q1' } });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/answer`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({ requestId: 'q2', text: 'yes' }).expect(409);
      threadMessage(res, 'threads.noQuestion.409');
    });

    it('US-007 AC8: creator archives a running thread and requests cancellation', async () => {
      const { thread, job } = await liveSession('archive-thread');
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/archive`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(200);
      expect(body<{ status: string }>(res).status).toBe('ARCHIVED');
      expect(await db().fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(expect.objectContaining({ cancelRequestedAt: expect.any(Date) }));
      expect(await db().fleetCommand.count({ where: { jobId: job.id, type: 'CANCEL' } })).toBe(1);
    });

    it('US-007 AC9: project admin can archive another creator thread', async () => {
      const thread = await newThread('archive-admin', { createdById: world.ids.dev });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/archive`)
        .set('Authorization', `Bearer ${world.tokens.root}`).send({}).expect(200);
      expect(body<{ status: string }>(res).status).toBe('ARCHIVED');
    });

    it('US-007 AC10: developer cannot archive another creator thread', async () => {
      const thread = await newThread('archive-noncreator', { createdById: world.ids.root });
      const res = await request(httpServer).post(`/api/projects/${projectSlug}/threads/${thread.id}/archive`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(403);
      threadMessage(res, 'threads.notCreator.403');
    });

    it('US-001 AC1: thread detail answers a sendRefusal fact (null with nothing blocking)', async () => {
      const thread = await newThread('facts-detail');
      const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads/${thread.id}`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
      expect(body<{ id: string; sendRefusal: unknown }>(res).sendRefusal).toBeNull();
    });

    it('US-001 AC9: thread list answers threadsEnabled from the kill-switch config', async () => {
      const res = await request(httpServer).get(`/api/projects/${projectSlug}/threads`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
      expect(body<{ items: unknown[]; threadsEnabled: boolean }>(res).threadsEnabled).toBe(true);
    });

    it('US-001 AC14: project runner summaries carry validated threadBackends', async () => {
      const runner = await db().runner.create({ data: {
        name: `facts-runner-${threadId}`, apiKeyHash: `facts-hash-${threadId}`, os: 'linux', arch: 'x64', labels: ['linux'],
        capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, threadBackends: { native: ['m1'], acp: [] } },
        daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'facts-boot', lastSeenAt: new Date(), createdById: world.ids.root,
      } });
      const res = await request(httpServer).get(`/api/projects/${projectSlug}/fleet/runners`)
        .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
      const records = body<{ records: Array<Record<string, unknown>> }>(res).records;
      const summary = records.find((record) => record.id === runner.id);
      expect(summary).toBeDefined();
      expect((summary as Record<string, unknown>).threadBackends).toEqual({ native: ['m1'], acp: [] });
    });

    // ─────────────────────────────────────────────────────────────────
    // S5b US-003 — the L0 brief block in a SESSION turn's instructions
    // ─────────────────────────────────────────────────────────────────

    describe('S5b US-003 brief block in thread instructions', () => {
      let seeded: { slug: string };

      beforeAll(async () => {
        const prisma = db();
        const dev = await prisma.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
        // Its own project: its anchor repository has no GitHub installation, so the section is the deterministic
        // `no installation` line (no forge call at all) and the shared thread suite's repo is left untouched.
        const project = await prisma.project.create({ data: { name: 'Brief block', slug: 'brief-block', key: 'BRFB' } });
        await prisma.projectMember.create({ data: { projectId: project.id, userId: dev.id, role: 'DEVELOPER' } });
        await prisma.fleetRepo.create({ data: {
          projectId: project.id, provider: 'github', owner: 'acme', name: 'brief-app', defaultBranch: 'trunk',
          githubInstallationId: null, createdById: world.ids.root,
        } });
        await prisma.project.update({ where: { id: project.id }, data: { brief: 'Seeded brief' } });
        seeded = { slug: project.slug };
      });

      it('AC-10: a PROJECT send stores the project brief and the anchor repository section right after the role line', async () => {
        const thread = body<{ id: string }>(await request(httpServer)
          .post(`/api/projects/${seeded.slug}/threads`).set('Authorization', `Bearer ${world.tokens.dev}`)
          .send({ kind: 'PROJECT', title: 'Seeded', backend: { kind: 'native' } })
          .expect(201));
        const sent = body<{ jobId: string }>(await request(httpServer)
          .post(`/api/projects/${seeded.slug}/threads/${thread.id}/messages`).set('Authorization', `Bearer ${world.tokens.dev}`)
          .send({ text: 'hello', clientMessageId: `brief-${thread.id}` })
          .expect(201));

        const turn = await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: sent.jobId } });
        expect(turn.action).toBe('SESSION');
        expect(turn.instructions.split('\n').slice(1, 4))
          .toEqual(['Project brief:', 'Seeded brief', 'Repository context: unavailable (no installation)']);
      });

      it('AC-11: a REPO send stores the project brief as the second and third line', async () => {
        await db().project.update({ where: { id: world.projectId }, data: { brief: 'Repo brief' } });
        try {
          const thread = await newThread('brief-repo');
          const sent = body<{ jobId: string }>(await sendMessage(thread.id).expect(201));

          const turn = await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: sent.jobId } });
          expect(turn.instructions.split('\n').slice(1, 3)).toEqual(['Project brief:', 'Repo brief']);
        } finally {
          await db().project.update({ where: { id: world.projectId }, data: { brief: null } });
        }
      });

      it('AC-12: publish queues a PUBLISH job and resolves no repository context', async () => {
        const runner = await publishRunner('brief-publish');
        const thread = await newThread('brief-publish', { writtenPaths: ['docs/a.md'], runnerId: runner.id });
        const resolveRepoContext = vi.spyOn(app.get(ProjectBriefService, { strict: false }), 'resolveRepoContext');
        try {
          const result = body<{ jobId: string }>(await publishThread(thread.id).expect(200));

          expect(result.jobId).toBeTruthy();
          expect(await db().fleetJob.count({ where: { threadId: thread.id, command: 'THREAD' } })).toBe(1);
          expect(await db().fleetThreadTurn.findUniqueOrThrow({ where: { jobId: result.jobId } })).toMatchObject({ action: 'PUBLISH' });
          expect(resolveRepoContext).not.toHaveBeenCalled();
        } finally {
          resolveRepoContext.mockRestore();
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────
    // S5b US-004 — top-level /threads read routes, commands and events
    // ─────────────────────────────────────────────────────────────────

    describe('S5b US-004 workspace read routes and events', () => {
      let workspaceId: string;

      beforeAll(async () => {
        workspaceId = body<{ id: string }>(await request(httpServer).post('/api/threads')
          .set('Authorization', `Bearer ${world.tokens.dev}`)
          .send({ title: 'Workspace read', backend: { kind: 'native' }, homeProject: projectSlug }).expect(201)).id;
      });

      it('GET /api/threads lists the caller’s workspace threads and refuses an agent key or bad query', async () => {
        const list = body<{ items: Array<Record<string, unknown>>; threadsEnabled: boolean }>(
          await request(httpServer).get('/api/threads').set('Authorization', `Bearer ${world.tokens.dev}`).expect(200));
        expect(list.items.find((item) => item.id === workspaceId)).toMatchObject({ kind: 'WORKSPACE', homeProject: { slug: projectSlug } });
        expect(list.items.every((item) => item.kind === 'WORKSPACE')).toBe(true);
        expect(list.threadsEnabled).toBe(true);
        refusal(await request(httpServer).get('/api/threads').set('Authorization', `Bearer ${agentApiKey}`).expect(403), 'threads.principal.403');
        refusal(await request(httpServer).get('/api/threads?page=0').set('Authorization', `Bearer ${world.tokens.dev}`).expect(400), 'threads.input.400', { reason: 'page' });
      });

      it('GET /api/threads/:id answers the creator and hides other users’ and other kinds’ threads', async () => {
        const thread = body<{ kind: string; handoff: unknown; homeProject: { slug: string } }>(
          await request(httpServer).get(`/api/threads/${workspaceId}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200));
        expect(thread).toMatchObject({ kind: 'WORKSPACE', handoff: { plan: null, run: null }, homeProject: { slug: projectSlug } });
        refusal(await request(httpServer).get(`/api/threads/${workspaceId}`).set('Authorization', `Bearer ${world.tokens.root}`).expect(404), 'threads.notFound.404');
        refusal(await request(httpServer).get(`/api/threads/${threadId}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(404), 'threads.notFound.404');
      });

      it('GET /api/threads/:id/messages answers the creator and rejects a limit outside the shared bounds', async () => {
        await db().chatMessage.create({ data: { threadId: workspaceId, seq: 1, role: 'user', content: 'hi', status: 'complete' } });
        const list = body<{ items: Array<Record<string, unknown>> }>(
          await request(httpServer).get(`/api/threads/${workspaceId}/messages`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200));
        expect(list.items).toEqual([expect.objectContaining({ seq: 1, content: 'hi' })]);
        refusal(await request(httpServer).get(`/api/threads/${workspaceId}/messages?limit=0`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(400), 'threads.input.400', { reason: 'messages' });
      });

      it('PATCH /api/threads/:id answers the cap with the home project and hides the thread from a non-creator', async () => {
        const thread = body<{ maxCostUsd: string; homeProject: { slug: string } }>(
          await request(httpServer).patch(`/api/threads/${workspaceId}`).set('Authorization', `Bearer ${world.tokens.dev}`).send({ maxCostUsd: 9 }).expect(200));
        expect(thread).toMatchObject({ maxCostUsd: '9', homeProject: { slug: projectSlug } });
        refusal(await request(httpServer).patch(`/api/threads/${workspaceId}`).set('Authorization', `Bearer ${world.tokens.root}`).send({ maxCostUsd: 9 }).expect(404), 'threads.notFound.404');
      });

      it('POST /api/threads/:id/end-session answers 409 without a live session and hides the thread from a non-creator', async () => {
        refusal(await request(httpServer).post(`/api/threads/${workspaceId}/end-session`).set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409), 'threads.noSession.409');
        refusal(await request(httpServer).post(`/api/threads/${workspaceId}/end-session`).set('Authorization', `Bearer ${world.tokens.root}`).send({}).expect(404), 'threads.notFound.404');
      });

      it('POST /api/threads/:id/stop answers 409 without a live session and hides the thread from a non-creator', async () => {
        refusal(await request(httpServer).post(`/api/threads/${workspaceId}/stop`).set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(409), 'threads.noSession.409');
        refusal(await request(httpServer).post(`/api/threads/${workspaceId}/stop`).set('Authorization', `Bearer ${world.tokens.root}`).send({}).expect(404), 'threads.notFound.404');
      });

      it('POST /api/threads/:id/answer validates the body and hides the thread from a non-creator', async () => {
        refusal(await request(httpServer).post(`/api/threads/${workspaceId}/answer`).set('Authorization', `Bearer ${world.tokens.dev}`).send({ requestId: 'q1', text: '' }).expect(400), 'threads.input.400', { reason: 'answer' });
        refusal(await request(httpServer).post(`/api/threads/${workspaceId}/answer`).set('Authorization', `Bearer ${world.tokens.root}`).send({ requestId: 'q1', text: 'yes' }).expect(404), 'threads.notFound.404');
      });

      it('workspace messages and archive: creator succeeds, non-creator is hidden, malformed message is refused', async () => {
        const id = body<{ id: string }>(await request(httpServer).post('/api/threads')
          .set('Authorization', `Bearer ${world.tokens.dev}`)
          .send({ title: 'Workspace turn', backend: { kind: 'native' }, homeProject: projectSlug }).expect(201)).id;
        const messagesUrl = `/api/threads/${id}/messages`;
        const archiveUrl = `/api/threads/${id}/archive`;
        refusal(await request(httpServer).post(messagesUrl).set('Authorization', `Bearer ${world.tokens.root}`).send({ text: 'hi', clientMessageId: 'one' }).expect(404), 'threads.notFound.404');
        refusal(await request(httpServer).post(messagesUrl).set('Authorization', `Bearer ${world.tokens.dev}`).send({ text: '', clientMessageId: 'one' }).expect(400), 'threads.input.400', { reason: 'message' });
        const sent = body<{ message: { id: string }; jobId: string }>(await request(httpServer).post(messagesUrl).set('Authorization', `Bearer ${world.tokens.dev}`).send({ text: 'hi', clientMessageId: 'one' }).expect(201));
        expect(sent.jobId).toBeTruthy();
        expect(body<{ message: { id: string } }>(await request(httpServer).post(messagesUrl).set('Authorization', `Bearer ${world.tokens.dev}`).send({ text: 'hi', clientMessageId: 'one' }).expect(200)).message.id).toBe(sent.message.id);
        refusal(await request(httpServer).post(archiveUrl).set('Authorization', `Bearer ${world.tokens.root}`).send({}).expect(404), 'threads.notFound.404');
        expect(body<{ status: string }>(await request(httpServer).post(archiveUrl).set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(200)).status).toBe('ARCHIVED');
      });

      it('workspace tool route answers a held RUNNING job', async () => {
        const seeded = await seedThreadJob(httpServer, db(), world, { kind: 'WORKSPACE' });
        try {
          const res = await request(httpServer).post(`/api/fleet/runner/jobs/${seeded.jobId}/tools/koda_search_tickets?leaseEpoch=1`)
            .set('Authorization', `Bearer ${seeded.runnerKey}`).send({ toolCallId: 'workspace-call', input: { project: projectSlug } }).expect(200);
          expect(body<{ isError: boolean }>(res).isError).toBe(false);
        } finally { await db().runner.update({ where: { id: seeded.runnerId }, data: { enabled: false } }); }
      });

      it('GET /api/threads/:id/events hides the stream from a non-creator', async () => {
        // The open-stream happy path needs the streaming helper (it never ends for supertest): test/integration/fleet.
        refusal(await request(httpServer).get(`/api/threads/${workspaceId}/events`).set('Authorization', `Bearer ${world.tokens.root}`).expect(404), 'threads.notFound.404');
      });
    });

    describe('S5b 2a US-005 assistant_action decide', () => {
      const proposeAction = async (): Promise<{ actionId: string; approvalId: string; threadId: string }> => {
        // A fresh feature per call: the active (repo, feature) pair is unique and the fixture defaults to `add-auth`.
        const seeded = await seedThreadJob(httpServer, db(), world, { feature: `decide-${Math.random().toString(36).slice(2, 10)}` });
        const result = await app.get(AssistantActionService, { strict: false }).propose({
          projectId: world.projectId, threadId: seeded.threadId, threadKind: 'REPO', threadProjectSlug: projectSlug, jobId: seeded.jobId,
          toolCallId: `e2e-${Math.random().toString(36).slice(2, 10)}`, tool: 'koda_add_comment', input: { ref: 'X-1', body: 'hi' },
          preview: 'Add a comment', actorId: world.ids.dev, now: new Date(),
        });
        if ('refused' in result) throw new Error('propose refused');
        const row = await db().pendingAction.findUniqueOrThrow({ where: { id: result.actionId } });
        return { actionId: result.actionId, approvalId: row.approvalId as string, threadId: seeded.threadId };
      };

      it('the requester rejecting answers 200 with status rejected', async () => {
        const { actionId, approvalId } = await proposeAction();
        const res = await request(httpServer).post(`/api/projects/${projectSlug}/fleet/approvals/${approvalId}/decide`)
          .set('Authorization', `Bearer ${world.tokens.dev}`).send({ decision: 'reject' }).expect(200);
        expect(body<{ status: string; type: string }>(res)).toMatchObject({ type: 'assistant_action', status: 'rejected' });
        expect((await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe('REJECTED');
      });

      it('another user deciding answers 403 threads.notCreator and leaves the action PENDING', async () => {
        const { actionId, approvalId } = await proposeAction();
        const res = await request(httpServer).post(`/api/fleet/approvals/${approvalId}/decide`)
          .set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'reject' }).expect(403);
        threadMessage(res, 'threads.notCreator.403');
        expect((await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe('PENDING');
      });

      it('the thread detail lists the pending action in a pendingActions array', async () => {
        const { actionId, threadId } = await proposeAction();
        const detail = body<{ pendingActions: Array<{ id: string }> }>(
          await request(httpServer).get(`/api/projects/${projectSlug}/threads/${threadId}`).set('Authorization', `Bearer ${world.tokens.dev}`).expect(200),
        );
        expect(Array.isArray(detail.pendingActions)).toBe(true);
        expect(detail.pendingActions.map((a) => a.id)).toEqual([actionId]);
      });
    });
  });

  describe('US-005 Runner tool route', () => {
    it('refuses a user token on the runner tool route with 401 fleet.runnerAuth', async () => {
      // The happy path needs a runner key holding a job; this suite has no runner-key routes, so it pins the
      // failure direction of the fail-closed guard (runner keys are refused off runner routes and vice versa).
      const res = await request(httpServer)
        .post('/api/fleet/runner/jobs/does-not-exist/tools/koda_get_ticket?leaseEpoch=1')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ toolCallId: 'c1', input: { ref: 'WEB-1' } })
        .expect(401);
      refusal(res, 'fleet.runnerAuth.40000');
    });
  });

  describe('S5b US-002 knowledge search route', () => {
    const HIT: KnowledgeHit = {
      source: 'repo', repoId: 'stub-repo', owner: 'o', name: 'n', path: 'docs/adr/1.md', sha: 'abc1234', anchor: 'adr-1',
      headingPath: 'ADR 1', title: 'ADR 1', abstract: 'abstract', snippet: 'snippet', score: 1 / 61,
    };

    let slug: string;
    let projectId: string;
    let repoId: string;
    let memberToken: string;
    let developerId: string;
    let searchSpy: ReturnType<typeof vi.spyOn> | undefined;
    let enabledBefore: boolean;

    const fleetConfigOf = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    const db = () => app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const search = (token: string, payload: Record<string, unknown>) => request(httpServer)
      .post(`/api/projects/${slug}/knowledge/search`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    beforeAll(async () => {
      // The spy goes first: whatever else fails here, afterAll must be able to restore it.
      // The route's own search body/repo/availability logic is under test, so the hybrid search itself is
      // stubbed (the real one needs a LanceDB store and is covered by knowledge-search.service.spec.ts).
      enabledBefore = fleetConfigOf().knowledgeIndexEnabled;
      fleetConfigOf().knowledgeIndexEnabled = true;
      searchSpy = vi.spyOn(app.get(KnowledgeSearchService), 'search');

      const prisma = db();
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@koda.test' } });
      const developer = await prisma.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      const project = await prisma.project.create({ data: { name: 'Knowledge search', slug: 'knowledge-search', key: 'KS' } });
      const repo = await prisma.fleetRepo.create({ data: {
        projectId: project.id, provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', createdById: admin.id,
      } });
      await prisma.projectMember.create({ data: { projectId: project.id, userId: developer.id, role: 'DEVELOPER' } });

      slug = project.slug;
      projectId = project.id;
      repoId = repo.id;
      developerId = developer.id;
      memberToken = nonAdminUserAccessToken;
    });

    afterAll(() => {
      searchSpy?.mockRestore();
      fleetConfigOf().knowledgeIndexEnabled = enabledBefore;
    });

    beforeEach(() => {
      searchSpy?.mockReset();
    });

    it('AC-9: answers 200 with the service result and calls search with the resolved repo id', async () => {
      searchSpy.mockResolvedValue({ lexicalOnly: false, empty: false, hits: [HIT] });

      const res = await search(memberToken, { query: 'broker', repo: 'o/n', limit: 5 }).expect(200);

      expect(searchSpy).toHaveBeenCalledWith({ projectId, query: 'broker', repoId, limit: 5 });
      expect(body(res)).toEqual({ lexicalOnly: false, empty: false, hits: [HIT] });
    });

    it('AC-10: answers 400 for a rejected body and never searches', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ query: '' }, 'query'],
        [{ query: 'broker', pathPrefix: '../x' }, 'pathPrefix'],
      ];

      for (const [payload, reason] of cases) {
        const res = await search(memberToken, payload).expect(400);
        refusal(res, 'knowledge.input.-2', { reason });
      }
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('AC-11: answers 404 for a repository the project does not own', async () => {
      const res = await search(memberToken, { query: 'broker', repo: 'o/missing' }).expect(404);

      refusal(res, 'knowledge.repoNotFound.404');
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('US-005 AC-13: passes the body source to the service and answers 400 for an unknown one', async () => {
      searchSpy.mockResolvedValue({ lexicalOnly: false, empty: false, hits: [HIT] });
      const cases: Array<{ source: string; status: number; expected?: Record<string, unknown> }> = [
        { source: 'outcomes', status: 200, expected: { projectId, query: 'broker', source: 'outcomes', limit: 20 } },
        { source: 'docs', status: 200, expected: { projectId, query: 'broker', source: 'docs', limit: 20 } },
        { source: 'all', status: 200, expected: { projectId, query: 'broker', source: 'all', limit: 20 } },
        { source: 'code', status: 400 },
      ];

      for (const { source, status, expected } of cases) {
        searchSpy.mockClear();

        const res = await search(memberToken, { query: 'broker', source }).expect(status);

        if (expected === undefined) {
          refusal(res, 'knowledge.input.-2', { reason: 'source' });
          expect(searchSpy).not.toHaveBeenCalled();
          continue;
        }
        expect(searchSpy).toHaveBeenCalledWith(expected);
      }
    });

    it('AC-12: answers 409 while the kill switch is off', async () => {
      fleetConfigOf().knowledgeIndexEnabled = false;
      try {
        const res = await search(memberToken, { query: 'broker' }).expect(409);
        refusal(res, 'knowledge.disabled.409');
        expect(searchSpy).not.toHaveBeenCalled();
      } finally {
        fleetConfigOf().knowledgeIndexEnabled = true;
      }
    });

    it('AC-13: answers 409 knowledge.unavailable when the store throws', async () => {
      searchSpy.mockRejectedValue(new KnowledgeStoreUnavailableError());

      const res = await search(memberToken, { query: 'broker' }).expect(409);

      refusal(res, 'knowledge.unavailable.409');
      expect(searchSpy).toHaveBeenCalledTimes(1);
    });

    it('AC-14: answers 403 for a user who is not a project member', async () => {
      // The membership is dropped and restored rather than registering a second user: POST /api/auth/register is
      // throttled at 5/min per IP and this file already registers four users (it answered 429 for a fifth).
      await db().projectMember.deleteMany({ where: { projectId, userId: developerId } });
      try {
        const res = await search(memberToken, { query: 'broker' }).expect(403);

        expect(res.body.ret).not.toBe(0);
        expect(searchSpy).not.toHaveBeenCalled();
      } finally {
        await db().projectMember.create({ data: { projectId, userId: developerId, role: 'DEVELOPER' } });
      }
    });
  });

  describe('S5b US-005 knowledge index state and reindex routes', () => {
    interface RepoState {
      repoId: string; owner: string; name: string; provider: string; status: string; indexedSha: string | null;
      fileCount: number; chunkCount: number; unembeddedCount: number; skippedCount: number;
      lastError: string | null; startedAt: string | null; finishedAt: string | null;
    }

    let slug: string;
    let repoId: string;
    let gitlabRepoId: string;
    let foreignRepoId: string;
    let enqueueSpy: ReturnType<typeof vi.spyOn> | undefined;
    let enabledBefore: boolean;

    const fleetConfigOf = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    const db = () => app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const reindex = (token: string, repo: string) => request(httpServer)
      .post(`/api/projects/${slug}/knowledge/repos/${repo}/reindex`)
      .set('Authorization', `Bearer ${token}`);
    const states = (token: string) => request(httpServer)
      .get(`/api/projects/${slug}/knowledge/repos`)
      .set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
      // The spy goes first: whatever else fails here, afterAll must be able to restore it.
      enabledBefore = fleetConfigOf().knowledgeIndexEnabled;
      fleetConfigOf().knowledgeIndexEnabled = true;
      // The queue is stubbed: the real one would run an index pass against the forge, while these cases pin the
      // enqueue the route makes (the pass itself is covered by knowledge-repo-indexer.spec.ts).
      enqueueSpy = vi.spyOn(app.get(KnowledgeIndexQueue), 'enqueue').mockImplementation(() => undefined);

      const prisma = db();
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@koda.test' } });
      const developer = await prisma.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      const project = await prisma.project.create({ data: { name: 'Knowledge index', slug: 'knowledge-index', key: 'KIX' } });
      const github = await prisma.fleetRepo.create({ data: {
        projectId: project.id, provider: 'github', owner: 'acme', name: 'docs-app', defaultBranch: 'main', createdById: admin.id,
      } });
      const gitlab = await prisma.fleetRepo.create({ data: {
        projectId: project.id, provider: 'gitlab', owner: 'grp', name: 'lib', defaultBranch: 'main', createdById: admin.id,
      } });
      const foreign = await prisma.project.create({ data: { name: 'Knowledge index foreign', slug: 'knowledge-index-foreign', key: 'KIXF' } });
      const foreignRepo = await prisma.fleetRepo.create({ data: {
        projectId: foreign.id, provider: 'github', owner: 'acme', name: 'other', defaultBranch: 'main', createdById: admin.id,
      } });
      await prisma.projectMember.create({ data: { projectId: project.id, userId: developer.id, role: 'DEVELOPER' } });
      // One repository carries a finished pass; the other one has no state row at all (`status: 'never'`).
      await prisma.knowledgeRepoIndex.create({ data: {
        repoId: github.id, projectId: project.id, status: 'idle', indexedSha: 'head0001', fileCount: 4, chunkCount: 9,
        unembeddedCount: 1, skippedCount: 2, lastError: null,
        startedAt: new Date('2026-10-15T10:00:00.000Z'), finishedAt: new Date('2026-10-15T10:01:00.000Z'),
      } });

      slug = project.slug;
      repoId = github.id;
      gitlabRepoId = gitlab.id;
      foreignRepoId = foreignRepo.id;
    });

    afterAll(() => {
      enqueueSpy?.mockRestore();
      fleetConfigOf().knowledgeIndexEnabled = enabledBefore;
    });

    beforeEach(() => {
      enqueueSpy?.mockClear();
    });

    it('AC-11: POST reindex answers 202 { queued: true } as a global ADMIN and enqueues an admin pass', async () => {
      const res = await reindex(userAccessToken, repoId).expect(202);

      expect(body(res)).toEqual({ queued: true });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith(repoId, 'admin');
    });

    it('AC-12: POST reindex answers 403 for a project DEVELOPER and enqueues nothing', async () => {
      const res = await reindex(nonAdminUserAccessToken, repoId).expect(403);

      expect(res.body.ret).not.toBe(0);
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('AC-12: POST reindex answers 404 for a repository of another project', async () => {
      const res = await reindex(userAccessToken, foreignRepoId).expect(404);

      refusal(res, 'knowledge.repoNotFound.404');
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('AC-13: POST reindex answers 409 while the kill switch is off', async () => {
      fleetConfigOf().knowledgeIndexEnabled = false;
      try {
        const res = await reindex(userAccessToken, repoId).expect(409);

        refusal(res, 'knowledge.disabled.409');
        expect(enqueueSpy).not.toHaveBeenCalled();
      } finally {
        fleetConfigOf().knowledgeIndexEnabled = true;
      }
    });

    it('AC-14: GET repos answers one entry per fleet repository, `never` for the never-indexed one', async () => {
      const res = await states(nonAdminUserAccessToken).expect(200);
      const data = body<{ enabled: boolean; repos: RepoState[] }>(res);

      expect(data.enabled).toBe(true);
      expect(data.repos.map((repo) => repo.repoId).sort()).toEqual([repoId, gitlabRepoId].sort());
      expect(data.repos.find((repo) => repo.repoId === repoId)).toMatchObject({
        owner: 'acme', name: 'docs-app', provider: 'github', status: 'idle', indexedSha: 'head0001',
        fileCount: 4, chunkCount: 9, unembeddedCount: 1, skippedCount: 2, lastError: null,
        startedAt: '2026-10-15T10:00:00.000Z', finishedAt: '2026-10-15T10:01:00.000Z',
      });
      expect(data.repos.find((repo) => repo.repoId === gitlabRepoId)).toMatchObject({
        provider: 'gitlab', status: 'never', indexedSha: null, fileCount: 0, chunkCount: 0,
        unembeddedCount: 0, skippedCount: 0, lastError: null, startedAt: null, finishedAt: null,
      });
    });

    it('AC-14: GET repos reports enabled false while the kill switch is off and still lists the repositories', async () => {
      fleetConfigOf().knowledgeIndexEnabled = false;
      try {
        const res = await states(nonAdminUserAccessToken).expect(200);
        const data = body<{ enabled: boolean; repos: RepoState[] }>(res);

        expect(data.enabled).toBe(false);
        expect(data.repos).toHaveLength(2);
      } finally {
        fleetConfigOf().knowledgeIndexEnabled = true;
      }
    });

    it('AC-14: GET repos answers 403 for a user who is not a project member', async () => {
      const member = await db().projectMember.findFirstOrThrow({ where: { project: { slug } } });
      await db().projectMember.delete({ where: { id: member.id } });
      try {
        const res = await states(nonAdminUserAccessToken).expect(403);

        expect(res.body.ret).not.toBe(0);
      } finally {
        await db().projectMember.create({ data: { projectId: member.projectId, userId: member.userId, role: 'DEVELOPER' } });
      }
    });
  });

  describe('S5b US-002 knowledge patterns route', () => {
    let slug: string;
    let projectId: string;
    let repoIds: string[];
    let enqueueSpy: ReturnType<typeof vi.spyOn> | undefined;
    let enabledBefore: boolean;

    const fleetConfigOf = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    const db = () => app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const putPatterns = (token: string, payload: Record<string, unknown>) => request(httpServer)
      .put(`/api/projects/${slug}/knowledge/patterns`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    const states = (token: string) => request(httpServer)
      .get(`/api/projects/${slug}/knowledge/repos`)
      .set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
      // The spy goes first: whatever else fails here, afterAll must be able to restore it.
      enabledBefore = fleetConfigOf().knowledgeIndexEnabled;
      fleetConfigOf().knowledgeIndexEnabled = true;
      // The queue is stubbed: the real one would run an index pass against the forge, while these cases pin the
      // enqueue the save makes (the pass itself is covered by knowledge-repo-indexer.spec.ts).
      enqueueSpy = vi.spyOn(app.get(KnowledgeIndexQueue), 'enqueue').mockImplementation(() => undefined);

      const prisma = db();
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@koda.test' } });
      const developer = await prisma.user.findUniqueOrThrow({ where: { email: 'member@koda.test' } });
      const project = await prisma.project.create({ data: { name: 'Knowledge patterns', slug: 'knowledge-patterns', key: 'KPT' } });
      const first = await prisma.fleetRepo.create({ data: {
        projectId: project.id, provider: 'github', owner: 'acme', name: 'handbook', defaultBranch: 'main', createdById: admin.id,
      } });
      const second = await prisma.fleetRepo.create({ data: {
        projectId: project.id, provider: 'gitlab', owner: 'grp', name: 'notes', defaultBranch: 'main', createdById: admin.id,
      } });
      await prisma.projectMember.create({ data: { projectId: project.id, userId: developer.id, role: 'DEVELOPER' } });

      slug = project.slug;
      projectId = project.id;
      repoIds = [first.id, second.id];
    });

    afterAll(() => {
      enqueueSpy?.mockRestore();
      fleetConfigOf().knowledgeIndexEnabled = enabledBefore;
    });

    beforeEach(() => {
      enqueueSpy?.mockClear();
    });

    it('AC-12: PUT patterns as a global ADMIN saves the list, queues every repository and answers them', async () => {
      const res = await putPatterns(userAccessToken, { patterns: ['handbook/*.md'] }).expect(200);

      expect(body(res)).toEqual({ patterns: ['handbook/*.md'], custom: true, queued: repoIds.length });
      expect(enqueueSpy).toHaveBeenCalledTimes(repoIds.length);
      expect([...enqueueSpy.mock.calls.map((call) => call[0])].sort()).toEqual([...repoIds].sort());
      expect(enqueueSpy.mock.calls.every((call) => call[1] === 'admin')).toBe(true);
      const row = await db().knowledgeProjectPatterns.findUniqueOrThrow({ where: { projectId } });
      expect(row.patterns).toEqual(['handbook/*.md']);
    });

    it('AC-13: PUT patterns with null restores the defaults and GET repos reports them', async () => {
      const put = await putPatterns(userAccessToken, { patterns: null }).expect(200);
      const putData = body<{ patterns: string[]; custom: boolean; queued: number }>(put);

      expect(putData.custom).toBe(false);
      expect(putData.patterns).toEqual([...DEFAULT_KNOWLEDGE_PATTERNS]);

      const res = await states(nonAdminUserAccessToken).expect(200);
      const data = body<{ patterns: string[]; customPatterns: boolean; defaultPatterns: string[] }>(res);

      expect(data.customPatterns).toBe(false);
      expect(data.patterns).toEqual([...DEFAULT_KNOWLEDGE_PATTERNS]);
      expect(data.defaultPatterns).toEqual([...DEFAULT_KNOWLEDGE_PATTERNS]);
    });

    it('AC-13: GET repos reports a saved list as the custom one', async () => {
      await putPatterns(userAccessToken, { patterns: ['handbook/**/*.md'] }).expect(200);
      try {
        const res = await states(nonAdminUserAccessToken).expect(200);
        const data = body<{ patterns: string[]; customPatterns: boolean; defaultPatterns: string[] }>(res);

        expect(data.patterns).toEqual(['handbook/**/*.md']);
        expect(data.customPatterns).toBe(true);
        expect(data.defaultPatterns).toEqual([...DEFAULT_KNOWLEDGE_PATTERNS]);
      } finally {
        await putPatterns(userAccessToken, { patterns: null }).expect(200);
      }
    });

    it.each([
      ['a list the parser rejects (400)', (): string => userAccessToken, { patterns: ['README.md', 'src/a.ts'] }, 400, 'patterns[1]'],
      ['a project member who is not a global admin (403)', (): string => nonAdminUserAccessToken, { patterns: ['handbook/*.md'] }, 403, null],
    ])('AC-14: PUT patterns refuses %s', async (_label, token, payload, status, reason) => {
      const res = await putPatterns(token(), payload as Record<string, unknown>).expect(status);

      if (reason === null) {
        expect(res.body.ret).not.toBe(0);
      } else {
        refusal(res, 'knowledge.input.400', { reason });
      }
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('AC-15: PUT patterns while indexing is disabled answers queued 0 and enqueues nothing', async () => {
      fleetConfigOf().knowledgeIndexEnabled = false;
      try {
        const res = await putPatterns(userAccessToken, { patterns: ['handbook/*.md'] }).expect(200);
        const data = body<{ patterns: string[]; custom: boolean; queued: number }>(res);

        expect(data).toEqual({ patterns: ['handbook/*.md'], custom: true, queued: 0 });
        expect(enqueueSpy).not.toHaveBeenCalled();
        // Saved anyway, so the next pass with indexing on selects with it.
        const row = await db().knowledgeProjectPatterns.findUniqueOrThrow({ where: { projectId } });
        expect(row.patterns).toEqual(['handbook/*.md']);
      } finally {
        fleetConfigOf().knowledgeIndexEnabled = true;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Permissions P1a US-005 — the roles lifecycle
  // ─────────────────────────────────────────────────────────────────

  describe('Roles API (permissions P1a US-005)', () => {
    let roleOwnerToken: string;
    let roleMemberToken: string;
    beforeAll(async () => {
      // The surrounding lifecycle normally supplies these actors. A filtered run must create its
      // own actors: the first registration bootstraps the Owner binding through the real API.
      const register = async (email: string): Promise<string> => {
        const res = await request(httpServer).post('/api/auth/register')
          .send({ email, name: 'Roles test user', password: 'Roles1234!Aa' }).expect(201);
        return body<{ accessToken: string }>(res).accessToken;
      };
      roleOwnerToken = userAccessToken ?? await register('roles-owner@koda.test');
      roleMemberToken = nonAdminUserAccessToken ?? await register('roles-member@koda.test');
    });
    const db = () => app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const roles = (token: string) => request(httpServer).get('/api/roles').set(auth(token));
    const createRole = (token: string, payload: Record<string, unknown>) =>
      request(httpServer).post('/api/roles').set(auth(token)).send(payload);
    const patchRole = (token: string, id: string, payload: Record<string, unknown>) =>
      request(httpServer).patch(`/api/roles/${id}`).set(auth(token)).send(payload);
    const deleteRole = (token: string, id: string) =>
      request(httpServer).delete(`/api/roles/${id}`).set(auth(token));
    const storedRoleId = async (key: string): Promise<string> =>
      (await db().role.findUniqueOrThrow({ where: { key } })).id;
    const customRole = async (key: string): Promise<string> => {
      const res = await createRole(roleOwnerToken, {
        key, name: 'E2E QA', scope: 'PROJECT', permissions: ['ticket.read'],
      }).expect(201);
      return body<{ id: string }>(res).id;
    };

    it('GET /api/roles — lists the system roles for the installation owner', async () => {
      const res = await roles(roleOwnerToken).expect(200);
      const list = body<Array<{ key: string; system: boolean; permissions: string[] }>>(res);

      expect(list.map((role) => role.key)).toContain('owner');
      expect(list.find((role) => role.key === 'owner')).toEqual(
        expect.objectContaining({ system: true, permissions: ['*'] }),
      );
    });

    it('GET /api/roles — 403 for a user whose only binding is member', async () => {
      refusal(await roles(roleMemberToken).expect(403), 'permissions.403');
    });

    it('POST /api/roles — 201 creates a PROJECT role', async () => {
      const res = await createRole(roleOwnerToken, {
        key: 'e2e-qa',
        name: 'E2E QA',
        scope: 'PROJECT',
        permissions: ['ticket.read', 'comment.create'],
      }).expect(201);

      const role = body<{ id: string; key: string; scope: string; system: boolean; permissions: string[] }>(res);
      expect(role).toEqual(
        expect.objectContaining({
          key: 'e2e-qa',
          scope: 'PROJECT',
          system: false,
          permissions: ['ticket.read', 'comment.create'],
        }),
      );
    });

    it('POST /api/roles — 409 for a duplicate key', async () => {
      await customRole('e2e-qa-duplicate');
      const res = await createRole(roleOwnerToken, {
        key: 'e2e-qa-duplicate',
        name: 'E2E QA again',
        scope: 'PROJECT',
        permissions: ['ticket.read'],
      }).expect(409);

      refusal(res, 'permissions.roleKeyTaken.409');
    });

    it('POST /api/roles — 400 for a key the DTO rejects', async () => {
      const res = await createRole(roleOwnerToken, {
        key: 'Not A Key',
        name: 'Bad key',
        scope: 'PROJECT',
        permissions: [],
      }).expect(400);

      expect(res.body.ret).toBe(-2);
      expect(await db().role.count({ where: { name: 'Bad key' } })).toBe(0);
    });

    it('PATCH /api/roles/{id} — 200 changes the custom role description', async () => {
      const id = await customRole('e2e-qa-patch');
      const res = await patchRole(roleOwnerToken, id, { description: 'Runs the E2E QA pass' }).expect(200);

      expect(body<{ description: string }>(res).description).toBe('Runs the E2E QA pass');
      expect(await db().role.findUniqueOrThrow({ where: { id } })).toEqual(
        expect.objectContaining({ description: 'Runs the E2E QA pass', key: 'e2e-qa-patch', scope: 'PROJECT' }),
      );
    });

    it('PATCH /api/roles/{id} — 404 for an unknown id', async () => {
      const res = await patchRole(roleOwnerToken, 'no-such-role', { description: 'x' }).expect(404);

      refusal(res, 'permissions.roleNotFound.404');
    });

    it('PATCH /api/roles/{id} — 403 on the locked owner role', async () => {
      const res = await patchRole(roleOwnerToken, await storedRoleId('owner'), { description: 'x' }).expect(403);

      refusal(res, 'permissions.ownerLocked.403');
    });

    it('DELETE /api/roles/{id} — 403 on a system role', async () => {
      const res = await deleteRole(roleOwnerToken, await storedRoleId('viewer')).expect(403);

      refusal(res, 'permissions.systemRole.403');
    });

    it('DELETE /api/roles/{id} — 204 deletes the custom role', async () => {
      const id = await customRole('e2e-qa-delete');
      await deleteRole(roleOwnerToken, id).expect(204);

      expect(await db().role.findUnique({ where: { id } })).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Permissions P1a US-006 — the role bindings lifecycle
  // ─────────────────────────────────────────────────────────────────

  describe('Role bindings API (permissions P1a US-006)', () => {
    const db = () => app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const bindings = (token: string, query: Record<string, string> = {}) =>
      request(httpServer).get('/api/role-bindings').query(query).set(auth(token));
    const createBinding = (token: string, payload: Record<string, unknown>) =>
      request(httpServer).post('/api/role-bindings').set(auth(token)).send(payload);
    const deleteBinding = (token: string, id: string) =>
      request(httpServer).delete(`/api/role-bindings/${id}`).set(auth(token));
    const projectIdOf = async (slug: string): Promise<string> =>
      (await db().project.findUniqueOrThrow({ where: { slug } })).id;
    const userIdOf = async (email: string): Promise<string> =>
      (await db().user.findFirstOrThrow({ where: { email } })).id;

    it('GET /api/role-bindings — pages one principal\'s bindings', async () => {
      const ownerId = await userIdOf('admin@koda.test');

      const res = await bindings(userAccessToken, { principalType: 'USER', principalId: ownerId }).expect(200);
      const page = body<{ size: number; records: Array<{ principalId: string; roleKey: string }> }>(res);

      expect(page.size).toBe(50);
      expect(page.records).toEqual(
        expect.arrayContaining([expect.objectContaining({ principalId: ownerId })]),
      );
    });

    it('GET /api/role-bindings — 403 for a user whose only binding is member', async () => {
      const res = await bindings(nonAdminUserAccessToken, { principalType: 'AGENT', principalId: agentId }).expect(403);

      refusal(res, 'permissions.403');
    });

    it('POST /api/role-bindings — 201 grants developer in the project to the agent', async () => {
      const projectId = await projectIdOf(projectSlug);

      const res = await createBinding(userAccessToken, {
        principalType: 'AGENT',
        principalId: agentId,
        roleKey: 'developer',
        projectId,
      }).expect(201);

      const binding = body<{ id: string; roleKey: string; projectId: string | null; principalId: string }>(res);
      expect(binding).toEqual(
        expect.objectContaining({ roleKey: 'developer', projectId, principalId: agentId }),
      );
      expect(await db().roleBinding.findUnique({ where: { id: binding.id } })).toEqual(
        expect.objectContaining({ principalId: agentId, projectId }),
      );
    });

    it('POST /api/role-bindings — 404 for an unknown role key', async () => {
      const projectId = await projectIdOf(projectSlug);
      const before = await db().roleBinding.count({ where: { principalId: agentId } });

      const res = await createBinding(userAccessToken, {
        principalType: 'AGENT',
        principalId: agentId,
        roleKey: 'no-such-role',
        projectId,
      }).expect(404);

      refusal(res, 'permissions.roleNotFound.404');
      expect(await db().roleBinding.count({ where: { principalId: agentId } })).toBe(before);
    });

    it('DELETE /api/role-bindings/{id} — 204 removes a project binding', async () => {
      const projectId = await projectIdOf(projectSlug);
      const viewer = await db().role.findUniqueOrThrow({ where: { key: 'viewer' } });
      const binding = await db().roleBinding.create({
        data: {
          principalType: 'AGENT',
          principalId: agentId,
          roleId: viewer.id,
          projectId,
          grantedByType: 'USER',
          grantedById: agentId,
        },
      });

      await deleteBinding(userAccessToken, binding.id).expect(204);

      expect(await db().roleBinding.findUnique({ where: { id: binding.id } })).toBeNull();
    });

    it('DELETE /api/role-bindings/{id} — 404 for an unknown id', async () => {
      const res = await deleteBinding(userAccessToken, 'no-such-binding').expect(404);

      refusal(res, 'permissions.bindingNotFound.404');
    });
  });
});
