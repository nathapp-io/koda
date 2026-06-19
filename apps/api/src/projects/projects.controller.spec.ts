import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  name: 'Alpha',
  key: 'ALP',
  description: 'Alpha project',
  gitRemoteUrl: null,
  autoIndexOnClose: true,
  autoAssign: 'OFF',
  ciWebhookToken: null,
  graphifyEnabled: false,
  graphifyLastImportedAt: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const adminPrincipal: KodaPrincipal = {
  actorType: 'user',
  id: 'user-admin',
  name: 'admin@example.com',
  email: 'admin@example.com',
  role: 'ADMIN',
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
  extra: { sub: 'user-admin' },
};

const memberPrincipal: KodaPrincipal = {
  actorType: 'user',
  id: 'user-member',
  name: 'member@example.com',
  email: 'member@example.com',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
  extra: { sub: 'user-member' },
};

const agentPrincipal: KodaPrincipal = {
  actorType: 'agent',
  id: 'agent-1',
  name: 'bot',
  slug: 'bot',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};

describe('ProjectsController', () => {
  let controller: ProjectsController;
  let projectsService: jest.Mocked<ProjectsService>;
  let memoryItemRepository: jest.Mocked<PrismaMemoryItemRepository>;
  let impactAnalysisService: jest.Mocked<ImpactAnalysisService>;

  const mockProjectMemberFindUnique = jest.fn();
  const mockPrismaClient = {
    projectMember: { findUnique: mockProjectMemberFindUnique },
  };
  const mockPrismaService = { client: mockPrismaClient };

  beforeEach(async () => {
    projectsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findBySlug: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService>;

    memoryItemRepository = {
      findByProjectMemory: jest.fn(),
    } as unknown as jest.Mocked<PrismaMemoryItemRepository>;

    impactAnalysisService = {
      getChangeImpact: jest.fn(),
    } as unknown as jest.Mocked<ImpactAnalysisService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: projectsService },
        { provide: PrismaMemoryItemRepository, useValue: memoryItemRepository },
        { provide: ImpactAnalysisService, useValue: impactAnalysisService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a project and wraps response', async () => {
      projectsService.create.mockResolvedValue(mockProject as any);

      const result = await controller.create({ name: 'Alpha', slug: 'alpha', key: 'ALP' } as any);

      expect(projectsService.create).toHaveBeenCalled();
      expect((result as any).data).toEqual(mockProject);
    });
  });

  describe('findAll', () => {
    it('returns all projects', async () => {
      projectsService.findAll.mockResolvedValue([mockProject] as any);

      const result = await controller.findAll();

      expect(projectsService.findAll).toHaveBeenCalled();
      expect((result as any).data).toHaveLength(1);
    });
  });

  describe('findBySlug', () => {
    it('returns a project by slug', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);

      const result = await controller.findBySlug('alpha');

      expect(projectsService.findBySlug).toHaveBeenCalledWith('alpha');
      expect((result as any).data.slug).toBe('alpha');
    });

    it('propagates rejection when project not found', async () => {
      projectsService.findBySlug.mockRejectedValue(new Error('Not found'));

      await expect(controller.findBySlug('missing')).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('updates a project', async () => {
      projectsService.update.mockResolvedValue({ ...mockProject, name: 'Updated' } as any);

      const result = await controller.update('alpha', { name: 'Updated' } as any);

      expect(projectsService.update).toHaveBeenCalledWith('alpha', { name: 'Updated' });
      expect((result as any).data.name).toBe('Updated');
    });
  });

  describe('remove', () => {
    it('soft-deletes a project', async () => {
      projectsService.softDelete.mockResolvedValue(undefined);

      await controller.remove('alpha');

      expect(projectsService.softDelete).toHaveBeenCalledWith('alpha');
    });
  });

  describe('getProjectMemory', () => {
    it('allows admin without membership check', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      memoryItemRepository.findByProjectMemory.mockResolvedValue({ total: 0, items: [] } as any);

      const result = await controller.getProjectMemory('alpha', {}, adminPrincipal);

      expect(mockProjectMemberFindUnique).not.toHaveBeenCalled();
      expect((result as any).data.total).toBe(0);
    });

    it('allows agent without membership row check', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      memoryItemRepository.findByProjectMemory.mockResolvedValue({ total: 1, items: [] } as any);

      const result = await controller.getProjectMemory('alpha', {}, agentPrincipal);

      expect(mockProjectMemberFindUnique).not.toHaveBeenCalled();
      expect((result as any).data.total).toBe(1);
    });

    it('forbids member without project membership', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      mockProjectMemberFindUnique.mockResolvedValue(null);

      await expect(
        controller.getProjectMemory('alpha', {}, memberPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('allows member with valid project role', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
      memoryItemRepository.findByProjectMemory.mockResolvedValue({
        total: 2,
        items: [
          {
            id: 'm1',
            projectId: 'proj-1',
            kind: 'FACT',
            subject: 'auth',
            predicate: 'is',
            object: 'JWT',
            confidence: 0.9,
            supersededBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      } as any);

      const result = await controller.getProjectMemory('alpha', { kind: 'FACT' }, memberPrincipal);

      expect((result as any).data.total).toBe(2);
      expect((result as any).data.items).toHaveLength(1);
    });

    it('maps memory items to response shape', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'ADMIN' });

      const mockItem = {
        id: 'm1',
        projectId: 'proj-1',
        kind: 'DECISION',
        subject: 'db',
        predicate: 'is',
        object: 'postgres',
        confidence: 1,
        supersededBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      memoryItemRepository.findByProjectMemory.mockResolvedValue({ total: 1, items: [mockItem] } as any);

      const result = await controller.getProjectMemory('alpha', {}, memberPrincipal);

      const item = (result as any).data.items[0];
      expect(item).toMatchObject({
        id: 'm1',
        kind: 'DECISION',
        subject: 'db',
      });
    });
  });

  describe('getChangeImpact', () => {
    it('throws BadRequestException when required params are missing', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);

      await expect(
        controller.getChangeImpact('alpha', '', 'abc123', 'file.ts', adminPrincipal),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.getChangeImpact('alpha', 'repo-1', '', 'file.ts', adminPrincipal),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.getChangeImpact('alpha', 'repo-1', 'abc123', '', adminPrincipal),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls impactAnalysisService with parsed changed files', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'ADMIN' });
      impactAnalysisService.getChangeImpact.mockResolvedValue({ affected: [] } as any);

      const result = await controller.getChangeImpact(
        'alpha',
        'repo-1',
        'abc123',
        'src/auth.ts, src/user.ts',
        adminPrincipal,
        'ticket-1',
      );

      expect(impactAnalysisService.getChangeImpact).toHaveBeenCalledWith({
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts', 'src/user.ts'],
        ticketId: 'ticket-1',
      });
      expect((result as any).data).toEqual({ affected: [] });
    });

    it('forbids member without membership', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      mockProjectMemberFindUnique.mockResolvedValue(null);

      await expect(
        controller.getChangeImpact('alpha', 'repo-1', 'abc', 'file.ts', memberPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
    });
  });
});
