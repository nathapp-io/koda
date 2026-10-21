import type { Mock } from 'vitest';
/**
 * US-001 — ProjectMembershipGuard applied to the project-scoped routes.
 *
 * Boots a real Fastify HTTP server (mocked providers, no database) so the guard
 * runs inside Nest's real guard chain, in the same order the production app uses
 * (global guards run before controller/route guards). The principal is injected by
 * a global test guard that stands in for CombinedAuthGuard, so `@Principal()` and
 * the membership guard read the same `request.user` they read in production.
 */
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Page } from '@nathapp/nestjs-common';
import request from 'supertest';
import { TicketsController } from '../tickets/tickets.controller';
import { TicketsService } from '../tickets/tickets.service';
import { TicketTransitionsService } from '../tickets/state-machine/ticket-transitions.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectAccessService, PROJECT_ACCESS_KEY } from './project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { RagController } from '../rag/rag.controller';
import { RagService } from '../rag/rag.service';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';
import { PrismaRagRepository } from '../rag/prisma-rag.repository';
import { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

interface MembershipRepoStub {
  findBySlug: Mock;
  findMembershipRole: Mock;
  isAgentOnRoster: Mock;
}

interface TicketsServiceStub {
  create: Mock;
  findAll: Mock;
  findByRef: Mock;
  findByRefWithActions: Mock;
  update: Mock;
  softDelete: Mock;
  assign: Mock;
}

interface TransitionsServiceStub {
  verify: Mock;
  start: Mock;
  fix: Mock;
  verifyFix: Mock;
  close: Mock;
  reject: Mock;
}

interface ProjectsServiceStub {
  findBySlug: Mock;
  findProjectIdBySlug: Mock;
  assertProjectMembership: Mock;
}

interface RagServiceStub {
  indexDocument: Mock;
  listDocuments: Mock;
  deleteBySource: Mock;
  findSourceCreators: Mock;
  importGraphify: Mock;
  optimizeTable: Mock;
}

interface HybridRetrieverStub {
  indexDocument: Mock;
  search: Mock;
}

interface RagRepositoryStub {
  findProjectBySlug: Mock;
  findProjectMembership: Mock;
}

/** A user principal with no global ADMIN role: only ProjectMember rows grant access. */
function makeUserPrincipal(id: string): UserPrincipal {
  return {
    actorType: 'user',
    id,
    name: `${id}@koda.dev`,
    email: `${id}@koda.dev`,
    role: 'MEMBER',
    blacklisted: false,
    revoked: false,
    authorities: ['MEMBER'],
    extra: {},
  };
}

describe('ProjectMembershipGuard on the project-scoped routes (US-001)', () => {
  let app: NestFastifyApplication;
  let testingModule: TestingModule;

  let currentPrincipal: KodaPrincipal;

  let membershipRepo: MembershipRepoStub;
  let ticketsService: TicketsServiceStub;
  let transitionsService: TransitionsServiceStub;
  let projectsService: ProjectsServiceStub;
  let ragService: RagServiceStub;
  let hybridRetriever: HybridRetrieverStub;
  let ragRepository: RagRepositoryStub;

  const developerUser = makeUserPrincipal('user-dev');
  const adminUser: UserPrincipal = {
    ...makeUserPrincipal('user-admin'),
    role: 'ADMIN',
    authorities: ['ADMIN'],
  };

  /** The catalog keys the stub refuses; each case marks the ones its role does not hold (US-007). */
  let refusedKeys: ReadonlySet<string>;
  /**
   * US-001: project access is `project.read`. `refusedKeys` holding it models a caller with no access
   * to the project (403 `projects` from the guard); otherwise the project ask is granted and the
   * display role still comes from the fake membership row. The global ask is what a global
   * Owner/Admin holds — the legacy `User.role = 'ADMIN'` claim is exactly that.
   */
  const can = vi.fn(async (principal: KodaPrincipal, key: string, ctx?: { projectId?: string }) => {
    if (key !== PROJECT_ACCESS_KEY) {
      return refusedKeys.has(key)
        ? { allowed: false, reason: 'not-granted' }
        : { allowed: true, reason: 'granted' };
    }
    if (refusedKeys.has(key)) return { allowed: false, reason: 'not-granted' };
    if (ctx?.projectId === undefined) {
      return principal.actorType === 'user' && principal.role === 'ADMIN'
        ? { allowed: true, reason: 'granted' }
        : { allowed: false, reason: 'not-granted' };
    }
    return { allowed: true, reason: 'granted' };
  });

  beforeAll(async () => {
    membershipRepo = { findBySlug: vi.fn(), findMembershipRole: vi.fn(), isAgentOnRoster: vi.fn() };

    ticketsService = {
      create: vi.fn(),
      findAll: vi.fn(),
      findByRef: vi.fn(),
      findByRefWithActions: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      assign: vi.fn(),
    };
    transitionsService = {
      verify: vi.fn(),
      start: vi.fn(),
      fix: vi.fn(),
      verifyFix: vi.fn(),
      close: vi.fn(),
      reject: vi.fn(),
    };
    projectsService = {
      findBySlug: vi.fn(),
      findProjectIdBySlug: vi.fn(),
      assertProjectMembership: vi.fn(),
    };
    ragService = {
      indexDocument: vi.fn(),
      listDocuments: vi.fn(),
      deleteBySource: vi.fn(),
      findSourceCreators: vi.fn().mockResolvedValue([]),
      importGraphify: vi.fn(),
      optimizeTable: vi.fn(),
    };
    hybridRetriever = { indexDocument: vi.fn(), search: vi.fn() };
    ragRepository = { findProjectBySlug: vi.fn(), findProjectMembership: vi.fn() };

    // The real access service over stubbed collaborators: admission comes from the
    // `project.read` answers above, and the fake membership rows supply the display role.
    const accessService = new ProjectAccessService(
      membershipRepo as unknown as PrismaProjectRepository,
      { can } as unknown as PermissionService,
    );

    testingModule = await Test.createTestingModule({
      controllers: [TicketsController, ProjectsController, RagController],
      providers: [
        { provide: TicketsService, useValue: ticketsService },
        { provide: TicketTransitionsService, useValue: transitionsService },
        { provide: ProjectsService, useValue: projectsService },
        { provide: ImpactAnalysisService, useValue: {} },
        { provide: AgentsService, useValue: {} },
        { provide: RagService, useValue: ragService },
        { provide: HybridRetrieverService, useValue: hybridRetriever },
        { provide: PrismaRagRepository, useValue: ragRepository },
        { provide: ProjectAccessService, useValue: accessService },
        // US-003: PATCH :ref and the six transition routes carry RequiresGuard, which Nest instantiates
        // with the controller even though none of these cases calls a migrated route. The key checks
        // themselves are covered by src/tickets/tickets.controller.spec.ts and
        // test/integration/permissions/core-ticket-transitions.integration.spec.ts.
        // US-007: the KB routes carry keys too. Their key table is covered over real HTTP by
        // test/integration/rag/permissions-kb-routes.integration.spec.ts, so the stub allows every key except
        // the ones a case marks as refused (`refusedKeys`).
        { provide: PermissionService, useValue: { can } },
        // Permissions P1 US-004: the membership guard builds no ability; it resolves the project identity only.
      ],
    }).compile();

    app = testingModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    // Stands in for the global CombinedAuthGuard registered in main.ts: it runs
    // before controller/route guards and is what puts the principal on the request.
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = currentPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    currentPrincipal = developerUser;
    refusedKeys = new Set();

    // `alpha` is an active project; the caller is a DEVELOPER member by default.
    membershipRepo.findBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: null });
    membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');

    ticketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
    ticketsService.assign.mockResolvedValue({ id: 'ticket-1', ref: 'KODA-1' });

    projectsService.findBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', name: 'Alpha' });
    projectsService.findProjectIdBySlug.mockResolvedValue('proj-1');
    projectsService.assertProjectMembership.mockResolvedValue(undefined);

    ragRepository.findProjectBySlug.mockResolvedValue({
      id: 'proj-1',
      slug: 'alpha',
      graphifyEnabled: false,
      deletedAt: null,
    });
    ragRepository.findProjectMembership.mockResolvedValue({ role: 'DEVELOPER' });
    ragService.indexDocument.mockResolvedValue('doc-id');
    hybridRetriever.search.mockResolvedValue({
      results: [],
      scores: [],
      retrievedAt: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // AC7 / AC8 — ticket routes
  // ---------------------------------------------------------------------------

  it('AC7: GET /api/projects/:slug/tickets returns 403 for a caller without project.read', async () => {
    // US-001: access is the key, so a caller with no source in the project is refused here.
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    const res = await request(app.getHttpServer()).get('/api/projects/alpha/tickets');

    expect(res.status).toBe(403);
    expect(ticketsService.findAll).not.toHaveBeenCalled();
    expect(can).toHaveBeenCalledWith(developerUser, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
  });

  it('AC7 boundary: GET /api/projects/:slug/tickets returns 200 for a member DEVELOPER user', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects/alpha/tickets');

    expect(res.status).toBe(200);
    // The route is guarded: a member is admitted only after the guard resolved the slug.
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC8: POST /api/projects/:slug/tickets/:ref/assign returns 403 for a caller without project.read', async () => {
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/tickets/KODA-1/assign')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(403);
    expect(ticketsService.assign).not.toHaveBeenCalled();
  });

  it('AC8 boundary: POST /api/projects/:slug/tickets/:ref/assign returns 200 for a member DEVELOPER user', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/tickets/KODA-1/assign')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC8 boundary: an agent principal holding project.read is admitted to POST :ref/assign with no membership row', async () => {
    // #144: assign requires UPDATE Ticket; TRIAGER agents have it (DEVELOPER
    // agents only get TRANSITION). This test is about membership semantics, so
    // the agent carries a role that passes the permission check.
    currentPrincipal = {
      actorType: 'agent',
      id: 'agent-1',
      name: 'bot',
      slug: 'bot',
      status: 'ACTIVE',
      agentRoles: ['TRIAGER'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: ['WORKER'],
    };
    // US-001: the agent reaches the project through `project.read`, not a roster row.
    membershipRepo.isAgentOnRoster.mockResolvedValue(false);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/tickets/KODA-1/assign')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(can).toHaveBeenCalledWith(currentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
    expect(membershipRepo.isAgentOnRoster).not.toHaveBeenCalled();
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
    // The route is guarded: the slug is still resolved before the handler runs.
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC5 (S4c US-001): POST :ref/assign returns 403 for an agent without project.read', async () => {
    // #144: an agent whose roles would otherwise pass the permission check, so
    // the only reason for the refusal is the missing project access.
    currentPrincipal = {
      actorType: 'agent',
      id: 'agent-1',
      name: 'bot',
      slug: 'bot',
      status: 'ACTIVE',
      agentRoles: ['TRIAGER'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: ['WORKER'],
    };
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);
    membershipRepo.isAgentOnRoster.mockResolvedValue(true);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/tickets/KODA-1/assign')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(403);
    expect(can).toHaveBeenCalledWith(currentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
    expect(ticketsService.assign).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC10 / AC11 — GET /api/projects/:slug
  // ---------------------------------------------------------------------------

  it('AC10: GET /api/projects/:slug returns 403 for a caller without project.read', async () => {
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    const res = await request(app.getHttpServer()).get('/api/projects/alpha');

    expect(res.status).toBe(403);
    expect(projectsService.findBySlug).not.toHaveBeenCalled();
  });

  it('AC11: GET /api/projects/:slug returns 200 for a member DEVELOPER user', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects/alpha');

    expect(res.status).toBe(200);
    // The route is guarded: a member is admitted only after the guard resolved the slug.
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC4: a global ADMIN user reads GET /api/projects/:slug with no membership row', async () => {
    currentPrincipal = adminUser;
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    const res = await request(app.getHttpServer()).get('/api/projects/alpha');

    expect(res.status).toBe(200);
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
    // The route is guarded: the slug is still resolved before the handler runs.
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  // ---------------------------------------------------------------------------
  // AC12 / AC13 / AC14 — knowledge base routes
  // ---------------------------------------------------------------------------

  it('AC12: POST /api/projects/:slug/kb/documents returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
    // US-007: a Viewer holds only `*.read`, so `kb.document.add` is refused by the key check.
    refusedKeys = new Set(['kb.document.add']);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(403);
    expect(ragService.indexDocument).not.toHaveBeenCalled();
  });

  it('AC13: POST /api/projects/:slug/kb/documents returns a 2xx status for a member whose project role is DEVELOPER', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC12 boundary: POST /api/projects/:slug/kb/documents returns 403 for a caller without project.read', async () => {
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(403);
    expect(ragService.indexDocument).not.toHaveBeenCalled();
  });

  it('AC12 boundary: DELETE /api/projects/:slug/kb/documents/:sourceId returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
    refusedKeys = new Set(['kb.document.delete']);

    const res = await request(app.getHttpServer()).delete(
      '/api/projects/alpha/kb/documents/doc-1',
    );

    expect(res.status).toBe(403);
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('AC12 boundary: POST /api/projects/:slug/kb/import/graphify returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
    refusedKeys = new Set(['kb.graphify.import']);
    ragRepository.findProjectBySlug.mockResolvedValue({
      id: 'proj-1',
      slug: 'alpha',
      graphifyEnabled: true,
      deletedAt: null,
    });

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/import/graphify')
      .send({ nodes: [{ id: 'n1', label: 'Foo' }], links: [] });

    expect(res.status).toBe(403);
    expect(ragService.importGraphify).not.toHaveBeenCalled();
  });

  it('AC12 boundary: POST /api/projects/:slug/kb/optimize returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
    refusedKeys = new Set(['kb.optimize']);

    const res = await request(app.getHttpServer()).post('/api/projects/alpha/kb/optimize');

    expect(res.status).toBe(403);
    expect(ragService.optimizeTable).not.toHaveBeenCalled();
  });

  it('AC14: POST /api/projects/:slug/kb/search returns 200 for a member whose project role is DEVELOPER', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/search')
      .send({ query: 'auth bug' });

    expect(res.status).toBe(200);
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  // US-007: `kb.search` is a write-ish key a Viewer's `*.read` grant does not reach; it is refused by the guard.
  it('US-007: POST /api/projects/:slug/kb/search returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
    refusedKeys = new Set(['kb.search']);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/search')
      .send({ query: 'auth bug' });

    expect(res.status).toBe(403);
    expect(hybridRetriever.search).not.toHaveBeenCalled();
  });

  it('AC14 boundary: POST /api/projects/:slug/kb/search returns 403 for a caller without project.read', async () => {
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/search')
      .send({ query: 'auth bug' });

    expect(res.status).toBe(403);
    expect(hybridRetriever.search).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC17 — unknown or soft-deleted slug on a guarded route
  // ---------------------------------------------------------------------------

  it('AC17: a guarded route returns 404 when params.slug names an unknown project', async () => {
    membershipRepo.findBySlug.mockResolvedValue(null);

    const res = await request(app.getHttpServer()).get('/api/projects/no-such-project/tickets');

    expect(res.status).toBe(404);
    expect(ticketsService.findAll).not.toHaveBeenCalled();
  });

  it('AC17: a guarded route returns 404 when params.slug names a soft-deleted project', async () => {
    membershipRepo.findBySlug.mockResolvedValue({
      id: 'proj-1',
      slug: 'alpha',
      deletedAt: new Date(),
    });

    const res = await request(app.getHttpServer()).get('/api/projects/alpha');

    expect(res.status).toBe(404);
    expect(projectsService.findBySlug).not.toHaveBeenCalled();
  });

  it('AC17: the KB routes return 404 for a soft-deleted project', async () => {
    membershipRepo.findBySlug.mockResolvedValue({
      id: 'proj-1',
      slug: 'alpha',
      deletedAt: new Date(),
    });

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/search')
      .send({ query: 'auth bug' });

    expect(res.status).toBe(404);
    expect(hybridRetriever.search).not.toHaveBeenCalled();
  });
});
