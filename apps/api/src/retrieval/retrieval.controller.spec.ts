import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalController } from './retrieval.controller';
import { EvaluationService } from './evaluation.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';

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

  const mockFindProjectIdBySlug = jest.fn();
  const mockAssertProjectMembership = jest.fn();

  const mockProjectAccessService: Partial<ProjectAccessService> = {
    findProjectIdBySlug: mockFindProjectIdBySlug,
    assertProjectMembership: mockAssertProjectMembership,
  };

  beforeEach(async () => {
    evaluationService = {
      runQueries: jest.fn().mockResolvedValue({ precisionAt5: 1 }),
    } as unknown as jest.Mocked<EvaluationService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RetrievalController],
      providers: [
        { provide: EvaluationService, useValue: evaluationService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
      ],
    }).compile();

    controller = module.get<RetrievalController>(RetrievalController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('evaluateRetrieval', () => {
    it('delegates to EvaluationService.runQueries and returns its result', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);

      const result = await controller.evaluateRetrieval('alpha', mockAdminUser);

      expect(evaluationService.runQueries).toHaveBeenCalled();
      expect((result as any).data).toEqual({ precisionAt5: 1 });
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.evaluateRetrieval('missing', mockAdminUser),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('forbids user without membership', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

      await expect(
        controller.evaluateRetrieval('alpha', mockMemberUser),
      ).rejects.toThrow(ForbiddenAppException);
    });
  });
});
