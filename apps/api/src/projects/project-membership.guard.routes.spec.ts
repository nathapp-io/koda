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
import { ProjectAccessService } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { RagController } from '../rag/rag.controller';
import { RagService } from '../rag/rag.service';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';
import { PrismaRagRepository } from '../rag/prisma-rag.repository';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
import { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

interface MembershipRepoStub {
  findBySlug: jest.Mock;
  findMembershipRole: jest.Mock;
  isAgentOnRoster: jest.Mock;
}

interface TicketsServiceStub {
  create: jest.Mock;
  findAll: jest.Mock;
  findByRef: jest.Mock;
  findByRefWithActions: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
  assign: jest.Mock;
}

interface TransitionsServiceStub {
  verify: jest.Mock;
  start: jest.Mock;
  fix: jest.Mock;
  verifyFix: jest.Mock;
  close: jest.Mock;
  reject: jest.Mock;
}

interface ProjectsServiceStub {
  findBySlug: jest.Mock;
  findProjectIdBySlug: jest.Mock;
  assertProjectMembership: jest.Mock;
}

interface RagServiceStub {
  indexDocument: jest.Mock;
  listDocuments: jest.Mock;
  deleteBySource: jest.Mock;
  importGraphify: jest.Mock;
  optimizeTable: jest.Mock;
}

interface HybridRetrieverStub {
  indexDocument: jest.Mock;
  search: jest.Mock;
}

interface RagRepositoryStub {
  findProjectBySlug: jest.Mock;
  findProjectMembership: jest.Mock;
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

  beforeAll(async () => {
    membershipRepo = { findBySlug: jest.fn(), findMembershipRole: jest.fn(), isAgentOnRoster: jest.fn() };

    ticketsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findByRef: jest.fn(),
      findByRefWithActions: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      assign: jest.fn(),
    };
    transitionsService = {
      verify: jest.fn(),
      start: jest.fn(),
      fix: jest.fn(),
      verifyFix: jest.fn(),
      close: jest.fn(),
      reject: jest.fn(),
    };
    projectsService = {
      findBySlug: jest.fn(),
      findProjectIdBySlug: jest.fn(),
      assertProjectMembership: jest.fn(),
    };
    ragService = {
      indexDocument: jest.fn(),
      listDocuments: jest.fn(),
      deleteBySource: jest.fn(),
      importGraphify: jest.fn(),
      optimizeTable: jest.fn(),
    };
    hybridRetriever = { indexDocument: jest.fn(), search: jest.fn() };
    ragRepository = { findProjectBySlug: jest.fn(), findProjectMembership: jest.fn() };

    // The real access service over a stubbed repository: the guard's membership
    // decisions are driven by the fake ProjectMember rows below.
    const accessService = new ProjectAccessService(
      membershipRepo as unknown as PrismaProjectRepository,
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
        // #144: the guard's @ProjectPermission check builds an ability from this
        // factory; without it the check fails closed with 403.
        KodaCaslAbilityFactory,
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
    jest.clearAllMocks();

    currentPrincipal = developerUser;

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

  it('AC7: GET /api/projects/:slug/tickets returns 403 for a non-member DEVELOPER user', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    const res = await request(app.getHttpServer()).get('/api/projects/alpha/tickets');

    expect(res.status).toBe(403);
    expect(ticketsService.findAll).not.toHaveBeenCalled();
  });

  it('AC7 boundary: GET /api/projects/:slug/tickets returns 200 for a member DEVELOPER user', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects/alpha/tickets');

    expect(res.status).toBe(200);
    // The route is guarded: a member is admitted only after the guard resolved the slug.
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC8: POST /api/projects/:slug/tickets/:ref/assign returns 403 for a non-member DEVELOPER user', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue(null);

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

  it('AC8 boundary: a rostered agent principal is admitted to POST :ref/assign with no membership row', async () => {
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
    membershipRepo.findMembershipRole.mockResolvedValue(null);
    // S4c US-001: the agent reaches the project through its AgentProject row.
    membershipRepo.isAgentOnRoster.mockResolvedValue(true);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/tickets/KODA-1/assign')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(200);
    expect(membershipRepo.isAgentOnRoster).toHaveBeenCalledWith('proj-1', 'agent-1');
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
    // The route is guarded: the slug is still resolved before the handler runs.
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC5 (S4c US-001): POST :ref/assign returns 403 for an agent absent from the project roster', async () => {
    // #144: an agent whose roles would otherwise pass the permission check, so
    // the only reason for the refusal is the missing AgentProject row.
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
    membershipRepo.isAgentOnRoster.mockResolvedValue(false);
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/tickets/KODA-1/assign')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(403);
    expect(membershipRepo.isAgentOnRoster).toHaveBeenCalledWith('proj-1', 'agent-1');
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
    expect(ticketsService.assign).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC10 / AC11 — GET /api/projects/:slug
  // ---------------------------------------------------------------------------

  it('AC10: GET /api/projects/:slug returns 403 for a non-member DEVELOPER user', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue(null);

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

  it('AC12 boundary: POST /api/projects/:slug/kb/documents returns 403 for a non-member DEVELOPER user', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(403);
    expect(ragService.indexDocument).not.toHaveBeenCalled();
  });

  it('AC12 boundary: DELETE /api/projects/:slug/kb/documents/:sourceId returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');

    const res = await request(app.getHttpServer()).delete(
      '/api/projects/alpha/kb/documents/doc-1',
    );

    expect(res.status).toBe(403);
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('AC12 boundary: POST /api/projects/:slug/kb/import/graphify returns 403 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
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

    const res = await request(app.getHttpServer()).post('/api/projects/alpha/kb/optimize');

    expect(res.status).toBe(403);
    expect(ragService.optimizeTable).not.toHaveBeenCalled();
  });

  it('AC14: POST /api/projects/:slug/kb/search returns 200 for a member whose project role is VIEWER', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/search')
      .send({ query: 'auth bug' });

    expect(res.status).toBe(200);
    expect(membershipRepo.findBySlug).toHaveBeenCalledWith('alpha');
  });

  it('AC14 boundary: POST /api/projects/:slug/kb/search returns 403 for a non-member DEVELOPER user', async () => {
    membershipRepo.findMembershipRole.mockResolvedValue(null);

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
