import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ConflictException as _ConflictException, ForbiddenException as _ForbiddenException, BadRequestException as _BadRequestException, NotFoundException as _NotFoundException } from '@nestjs/common';

describe('ProjectsController', () => {
  let controller: ProjectsController;
  let service: ProjectsService;

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

  const mockAdminUser = {
    sub: 'user-123',
    email: 'admin@example.com',
    role: 'ADMIN',
  };

  const mockMemberUser = {
    sub: 'user-456',
    email: 'member@example.com',
    role: 'MEMBER',
  };

  const mockProjectsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findBySlug: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [{ provide: ProjectsService, useValue: mockProjectsService }],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/projects', () => {
    it('should create project with 201 status for ADMIN user', async () => {
      const createDto = {
        name: 'Koda',
        slug: 'koda',
        key: 'KODA',
        description: 'Dev ticket tracker',
        gitRemoteUrl: 'https://github.com/nathapp-io/koda',
        autoIndexOnClose: true,
      };

      mockProjectsService.create.mockResolvedValue(mockProject);

      const req: any = { user: mockAdminUser };
      const result = await controller.create(createDto, req);

      expect(result).toEqual(mockProject);
      expect(service.create).toHaveBeenCalledWith(createDto);
    });

    it('should reject request from non-ADMIN user with 403', async () => {
      const createDto = {
        name: 'Koda',
        slug: 'koda',
        key: 'KODA',
      };

      const req: any = { user: mockMemberUser };

      await expect(controller.create(createDto, req)).rejects.toThrow();
    });

    it('should return 409 for duplicate slug', async () => {
      const createDto = {
        name: 'Koda',
        slug: 'koda',
        key: 'KODA2',
      };

      mockProjectsService.create.mockRejectedValue(new Error('Slug already exists'));

      const req: any = { user: mockAdminUser };

      await expect(controller.create(createDto, req)).rejects.toThrow();
    });

    it('should return 409 for duplicate key', async () => {
      const createDto = {
        name: 'Koda 2',
        slug: 'koda-2',
        key: 'KODA',
      };

      mockProjectsService.create.mockRejectedValue(new Error('Key already exists'));

      const req: any = { user: mockAdminUser };

      await expect(controller.create(createDto, req)).rejects.toThrow();
    });

    it('should return 400 for invalid key format', async () => {
      const invalidCreateDtos = [
        { name: 'Test', slug: 'test', key: 'K' }, // too short
        { name: 'Test', slug: 'test', key: 'KODASOMETHING' }, // too long
        { name: 'Test', slug: 'test', key: 'koda' }, // not uppercase
        { name: 'Test', slug: 'test', key: 'KO-DA' }, // contains hyphen
      ];

      const req: any = { user: mockAdminUser };

      for (const createDto of invalidCreateDtos) {
        mockProjectsService.create.mockRejectedValue(new Error('Invalid key format'));
        await expect(controller.create(createDto, req)).rejects.toThrow();
      }
    });

    it('should validate name minimum length', async () => {
      const createDto = {
        name: 'K', // too short
        slug: 'koda',
        key: 'KODA',
      };

      mockProjectsService.create.mockRejectedValue(new Error('Name too short'));

      const req: any = { user: mockAdminUser };

      await expect(controller.create(createDto, req)).rejects.toThrow();
    });

    it('should validate slug format', async () => {
      const invalidCreateDtos = [
        { name: 'Test', slug: 'KODA', key: 'KODA' }, // not lowercase
        { name: 'Test', slug: 'Koda', key: 'KODA' }, // not lowercase
        { name: 'Test', slug: 'koda_project', key: 'KODA' }, // contains underscore
        { name: 'Test', slug: 'koda project', key: 'KODA' }, // contains space
      ];

      const req: any = { user: mockAdminUser };

      for (const createDto of invalidCreateDtos) {
        mockProjectsService.create.mockRejectedValue(new Error('Invalid slug format'));
        await expect(controller.create(createDto, req)).rejects.toThrow();
      }
    });

    it('should accept optional fields', async () => {
      const createDto = {
        name: 'Minimal Project',
        slug: 'minimal',
        key: 'MIN',
      };

      mockProjectsService.create.mockResolvedValue({
        ...mockProject,
        ...createDto,
      });

      const req: any = { user: mockAdminUser };
      const result = await controller.create(createDto, req);

      expect(result).toBeDefined();
    });
  });

  describe('GET /api/projects', () => {
    it('should return all non-deleted projects', async () => {
      const projects = [mockProject];
      mockProjectsService.findAll.mockResolvedValue(projects);

      const result = await controller.findAll();

      expect(result).toEqual(projects);
      expect(service.findAll).toHaveBeenCalled();
    });

    it('should not include soft-deleted projects', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      const projects = [mockProject]; // deleted project not included

      mockProjectsService.findAll.mockResolvedValue(projects);

      const result = await controller.findAll();

      expect(result).not.toContain(deletedProject);
      expect(service.findAll).toHaveBeenCalled();
    });

    it('should return empty array when no projects exist', async () => {
      mockProjectsService.findAll.mockResolvedValue([]);

      const result = await controller.findAll();

      expect(result).toEqual([]);
    });
  });

  describe('GET /api/projects/:slug', () => {
    it('should return project by slug', async () => {
      mockProjectsService.findBySlug.mockResolvedValue(mockProject);

      const result = await controller.findBySlug('koda');

      expect(result).toEqual(mockProject);
      expect(service.findBySlug).toHaveBeenCalledWith('koda');
    });

    it('should return 404 when project not found', async () => {
      mockProjectsService.findBySlug.mockResolvedValue(null);

      const result = await controller.findBySlug('nonexistent');

      expect(result).toBeNull();
    });

    it('should not return soft-deleted project', async () => {
      mockProjectsService.findBySlug.mockResolvedValue(null);

      const result = await controller.findBySlug('deleted-project');

      expect(result).toBeNull();
    });
  });

  describe('PATCH /api/projects/:slug', () => {
    it('should update project for ADMIN user', async () => {
      const updateDto = {
        name: 'Updated Koda',
        description: 'Updated description',
      };

      const updatedProject = { ...mockProject, ...updateDto };
      mockProjectsService.update.mockResolvedValue(updatedProject);

      const req: any = { user: mockAdminUser };
      const result = await controller.update('koda', updateDto, req);

      expect(result).toEqual(updatedProject);
      expect(service.update).toHaveBeenCalledWith('koda', updateDto);
    });

    it('should reject update from non-ADMIN user with 403', async () => {
      const updateDto = {
        name: 'Updated Koda',
      };

      const req: any = { user: mockMemberUser };

      await expect(controller.update('koda', updateDto, req)).rejects.toThrow();
    });

    it('should return 409 when updating to duplicate slug', async () => {
      const updateDto = {
        slug: 'existing-slug',
      };

      mockProjectsService.update.mockRejectedValue(new Error('Slug already exists'));

      const req: any = { user: mockAdminUser };

      await expect(controller.update('koda', updateDto, req)).rejects.toThrow();
    });

    it('should return 409 when updating to duplicate key', async () => {
      const updateDto = {
        key: 'EXISTING',
      };

      mockProjectsService.update.mockRejectedValue(new Error('Key already exists'));

      const req: any = { user: mockAdminUser };

      await expect(controller.update('koda', updateDto, req)).rejects.toThrow();
    });

    it('should allow updating with same slug and key', async () => {
      const updateDto = {
        name: 'Updated Name',
        slug: 'koda',
        key: 'KODA',
      };

      const updatedProject = { ...mockProject, ...updateDto };
      mockProjectsService.update.mockResolvedValue(updatedProject);

      const req: any = { user: mockAdminUser };
      const result = await controller.update('koda', updateDto, req);

      expect(result).toBeDefined();
    });

    it('should return 404 when project not found', async () => {
      const updateDto = {
        name: 'Updated Name',
      };

      mockProjectsService.update.mockRejectedValue(new Error('Project not found'));

      const req: any = { user: mockAdminUser };

      await expect(controller.update('nonexistent', updateDto, req)).rejects.toThrow();
    });
  });

  describe('DELETE /api/projects/:slug', () => {
    it('should soft delete project for ADMIN user', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockProjectsService.softDelete.mockResolvedValue(deletedProject);

      const req: any = { user: mockAdminUser };
      const result = await controller.remove('koda', req);

      expect(result.deletedAt).not.toBeNull();
      expect(service.softDelete).toHaveBeenCalledWith('koda');
    });

    it('should reject delete from non-ADMIN user with 403', async () => {
      const req: any = { user: mockMemberUser };

      await expect(controller.remove('koda', req)).rejects.toThrow();
    });

    it('should set deletedAt timestamp on soft delete', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockProjectsService.softDelete.mockResolvedValue(deletedProject);

      const req: any = { user: mockAdminUser };
      const result = await controller.remove('koda', req);

      expect(result.deletedAt).not.toBeNull();
      expect(result.deletedAt).toEqual(expect.any(Date));
    });

    it('should not hard delete the project', async () => {
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockProjectsService.softDelete.mockResolvedValue(deletedProject);

      const req: any = { user: mockAdminUser };
      const result = await controller.remove('koda', req);

      expect(result.id).toBe(mockProject.id);
      expect(result).toBeDefined();
    });

    it('should exclude soft-deleted project from list', async () => {
      // First, soft delete
      const deletedProject = { ...mockProject, deletedAt: new Date() };
      mockProjectsService.softDelete.mockResolvedValue(deletedProject);

      // Then, list should not include it
      mockProjectsService.findAll.mockResolvedValue([]);

      const req: any = { user: mockAdminUser };
      await controller.remove('koda', req);

      const result = await controller.findAll();

      expect(result).not.toContainEqual(deletedProject);
    });

    it('should return 404 when project not found', async () => {
      mockProjectsService.softDelete.mockRejectedValue(new Error('Project not found'));

      const req: any = { user: mockAdminUser };

      await expect(controller.remove('nonexistent', req)).rejects.toThrow();
    });
  });

  describe('Authorization', () => {
    it('should reject POST for non-ADMIN with 403', async () => {
      const createDto = {
        name: 'Test',
        slug: 'test',
        key: 'TEST',
      };

      const req: any = { user: mockMemberUser };

      await expect(controller.create(createDto, req)).rejects.toThrow();
    });

    it('should reject PATCH for non-ADMIN with 403', async () => {
      const updateDto = {
        name: 'Updated',
      };

      const req: any = { user: mockMemberUser };

      await expect(controller.update('koda', updateDto, req)).rejects.toThrow();
    });

    it('should reject DELETE for non-ADMIN with 403', async () => {
      const req: any = { user: mockMemberUser };

      await expect(controller.remove('koda', req)).rejects.toThrow();
    });

    it('should allow GET for MEMBER user', async () => {
      mockProjectsService.findAll.mockResolvedValue([mockProject]);

      const result = await controller.findAll();

      expect(result).toBeDefined();
    });

    it('should allow GET by slug for MEMBER user', async () => {
      mockProjectsService.findBySlug.mockResolvedValue(mockProject);

      const result = await controller.findBySlug('koda');

      expect(result).toBeDefined();
    });
  });

  describe('Response DTOs', () => {
    it('should return project response with all fields', async () => {
      mockProjectsService.create.mockResolvedValue(mockProject);

      const createDto = {
        name: 'Koda',
        slug: 'koda',
        key: 'KODA',
        description: 'Dev ticket tracker',
        gitRemoteUrl: 'https://github.com/nathapp-io/koda',
        autoIndexOnClose: true,
      };

      const req: any = { user: mockAdminUser };
      const result = await controller.create(createDto, req);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('slug');
      expect(result).toHaveProperty('key');
      expect(result).toHaveProperty('description');
      expect(result).toHaveProperty('gitRemoteUrl');
      expect(result).toHaveProperty('autoIndexOnClose');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      expect(result).toHaveProperty('deletedAt');
    });
  });
});
