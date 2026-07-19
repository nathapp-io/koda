import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalController } from './retrieval.controller';
import { EvaluationService } from './evaluation.service';
import { PrismaRagRepository } from '../rag/prisma-rag.repository';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  name: 'Alpha',
  key: 'ALP',
  graphifyEnabled: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockAdminUser = {
  actorType: 'user' as const,
  id: 'user-admin',
  name: 'admin@example.com',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
  extra: { sub: 'user-admin' },
};

const mockMemberUser = {
  actorType: 'user' as const,
  id: 'user-member',
  name: 'member@example.com',
  email: 'member@example.com',
  role: 'MEMBER' as const,
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
  extra: { sub: 'user-member' },
};

describe('RetrievalController', () => {
  let controller: RetrievalController;
  let evaluationService: jest.Mocked<EvaluationService>;

  const mockFindProjectBySlug = jest.fn();
  const mockFindProjectMembership = jest.fn();

  const mockRagRepository: Partial<PrismaRagRepository> = {
    findProjectBySlug: mockFindProjectBySlug,
    findProjectMembership: mockFindProjectMembership,
  };

  beforeEach(async () => {
    evaluationService = {
      runQueries: jest.fn().mockResolvedValue({ precisionAt5: 1 }),
    } as unknown as jest.Mocked<EvaluationService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RetrievalController],
      providers: [
        { provide: EvaluationService, useValue: evaluationService },
        { provide: PrismaRagRepository, useValue: mockRagRepository },
      ],
    }).compile();

    controller = module.get<RetrievalController>(RetrievalController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('evaluateRetrieval', () => {
    it('delegates to EvaluationService.runQueries and returns its result', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);

      const result = await controller.evaluateRetrieval('alpha', mockAdminUser);

      expect(evaluationService.runQueries).toHaveBeenCalled();
      expect((result as any).data).toEqual({ precisionAt5: 1 });
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.evaluateRetrieval('missing', mockAdminUser),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('forbids user without membership', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      mockFindProjectMembership.mockResolvedValue(null);

      await expect(
        controller.evaluateRetrieval('alpha', mockMemberUser),
      ).rejects.toThrow(ForbiddenAppException);
    });
  });
});
