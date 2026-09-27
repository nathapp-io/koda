/**
 * US-005 — AC2: `@UseGuards(ProjectMembershipGuard)` on RetrievalController.
 *
 * Boots a real Fastify HTTP server (mocked providers, no database, no network)
 * so the guard runs inside Nest's real guard chain, in production order (global
 * guards, then controller guards, then the handler). The principal is injected
 * by a global test guard that stands in for CombinedAuthGuard, so `@Principal()`
 * and ProjectMembershipGuard read the same `request.user`.
 *
 * Before this story the controller carried a private `checkProjectMembership`
 * copy of the membership rule. After it, ProjectMembershipGuard is the only
 * place the membership rule is evaluated for this route.
 */
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { RetrievalController } from './retrieval.controller';
import { EvaluationService } from './evaluation.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

interface ProjectRepositoryStub {
  findBySlug: jest.Mock;
  findMembershipRole: jest.Mock;
}

interface EvaluationServiceStub {
  runQueries: jest.Mock;
}

function makeUserPrincipal(id: string, role: 'ADMIN' | 'MEMBER'): UserPrincipal {
  return {
    actorType: 'user',
    id,
    name: `${id}@koda.dev`,
    email: `${id}@koda.dev`,
    role,
    blacklisted: false,
    revoked: false,
    authorities: [role],
    extra: {},
  };
}

describe('RetrievalController membership gate (US-005 AC2)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;

  let currentPrincipal: KodaPrincipal;

  let projectRepo: ProjectRepositoryStub;
  let evaluationService: EvaluationServiceStub;

  // Records every execution of the real guard: the only way to observe, from
  // the outside, that ProjectMembershipGuard sits in this route's guard chain.
  const guardCanActivate = jest.spyOn(ProjectMembershipGuard.prototype, 'canActivate');

  const developerUser = makeUserPrincipal('user-dev', 'MEMBER');

  beforeAll(async () => {
    projectRepo = { findBySlug: jest.fn(), findMembershipRole: jest.fn() };
    evaluationService = { runQueries: jest.fn() };

    testingModule = await Test.createTestingModule({
      controllers: [RetrievalController],
      providers: [
        { provide: EvaluationService, useValue: evaluationService },
        // The real access service over a stubbed repository: the guard's
        // membership decision is driven by the fake ProjectMember rows below.
        ProjectAccessService,
        { provide: PrismaProjectRepository, useValue: projectRepo },
        // Register the guard so NestJS applies it to the controller's
        // @UseGuards(ProjectMembershipGuard) class-level decorator.
        ProjectMembershipGuard,
      ],
    }).compile();

    app = testingModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    // Stands in for the global CombinedAuthGuard: it runs before controller
    // guards and is what puts the principal on the request.
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
    guardCanActivate.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    currentPrincipal = developerUser;

    // `alpha` is an active project and the caller is a DEVELOPER member.
    projectRepo.findBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: null });
    projectRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
    evaluationService.runQueries.mockResolvedValue({
      precisionAt5_avg: 1,
      precisionAt5_p50: 1,
      precisionAt5_p95: 1,
      totalQueries: 0,
      results: [],
    });
  });

  it('AC2: POST /api/projects/:slug/kb/evaluate/retrieval returns 403 for a non-member DEVELOPER user', async () => {
    projectRepo.findMembershipRole.mockResolvedValue(null);

    const res = await request(app.getHttpServer()).post(
      '/api/projects/alpha/kb/evaluate/retrieval',
    );

    expect(res.status).toBe(403);
    // The refusal happens before the handler: no evaluation is run for a
    // principal who is not a member of the project.
    expect(evaluationService.runQueries).not.toHaveBeenCalled();
    // ProjectMembershipGuard — not a private controller check — produced it.
    expect(guardCanActivate).toHaveBeenCalledTimes(1);
  });

  it('AC2 boundary: POST /api/projects/:slug/kb/evaluate/retrieval returns 200 for a member DEVELOPER user', async () => {
    const res = await request(app.getHttpServer()).post(
      '/api/projects/alpha/kb/evaluate/retrieval',
    );

    expect(res.status).toBe(200);
    expect(evaluationService.runQueries).toHaveBeenCalledTimes(1);
    expect(guardCanActivate).toHaveBeenCalledTimes(1);
  });

  it('AC2: the membership rule is evaluated exactly once per request, by ProjectMembershipGuard', async () => {
    const res = await request(app.getHttpServer()).post(
      '/api/projects/alpha/kb/evaluate/retrieval',
    );

    expect(res.status).toBe(200);
    // The guard resolves the caller's ProjectMember row once. The controller's
    // deleted `checkProjectMembership` used to run the same lookup a second time.
    expect(projectRepo.findMembershipRole).toHaveBeenCalledTimes(1);
    expect(projectRepo.findMembershipRole).toHaveBeenCalledWith('proj-1', 'user-dev');
  });

  it('AC2 boundary: an unknown slug returns 404 (the project-existence check is preserved)', async () => {
    projectRepo.findBySlug.mockResolvedValue(null);

    const res = await request(app.getHttpServer()).post(
      '/api/projects/no-such-project/kb/evaluate/retrieval',
    );

    expect(res.status).toBe(404);
    expect(evaluationService.runQueries).not.toHaveBeenCalled();
  });

  it('AC2 boundary: a member whose project role is VIEWER is admitted (this route has no @ProjectRoles gate)', async () => {
    projectRepo.findMembershipRole.mockResolvedValue('VIEWER');

    const res = await request(app.getHttpServer()).post(
      '/api/projects/alpha/kb/evaluate/retrieval',
    );

    expect(res.status).toBe(200);
    expect(evaluationService.runQueries).toHaveBeenCalledTimes(1);
  });
});
