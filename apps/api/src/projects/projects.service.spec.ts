import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictException as _ConflictException, BadRequestException as _BadRequestException } from '@nestjs/common';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let prismaService: PrismaService;

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

    service = module.get<ProjectsService>(ProjectsService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new project with valid input', async () => {
      const createDto = {
        name: 'Koda',
        slug: 'koda',
        key: 'KODA',
        description: 'Dev ticket tracker',
        gitRemoteUrl: 'https://github.com/nathapp-io/koda',
        autoIndexOnClose: true,
      };

      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.create.mockResolvedValue(mockProject);

      const result = await service.create(createDto);

      expect(result).toEqual(mockProject);
      expect(prismaService.project.create).toHaveBeenCalledWith({
        data: expect.objectContaining(createDto),
      });
    });

    it('should reject duplicate slug with 409', async () => {
      const createDto = {
        name: 'Koda',
        slug: 'koda',
        key: 'KODA2',
      };

      mockPrismaService.project.findUnique.mockResolvedValueOnce(mockProject);

      await expect(service.create(createDto)).rejects.toThrow();
    });

    it('should reject duplicate key with 409', async () => {
      const createDto = {
        name: 'Koda 2',
        slug: 'koda-2',
        key: 'KODA',
      };

      mockPrismaService.project.findUnique.mockResolvedValueOnce(null);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(mockProject);

      await expect(service.create(createDto)).rejects.toThrow();
    });

    it('should validate key format (2-6 uppercase alphanumeric)', async () => {
      const invalidKeys = ['K', 'KODASOMETHING', 'koda', '1234', 'KO-DA'];

      for (const invalidKey of invalidKeys) {
        const createDto = {
          name: 'Test',
          slug: 'test',
          key: invalidKey,
        };

        await expect(service.create(createDto)).rejects.toThrow();
      }
    });

    it('should validate slug format (lowercase alphanumeric and hyphens)', async () => {
      const invalidSlugs = ['KODA', 'Koda', 'koda_project', 'koda@project'];

      for (const invalidSlug of invalidSlugs) {
        const createDto = {
          name: 'Test',
          slug: invalidSlug,
          key: 'TEST',
        };

        await expect(service.create(createDto)).rejects.toThrow();
      }
    });

    it('should validate name minimum length (min 2)', async () => {
      const createDto = {
        name: 'K',
        slug: 'test',
        key: 'TEST',
      };

      await expect(service.create(createDto)).rejects.toThrow();
    });

    it('should accept optional fields', async () => {
      const createDto = {
        name: 'Minimal Project',
        slug: 'minimal',
        key: 'MIN',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);
      mockPrismaService.project.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const result = await service.create(createDto);

      expect(result).toBeDefined();
      expect(prismaService.project.create).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('should return all projects excluding soft-deleted ones', async () => {
      const projects = [mockProject];
      mockPrismaService.project.findMany.mockResolvedValue(projects);

      const result = await service.findAll();

      expect(result).toEqual(projects);
      expect(prismaService.project.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
    });

    it('should not return projects where deletedAt is not null', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockPrismaService.project.findMany.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).not.toContain(deletedProject);
      expect(prismaService.project.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
    });

    it('should return empty array when no projects exist', async () => {
      mockPrismaService.project.findMany.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toEqual([]);
    });
  });

  describe('findBySlug', () => {
    it('should return project by slug', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const result = await service.findBySlug('koda');

      expect(result).toEqual(mockProject);
      expect(prismaService.project.findUnique).toHaveBeenCalledWith({
        where: { slug: 'koda' },
      });
    });

    it('should return null if project not found', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(null);

      const result = await service.findBySlug('nonexistent');

      expect(result).toBeNull();
    });

    it('should not return soft-deleted project', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockPrismaService.project.findUnique.mockResolvedValue(deletedProject);

      const result = await service.findBySlug('koda');

      // Service should filter out deletedAt projects
      if (result && result.deletedAt) {
        // If service doesn't filter, test should fail
        expect(result.deletedAt).toBeNull();
      }
    });
  });

  describe('update', () => {
    it('should update project by slug', async () => {
      const updateDto = {
        name: 'Updated Koda',
        description: 'Updated description',
      };

      const updatedProject = { ...mockProject, ...updateDto };
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.project.update.mockResolvedValue(updatedProject);

      const result = await service.update('koda', updateDto);

      expect(result).toEqual(updatedProject);
      expect(prismaService.project.update).toHaveBeenCalled();
    });

    it('should validate slug uniqueness on update', async () => {
      const updateDto = {
        slug: 'existing-slug',
      };

      const existingProject = { ...mockProject, slug: 'existing-slug' };
      mockPrismaService.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(existingProject);

      await expect(service.update('koda', updateDto)).rejects.toThrow();
    });

    it('should validate key uniqueness on update', async () => {
      const updateDto = {
        key: 'EXISTING',
      };

      const existingProject = { ...mockProject, key: 'EXISTING' };
      mockPrismaService.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.project.findUnique.mockResolvedValueOnce(existingProject);

      await expect(service.update('koda', updateDto)).rejects.toThrow();
    });

    it('should allow same slug and key in update (same project)', async () => {
      const updateDto = {
        name: 'Updated Name',
        slug: 'koda',
        key: 'KODA',
      };

      const updatedProject = { ...mockProject, ...updateDto };
      mockPrismaService.project.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaService.project.update.mockResolvedValue(updatedProject);

      const result = await service.update('koda', updateDto);

      expect(result).toBeDefined();
    });
  });

  describe('softDelete', () => {
    it('should set deletedAt to current timestamp', async () => {
      const now = new Date();
      const deletedProject = { ...mockProject, deletedAt: now };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.project.update.mockResolvedValue(deletedProject);

      const result = await service.softDelete('koda');

      expect(result.deletedAt).not.toBeNull();
      expect(prismaService.project.update).toHaveBeenCalledWith({
        where: { slug: 'koda' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should not hard delete the project', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.project.update.mockResolvedValue(deletedProject);

      const result = await service.softDelete('koda');

      expect(result.id).toBe(mockProject.id);
      expect(result).toBeDefined();
    });

    it('should return updated project with deletedAt set', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.project.update.mockResolvedValue(deletedProject);

      const result = await service.softDelete('koda');

      expect(result).toEqual(deletedProject);
    });
  });
});
