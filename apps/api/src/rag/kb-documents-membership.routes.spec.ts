import type { Mock } from 'vitest';
/**
 * US-005 — AC1: POST /api/projects/:slug/kb/documents keeps returning 403 for a
 * non-member after RagController's private `checkProjectMembership` and
 * PrismaRagRepository.findProjectMembership are deleted.
 *
 * Boots a real Fastify HTTP server (mocked providers, no database, no network)
 * so the KB write route runs behind its real guard chain: `ProjectMembershipGuard`
 * (membership) then `RequiresGuard` (the permission key). The controller only
 * resolves the project through PrismaRagRepository.findProjectBySlug.
 *
 * US-007: the `@ProjectRoles` gate is gone and the key decides, so the stub below
 * refuses the keys a role does not hold. The key table itself (viewer vs developer
 * on each of the seven routes) is covered over real HTTP by
 * test/integration/rag/permissions-kb-routes.integration.spec.ts.
 */
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { PrismaRagRepository } from './prisma-rag.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { PermissionService } from '../permissions/permission.service';
import { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

interface RagRepositoryStub {
  findProjectBySlug: Mock;
}

interface RagServiceStub {
  indexDocument: Mock;
  findSourceCreators: Mock;
}

interface HybridRetrieverStub {
  search: Mock;
}

interface ProjectRepositoryStub {
  findBySlug: Mock;
  findMembershipRole: Mock;
}

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

describe('RagController KB document membership gate (US-005 AC1)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;

  let currentPrincipal: KodaPrincipal;

  let ragRepository: RagRepositoryStub;
  let ragService: RagServiceStub;
  let hybridRetriever: HybridRetrieverStub;
  let projectRepo: ProjectRepositoryStub;

  /** The catalog keys the stub refuses; each case sets the ones its role does not hold (US-007). */
  let refusedKeys: ReadonlySet<string>;
  const can = vi.fn(async (_principal: unknown, key: string) =>
    refusedKeys.has(key) ? { allowed: false, reason: 'not-granted' } : { allowed: true, reason: 'granted' },
  );

  // Records every execution of the real guard: the guard — not a controller
  // private check — is what must decide membership on this route.
  const guardCanActivate = vi.spyOn(ProjectMembershipGuard.prototype, 'canActivate');

  const developerUser = makeUserPrincipal('user-dev');

  beforeAll(async () => {
    ragRepository = { findProjectBySlug: vi.fn() };
    ragService = { indexDocument: vi.fn(), findSourceCreators: vi.fn().mockResolvedValue([]) };
    hybridRetriever = { search: vi.fn() };
    projectRepo = { findBySlug: vi.fn(), findMembershipRole: vi.fn() };

    testingModule = await Test.createTestingModule({
      controllers: [RagController],
      providers: [
        { provide: RagService, useValue: ragService },
        { provide: HybridRetrieverService, useValue: hybridRetriever },
        { provide: PrismaRagRepository, useValue: ragRepository },
        // The real access service over a stubbed repository: the guard's
        // membership decision is driven by the fake ProjectMember rows below.
        ProjectAccessService,
        { provide: PrismaProjectRepository, useValue: projectRepo },
        // Register the guards so NestJS applies them to the route's
        // @UseGuards(ProjectMembershipGuard, RequiresGuard).
        ProjectMembershipGuard,
        { provide: PermissionService, useValue: { can } },
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
    vi.clearAllMocks();

    currentPrincipal = developerUser;
    refusedKeys = new Set();

    ragRepository.findProjectBySlug.mockResolvedValue({
      id: 'proj-1',
      slug: 'alpha',
      graphifyEnabled: false,
      deletedAt: null,
    });
    ragService.indexDocument.mockResolvedValue('doc-id');
    ragService.findSourceCreators.mockResolvedValue([]);
    projectRepo.findBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: null });
    projectRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
  });

  it('AC1: POST /api/projects/:slug/kb/documents returns 403 for a caller without project.read', async () => {
    // US-001: access is `project.read` in the project, so that is what a non-member is refused.
    refusedKeys = new Set(['project.read']);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(403);
    // The refusal happens before the handler: nothing is indexed.
    expect(ragService.indexDocument).not.toHaveBeenCalled();
    // The guard refuses before the controller resolves the project, so the
    // controller's own repository lookup never runs for a non-member.
    expect(ragRepository.findProjectBySlug).not.toHaveBeenCalled();
    expect(guardCanActivate).toHaveBeenCalledTimes(1);
  });

  it('AC1 boundary: POST /api/projects/:slug/kb/documents returns 201 for a member whose project role is DEVELOPER', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(201);
    expect(ragService.indexDocument).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ sourceId: 'doc-1' }),
    );
    expect(guardCanActivate).toHaveBeenCalledTimes(1);
  });

  it('AC1 boundary: a member whose project role is VIEWER is refused on the KB write route', async () => {
    projectRepo.findMembershipRole.mockResolvedValue('VIEWER');
    // US-007: the key decides. A Viewer holds only `*.read`, so `kb.document.add` is refused before the handler.
    refusedKeys = new Set(['kb.document.add']);

    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(403);
    // No global exception filter in this bare app: the ForbiddenAppException is serialized as-is.
    expect(res.body).toEqual(expect.objectContaining({ code: 40003, prefix: 'permissions' }));
    expect(ragService.indexDocument).not.toHaveBeenCalled();
    expect(guardCanActivate).toHaveBeenCalledTimes(1);
  });

  it('US-007: a DEVELOPER member is admitted and records itself as the row creator', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/alpha/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-2', content: 'hello world' });

    expect(res.status).toBe(201);
    expect(ragService.indexDocument).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ createdBy: { type: 'USER', id: 'user-dev' } }),
    );
  });

  it('AC1 boundary: an unknown slug returns 404 for the KB document route', async () => {
    projectRepo.findBySlug.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .post('/api/projects/no-such-project/kb/documents')
      .send({ source: 'doc', sourceId: 'doc-1', content: 'hello world' });

    expect(res.status).toBe(404);
    expect(ragService.indexDocument).not.toHaveBeenCalled();
  });
});
