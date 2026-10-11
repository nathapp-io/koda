import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalController } from './retrieval.controller';
import { EvaluationService } from './evaluation.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';

describe('RetrievalController', () => {
  let controller: RetrievalController;
  let evaluationService: Mocked<EvaluationService>;

  const mockFindProjectIdBySlug = vi.fn();
  const mockAssertProjectMembership = vi.fn();

  const mockProjectAccessService: Partial<ProjectAccessService> = {
    findProjectIdBySlug: mockFindProjectIdBySlug,
    assertProjectMembership: mockAssertProjectMembership,
  };

  beforeEach(async () => {
    evaluationService = {
      runQueries: vi.fn().mockResolvedValue({ precisionAt5: 1 }),
    } as unknown as Mocked<EvaluationService>;

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
    vi.clearAllMocks();
  });

  describe('evaluateRetrieval', () => {
    it('delegates to EvaluationService.runQueries and returns its result', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);

      const result = await controller.evaluateRetrieval('alpha');

      expect(evaluationService.runQueries).toHaveBeenCalled();
      expect((result as any).data).toEqual({ precisionAt5: 1 });
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.evaluateRetrieval('missing'),
      ).rejects.toThrow(NotFoundAppException);
    });

    // US-005: the private `checkProjectMembership` copy is gone. Membership is
    // decided by the class-level ProjectMembershipGuard (see
    // retrieval-membership.routes.spec.ts for the HTTP-level 403); the handler
    // must not evaluate the membership rule a second time.
    it('US-005: leaves the membership decision to ProjectMembershipGuard instead of evaluating it in the handler', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');

      await controller.evaluateRetrieval('alpha');

      expect(mockAssertProjectMembership).not.toHaveBeenCalled();
      expect(evaluationService.runQueries).toHaveBeenCalled();
    });
  });
});
