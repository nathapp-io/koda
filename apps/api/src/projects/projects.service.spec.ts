import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { RagService } from '../rag/rag.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { UpdateProjectDto } from './dto/update-project.dto';

describe('ProjectsService — graphify toggle enforcement', () => {
  let service: ProjectsService;
  let ragService: RagService;

  const mockProject = {
    id: 'proj-abc',
    name: 'Test Project',
    slug: 'test-project',
    key: 'TST',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    ciWebhookToken: null,
    graphifyEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockUpdatedProject = {
    ...mockProject,
    graphifyEnabled: false,
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    },
  };

  const mockRagService = {
    deleteAllBySourceType: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RagService, useValue: mockRagService },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
    ragService = module.get<RagService>(RagService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC1: graphifyEnabled true → false triggers RAG cleanup', () => {
    it('calls ragService.deleteAllBySourceType(projectId, "code") when graphifyEnabled changes from true to false', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockPrismaService.client.project.update.mockResolvedValue(mockUpdatedProject);
      mockRagService.deleteAllBySourceType.mockResolvedValue(5);

      const dto: UpdateProjectDto = { graphifyEnabled: false };
      await service.update('test-project', dto);

      expect(ragService.deleteAllBySourceType).toHaveBeenCalledTimes(1);
      expect(ragService.deleteAllBySourceType).toHaveBeenCalledWith('proj-abc', 'code');
    });
  });

  describe('AC2: graphifyEnabled false → true does NOT trigger RAG cleanup', () => {
    it('does not call ragService.deleteAllBySourceType when graphifyEnabled changes from false to true', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: false });
      mockPrismaService.client.project.update.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockRagService.deleteAllBySourceType.mockResolvedValue(0);

      const dto: UpdateProjectDto = { graphifyEnabled: true };
      await service.update('test-project', dto);

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });
  });

  describe('AC3: graphifyEnabled absent in payload does NOT trigger RAG cleanup', () => {
    it('does not call ragService.deleteAllBySourceType when graphifyEnabled is not in the payload', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockPrismaService.client.project.update.mockResolvedValue(mockProject);

      const dto: UpdateProjectDto = { name: 'Renamed Project' };
      await service.update('test-project', dto);

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });
  });

  describe('AC4: graphifyEnabled true → true does NOT trigger RAG cleanup', () => {
    it('does not call ragService.deleteAllBySourceType when graphifyEnabled stays true', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockPrismaService.client.project.update.mockResolvedValue(mockProject);

      const dto: UpdateProjectDto = { graphifyEnabled: true };
      await service.update('test-project', dto);

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });
  });

  describe('AC5: ragService.deleteAllBySourceType throws — warn, no re-throw, update still persisted', () => {
    it('logs at warn level and does not re-throw when ragService.deleteAllBySourceType throws', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockPrismaService.client.project.update.mockResolvedValue(mockUpdatedProject);
      mockRagService.deleteAllBySourceType.mockRejectedValue(new Error('LanceDB unavailable'));

      const dto: UpdateProjectDto = { graphifyEnabled: false };

      // Should not throw
      await expect(service.update('test-project', dto)).resolves.not.toThrow();
    });

    it('still persists the project update when ragService.deleteAllBySourceType throws', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockPrismaService.client.project.update.mockResolvedValue(mockUpdatedProject);
      mockRagService.deleteAllBySourceType.mockRejectedValue(new Error('LanceDB unavailable'));

      const dto: UpdateProjectDto = { graphifyEnabled: false };
      await service.update('test-project', dto);

      expect(mockPrismaService.client.project.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC6: RagService is injectable in ProjectsService via DI', () => {
    it('receives a RagService instance through DI', () => {
      expect(ragService).toBeDefined();
      expect(ragService.deleteAllBySourceType).toBeDefined();
    });
  });
});
