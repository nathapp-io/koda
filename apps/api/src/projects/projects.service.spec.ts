import { ProjectsService } from './projects.service';
import { RagService } from '../rag/rag.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let ragService: jest.Mocked<RagService>;
  let mockPrismaService: any;

  beforeEach(() => {
    mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      },
    };

    ragService = {
      deleteAllBySourceType: jest.fn(),
    } as any;

    service = new ProjectsService(
      mockPrismaService as any,
      ragService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('update', () => {
    const mockProject = {
      id: 'project-1',
      slug: 'test-project',
      name: 'Test Project',
      key: 'TP',
      description: 'A test project',
      gitRemoteUrl: null,
      autoIndexOnClose: true,
      autoAssign: 'OFF',
      ciWebhookToken: null,
      graphifyEnabled: true,
      graphifyLastImportedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should call deleteAllBySourceType when graphifyEnabled changes from true to false', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.client.project.update.mockResolvedValueOnce({
        ...mockProject,
        graphifyEnabled: false,
      });

      await service.update('test-project', { graphifyEnabled: false });

      expect(ragService.deleteAllBySourceType).toHaveBeenCalledWith(
        'project-1',
        'code',
      );
    });

    it('should not call deleteAllBySourceType when graphifyEnabled is not present in update payload', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.client.project.update.mockResolvedValueOnce(mockProject);

      await service.update('test-project', { name: 'Updated Name' });

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });

    it('should not call deleteAllBySourceType when graphifyEnabled changes from false to true', async () => {
      const projectWithGraphifyDisabled = {
        ...mockProject,
        graphifyEnabled: false,
      };
      mockPrismaService.client.project.findUnique.mockResolvedValueOnce(
        projectWithGraphifyDisabled,
      );
      mockPrismaService.client.project.update.mockResolvedValueOnce(mockProject);

      await service.update('test-project', { graphifyEnabled: true });

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });

    it('should not call deleteAllBySourceType when graphifyEnabled is true in both current and update payload', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.client.project.update.mockResolvedValueOnce(mockProject);

      await service.update('test-project', { graphifyEnabled: true });

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });

    it('should log at warn level when deleteAllBySourceType throws, and not re-throw', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.client.project.update.mockResolvedValueOnce({
        ...mockProject,
        graphifyEnabled: false,
      });
      ragService.deleteAllBySourceType.mockRejectedValueOnce(
        new Error('RAG service error'),
      );

      const warnSpy = jest.spyOn(service['logger'], 'warn');

      const result = await service.update('test-project', {
        graphifyEnabled: false,
      });

      expect(ragService.deleteAllBySourceType).toHaveBeenCalledWith(
        'project-1',
        'code',
      );
      expect(warnSpy).toHaveBeenCalled();
      expect(result).toBeDefined();

      warnSpy.mockRestore();
    });

    it('should throw NotFoundAppException when project is not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.update('non-existent', { name: 'Updated' }),
      ).rejects.toThrow(NotFoundAppException);
    });
  });
});
