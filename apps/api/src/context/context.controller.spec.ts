import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ContextController } from './context.controller';
import { ContextBuilderService } from './context-builder.service';
import { ProjectsService } from '../projects/projects.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

const makeContextResponse = () => ({
  projectId: 'project-1',
  canonicalState: { tickets: [], recentEvents: [], activeDecisions: [] },
  retrievedContext: { documents: { results: [], scores: [], retrievedAt: new Date().toISOString() }, semanticMemory: [] },
  provenance: { sources: [], retrievalStrategy: 'canonical-only' },
  meta: { intent: 'answer', tokensUsed: 100, retrievedAt: new Date(), latencyMs: 50 },
});

const adminUser: KodaPrincipal = {
  actorType: 'user',
  id: 'user-admin',
  email: 'admin@example.com',
  name: 'admin@example.com',
  role: 'ADMIN',
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
};

const memberUser: KodaPrincipal = {
  actorType: 'user',
  id: 'user-member',
  email: 'member@example.com',
  name: 'member@example.com',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
};

const agentPrincipal: KodaPrincipal = {
  actorType: 'agent',
  id: 'agent-1',
  name: 'test-agent',
  slug: 'test-agent',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};

describe('ContextController', () => {
  let controller: ContextController;
  let contextBuilderService: { getProjectContext: jest.Mock };
  let projectsService: {
    findProjectIdBySlug: jest.Mock;
    assertProjectMembership: jest.Mock;
  };

  beforeEach(async () => {
    contextBuilderService = {
      getProjectContext: jest.fn().mockResolvedValue(makeContextResponse()),
    };

    projectsService = {
      findProjectIdBySlug: jest.fn().mockResolvedValue('project-1'),
      assertProjectMembership: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContextController],
      providers: [
        { provide: ContextBuilderService, useValue: contextBuilderService },
        { provide: ProjectsService, useValue: projectsService },
      ],
    }).compile();

    controller = module.get(ContextController);
    jest.clearAllMocks();

    // Default: project found, membership ok
    projectsService.findProjectIdBySlug.mockResolvedValue('project-1');
    projectsService.assertProjectMembership.mockResolvedValue(undefined);
    contextBuilderService.getProjectContext.mockResolvedValue(makeContextResponse());
  });

  describe('slug resolution', () => {
    it('resolves slug to projectId before building context (getContext)', async () => {
      const result = await controller.getContext('my-project', { intent: 'answer' }, adminUser);

      expect(projectsService.findProjectIdBySlug).toHaveBeenCalledWith('my-project');
      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1' }),
      );
      expect(result).toBeDefined();
    });

    it('throws NotFoundAppException for unknown slug (getContext)', async () => {
      projectsService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.getContext('nonexistent', { intent: 'answer' }, adminUser),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws NotFoundAppException for soft-deleted project (getContext)', async () => {
      projectsService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.getContext('deleted-project', { intent: 'answer' }, adminUser),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('resolves slug to projectId before building context (queryContext)', async () => {
      const result = await controller.queryContext('my-project', { intent: 'plan' }, adminUser);

      expect(projectsService.findProjectIdBySlug).toHaveBeenCalledWith('my-project');
      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1' }),
      );
      expect(result).toBeDefined();
    });

    it('throws NotFoundAppException for unknown slug (queryContext)', async () => {
      projectsService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.queryContext('nonexistent', { intent: 'answer' }, adminUser),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });
  });

  describe('GET /context/:slug — getContext', () => {
    describe('membership checks', () => {
      test('throws ForbiddenAppException when principal is null', async () => {
        await expect(
          controller.getContext('my-project', { intent: 'answer' }, null as unknown as KodaPrincipal),
        ).rejects.toThrow(ForbiddenAppException);
      });

      test('allows ADMIN user and calls assertProjectMembership', async () => {
        const result = await controller.getContext('my-project', { intent: 'answer' }, adminUser);

        expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', adminUser);
        expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
      });

      test('allows agent principal and calls assertProjectMembership', async () => {
        const result = await controller.getContext('my-project', { intent: 'answer' }, agentPrincipal);

        expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', agentPrincipal);
        expect(result).toBeDefined();
      });

      test('throws ForbiddenAppException when member has no project membership', async () => {
        projectsService.assertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

        await expect(
          controller.getContext('my-project', { intent: 'answer' }, memberUser),
        ).rejects.toThrow(ForbiddenAppException);
      });

      test('allows member with valid membership', async () => {
        projectsService.assertProjectMembership.mockResolvedValue(undefined);

        const result = await controller.getContext('my-project', { intent: 'answer' }, memberUser);

        expect(result).toBeDefined();
        expect(contextBuilderService.getProjectContext).toHaveBeenCalled();
      });

      test('calls assertProjectMembership with resolved projectId and principal for member user', async () => {
        projectsService.assertProjectMembership.mockResolvedValue(undefined);
        await controller.getContext('my-project', { intent: 'answer' }, memberUser);

        expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', memberUser);
      });
    });

    describe('query building', () => {
      test('passes resolved projectId and actorId to contextBuilderService', async () => {
        await controller.getContext('my-project', { intent: 'answer' }, adminUser);

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-1', actorId: 'user-admin' }),
        );
      });

      test('passes intent from query dto', async () => {
        await controller.getContext('my-project', { intent: 'diagnose' }, adminUser);

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ intent: 'diagnose' }),
        );
      });

      test('passes optional query, ticketIds, repoRefs when provided', async () => {
        await controller.getContext(
          'my-project',
          { intent: 'answer', query: 'auth flow', ticketIds: ['t-1'], repoRefs: ['sha-1'] },
          adminUser,
        );

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ query: 'auth flow', ticketIds: ['t-1'], repoRefs: ['sha-1'] }),
        );
      });

      test('converts tokenBudget from query string to number', async () => {
        await controller.getContext(
          'my-project',
          { intent: 'answer', tokenBudget: '2000' as unknown as number },
          adminUser,
        );

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ tokenBudget: 2000 }),
        );
      });

      test('passes undefined tokenBudget when not provided', async () => {
        await controller.getContext('my-project', { intent: 'answer' }, adminUser);

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ tokenBudget: undefined }),
        );
      });
    });

    describe('response', () => {
      test('returns JsonResponse.Ok wrapping context response', async () => {
        const ctxResponse = makeContextResponse();
        contextBuilderService.getProjectContext.mockResolvedValue(ctxResponse);

        const result = await controller.getContext('my-project', { intent: 'answer' }, adminUser);

        expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
      });
    });
  });

  describe('POST /context/:slug/query — queryContext', () => {
    test('throws ForbiddenAppException when principal is null', async () => {
      await expect(
        controller.queryContext('my-project', { intent: 'answer' }, null as unknown as KodaPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
    });

    test('allows ADMIN user and calls contextBuilderService', async () => {
      const result = await controller.queryContext('my-project', { intent: 'plan' }, adminUser);

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ intent: 'plan', projectId: 'project-1', actorId: 'user-admin' }),
      );
      expect(result).toBeDefined();
    });

    test('throws ForbiddenAppException when member has no project membership', async () => {
      projectsService.assertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

      await expect(
        controller.queryContext('my-project', { intent: 'answer' }, memberUser),
      ).rejects.toThrow(ForbiddenAppException);
    });

    test('allows member with valid membership and passes body fields', async () => {
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      const body = { intent: 'search' as const, query: 'ticket bugs', ticketIds: ['t-2'] };

      await controller.queryContext('my-project', body, memberUser);

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ intent: 'search', query: 'ticket bugs', ticketIds: ['t-2'] }),
      );
    });

    test('returns JsonResponse.Ok wrapping context response', async () => {
      const ctxResponse = makeContextResponse();
      contextBuilderService.getProjectContext.mockResolvedValue(ctxResponse);

      const result = await controller.queryContext('my-project', { intent: 'answer' }, adminUser);

      expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
    });
  });
});
