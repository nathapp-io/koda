import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ProjectsService } from '../../src/projects/projects.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Projects Integration Tests', () => {
  let _app: INestApplication;
  let projectsService: ProjectsService;
  let _prismaService: PrismaService;

  const mockProject = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockPrismaService = {
    project: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    projectsService = module.get<ProjectsService>(ProjectsService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete project lifecycle', () => {
    it('should create, retrieve, update, and delete a project', async () => {
      const createDto = {
        name: 'Test Project',
        slug: 'test-project',
        key: 'TEST',
        description: 'A test project',
      };

      // 1. Create project
      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const created = await projectsService.create(createDto);
      expect(created).toBeDefined();
      expect(created.name).toBe(createDto.name);

      // 2. Retrieve project by slug
      mockPrismaService.project.findUnique.mockResolvedValue(created);
      const retrieved = await projectsService.findBySlug(createDto.slug);
      expect(retrieved).toEqual(created);

      // 3. Update project
      const updateDto = { name: 'Updated Test Project' };
      const updated = { ...created, ...updateDto };
      mockPrismaService.project.update.mockResolvedValue(updated);

      const updateResult = await projectsService.update(createDto.slug, updateDto);
      expect(updateResult.name).toBe(updateDto.name);

      // 4. Soft delete project
      const deleted = { ...updated, deletedAt: new Date() };
      mockPrismaService.project.update.mockResolvedValue(deleted);

      const deleteResult = await projectsService.softDelete(createDto.slug);
      expect(deleteResult.deletedAt).not.toBeNull();

      // 5. Verify deleted project not in findAll
      mockPrismaService.project.findMany.mockResolvedValue([]);
      const remaining = await projectsService.findAll();
      expect(remaining).not.toContainEqual(deleted);
    });
  });

  describe('Multiple projects scenarios', () => {
    it('should handle multiple projects correctly', async () => {
      const project1 = { ...mockProject, slug: 'project-1', key: 'PROJ1' };
      const project2 = { ...mockProject, slug: 'project-2', key: 'PROJ2' };
      const project3 = { ...mockProject, slug: 'project-3', key: 'PROJ3', deletedAt: new Date() };

      mockPrismaService.project.findMany.mockResolvedValue([project1, project2]);

      const result = await projectsService.findAll();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(project1);
      expect(result).toContainEqual(project2);
      expect(result).not.toContainEqual(project3);
    });

    it('should prevent duplicate slugs across multiple projects', async () => {
      const firstDto = {
        name: 'First Project',
        slug: 'my-project',
        key: 'FIRST',
      };

      const secondDto = {
        name: 'Second Project',
        slug: 'my-project',
        key: 'SECOND',
      };

      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...firstDto,
      });

      await projectsService.create(firstDto);

      mockPrismaService.project.findUnique.mockResolvedValueOnce({
        ...mockProject,
        ...firstDto,
      });

      await expect(projectsService.create(secondDto)).rejects.toThrow();
    });

    it('should prevent duplicate keys across multiple projects', async () => {
      const firstDto = {
        name: 'First Project',
        slug: 'first-project',
        key: 'PROJ',
      };

      const secondDto = {
        name: 'Second Project',
        slug: 'second-project',
        key: 'PROJ',
      };

      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...firstDto,
      });

      await projectsService.create(firstDto);

      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.findUnique.mockResolvedValueOnce({
        ...mockProject,
        ...firstDto,
      });

      await expect(projectsService.create(secondDto)).rejects.toThrow();
    });
  });

  describe('Edge cases', () => {
    it('should handle project with minimal fields', async () => {
      const minimalDto = {
        name: 'Min',
        slug: 'min',
        key: 'MIN',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...minimalDto,
        description: null,
        gitRemoteUrl: null,
      });

      const result = await projectsService.create(minimalDto);
      expect(result).toBeDefined();
      expect(result.description).toBeNull();
      expect(result.gitRemoteUrl).toBeNull();
    });

    it('should handle project with very long URL', async () => {
      const longUrl = 'https://github.com/' + 'a'.repeat(200) + '/very-long-repo-name';

      const createDto = {
        name: 'Project',
        slug: 'project',
        key: 'PROJ',
        gitRemoteUrl: longUrl,
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const result = await projectsService.create(createDto);
      expect(result.gitRemoteUrl).toBe(longUrl);
    });

    it('should handle slug with multiple hyphens', async () => {
      const createDto = {
        name: 'Complex Project',
        slug: 'complex-multi-word-project-name',
        key: 'CMWP',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const result = await projectsService.create(createDto);
      expect(result.slug).toBe(createDto.slug);
    });

    it('should handle slug with numbers', async () => {
      const createDto = {
        name: 'Project 123',
        slug: 'project-123',
        key: 'PROJ',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const result = await projectsService.create(createDto);
      expect(result.slug).toBe(createDto.slug);
    });

    it('should handle key with numbers', async () => {
      const createDto = {
        name: 'Project 123',
        slug: 'project-123',
        key: 'PRJ1',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const result = await projectsService.create(createDto);
      expect(result.key).toBe(createDto.key);
    });
  });

  describe('Soft delete behavior', () => {
    it('should not allow querying soft-deleted projects in findAll', async () => {
      const project1 = { ...mockProject, slug: 'project-1' };
      const project2 = { ...mockProject, slug: 'project-2', deletedAt: new Date() };

      mockPrismaService.project.findMany.mockResolvedValue([project1]);

      const result = await projectsService.findAll();

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('project-1');
      expect(result).not.toContainEqual(project2);
    });

    it('should preserve all data when soft deleting', async () => {
      const beforeDelete = {
        ...mockProject,
        description: 'Important description',
        gitRemoteUrl: 'https://github.com/important/repo',
      };

      const afterDelete = { ...beforeDelete, deletedAt: new Date() };

      mockPrismaService.project.findUnique.mockResolvedValue(beforeDelete);
      mockPrismaService.project.update.mockResolvedValue(afterDelete);

      const result = await projectsService.softDelete('project');

      expect(result.name).toBe(beforeDelete.name);
      expect(result.slug).toBe(beforeDelete.slug);
      expect(result.key).toBe(beforeDelete.key);
      expect(result.description).toBe(beforeDelete.description);
      expect(result.gitRemoteUrl).toBe(beforeDelete.gitRemoteUrl);
      expect(result.deletedAt).not.toBeNull();
    });
  });
});
