import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ContextController } from './context.controller';
import { ContextBuilderService } from './context-builder.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
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
  let prismaClientMock: { projectMember: { findUnique: jest.Mock } };

  beforeEach(async () => {
    contextBuilderService = {
      getProjectContext: jest.fn().mockResolvedValue(makeContextResponse()),
    };

    prismaClientMock = {
      projectMember: {
        findUnique: jest.fn(),
      },
    };

    const prismaMock = {
      client: prismaClientMock,
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContextController],
      providers: [
        { provide: ContextBuilderService, useValue: contextBuilderService },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    controller = module.get(ContextController);
    jest.clearAllMocks();

    // Default: service returns context
    contextBuilderService.getProjectContext.mockResolvedValue(makeContextResponse());
  });

  describe('GET /context/:projectId — getContext', () => {
    describe('membership checks', () => {
      test('throws ForbiddenAppException when principal is null', async () => {
        await expect(
          controller.getContext('project-1', { intent: 'answer' }, null as unknown as KodaPrincipal),
        ).rejects.toThrow(ForbiddenAppException);
      });

      test('allows ADMIN user without membership check', async () => {
        const result = await controller.getContext('project-1', { intent: 'answer' }, adminUser);

        expect(prismaClientMock.projectMember.findUnique).not.toHaveBeenCalled();
        expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
      });

      test('allows agent principal without membership check', async () => {
        const result = await controller.getContext('project-1', { intent: 'answer' }, agentPrincipal);

        expect(prismaClientMock.projectMember.findUnique).not.toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      test('throws ForbiddenAppException when member has no project membership', async () => {
        prismaClientMock.projectMember.findUnique.mockResolvedValue(null);

        await expect(
          controller.getContext('project-1', { intent: 'answer' }, memberUser),
        ).rejects.toThrow(ForbiddenAppException);
      });

      test('allows member with valid DEVELOPER role membership', async () => {
        prismaClientMock.projectMember.findUnique.mockResolvedValue({ role: 'DEVELOPER' });

        const result = await controller.getContext('project-1', { intent: 'answer' }, memberUser);

        expect(result).toBeDefined();
        expect(contextBuilderService.getProjectContext).toHaveBeenCalled();
      });

      test('allows member with VIEWER role membership', async () => {
        prismaClientMock.projectMember.findUnique.mockResolvedValue({ role: 'VIEWER' });

        const result = await controller.getContext('project-1', { intent: 'answer' }, memberUser);

        expect(result).toBeDefined();
      });

      test('throws ForbiddenAppException when membership role is invalid', async () => {
        prismaClientMock.projectMember.findUnique.mockResolvedValue({ role: 'UNKNOWN_ROLE' });

        await expect(
          controller.getContext('project-1', { intent: 'answer' }, memberUser),
        ).rejects.toThrow(ForbiddenAppException);
      });

      test('queries projectMember by projectId and userId for member user', async () => {
        prismaClientMock.projectMember.findUnique.mockResolvedValue({ role: 'DEVELOPER' });

        await controller.getContext('project-xyz', { intent: 'answer' }, memberUser);

        expect(prismaClientMock.projectMember.findUnique).toHaveBeenCalledWith({
          where: { projectId_userId: { projectId: 'project-xyz', userId: 'user-member' } },
        });
      });
    });

    describe('query building', () => {
      test('passes projectId and actorId to contextBuilderService', async () => {
        await controller.getContext('project-1', { intent: 'answer' }, adminUser);

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-1', actorId: 'user-admin' }),
        );
      });

      test('passes intent from query dto', async () => {
        await controller.getContext('project-1', { intent: 'diagnose' }, adminUser);

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ intent: 'diagnose' }),
        );
      });

      test('passes optional query, ticketIds, repoRefs when provided', async () => {
        await controller.getContext(
          'project-1',
          { intent: 'answer', query: 'auth flow', ticketIds: ['t-1'], repoRefs: ['sha-1'] },
          adminUser,
        );

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ query: 'auth flow', ticketIds: ['t-1'], repoRefs: ['sha-1'] }),
        );
      });

      test('converts tokenBudget from query string to number', async () => {
        await controller.getContext(
          'project-1',
          { intent: 'answer', tokenBudget: '2000' as unknown as number },
          adminUser,
        );

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ tokenBudget: 2000 }),
        );
      });

      test('passes undefined tokenBudget when not provided', async () => {
        await controller.getContext('project-1', { intent: 'answer' }, adminUser);

        expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
          expect.objectContaining({ tokenBudget: undefined }),
        );
      });
    });

    describe('response', () => {
      test('returns JsonResponse.Ok wrapping context response', async () => {
        const ctxResponse = makeContextResponse();
        contextBuilderService.getProjectContext.mockResolvedValue(ctxResponse);

        const result = await controller.getContext('project-1', { intent: 'answer' }, adminUser);

        expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
      });
    });
  });

  describe('POST /context/:projectId/query — queryContext', () => {
    test('throws ForbiddenAppException when principal is null', async () => {
      await expect(
        controller.queryContext('project-1', { intent: 'answer' }, null as unknown as KodaPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
    });

    test('allows ADMIN user and calls contextBuilderService', async () => {
      const result = await controller.queryContext('project-1', { intent: 'plan' }, adminUser);

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ intent: 'plan', projectId: 'project-1', actorId: 'user-admin' }),
      );
      expect(result).toBeDefined();
    });

    test('throws ForbiddenAppException when member has no project membership', async () => {
      prismaClientMock.projectMember.findUnique.mockResolvedValue(null);

      await expect(
        controller.queryContext('project-1', { intent: 'answer' }, memberUser),
      ).rejects.toThrow(ForbiddenAppException);
    });

    test('allows member with valid membership and passes body fields', async () => {
      prismaClientMock.projectMember.findUnique.mockResolvedValue({ role: 'DEVELOPER' });
      const body = { intent: 'search' as const, query: 'ticket bugs', ticketIds: ['t-2'] };

      await controller.queryContext('project-1', body, memberUser);

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ intent: 'search', query: 'ticket bugs', ticketIds: ['t-2'] }),
      );
    });

    test('returns JsonResponse.Ok wrapping context response', async () => {
      const ctxResponse = makeContextResponse();
      contextBuilderService.getProjectContext.mockResolvedValue(ctxResponse);

      const result = await controller.queryContext('project-1', { intent: 'answer' }, adminUser);

      expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
    });
  });
});
