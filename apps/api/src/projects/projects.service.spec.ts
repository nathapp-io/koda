import { ProjectsService } from './projects.service';
import { ProjectAccessService } from './project-access.service';
import { RagService } from '../rag/rag.service';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import type { IProjectRepository } from './domain/project.domain';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let ragService: jest.Mocked<RagService>;
  let mockProjectRepo: any;

  beforeEach(() => {
    mockProjectRepo = {
      findBySlug: jest.fn(),
      findByKey: jest.fn(),
      findAll: jest.fn(),
      createProject: jest.fn(),
      updateBySlug: jest.fn(),
      findAllIds: jest.fn(),
      findMembershipRole: jest.fn(),
    };

    ragService = {
      deleteAllBySourceType: jest.fn(),
    } as any;

    service = new ProjectsService(
      mockProjectRepo as any,
      ragService,
      undefined,
      new ProjectAccessService(mockProjectRepo as any)
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
      mockProjectRepo.findBySlug.mockResolvedValueOnce(mockProject);
      mockProjectRepo.updateBySlug.mockResolvedValueOnce({
        ...mockProject,
        graphifyEnabled: false,
      });

      await service.update('test-project', { graphifyEnabled: false });

      expect(ragService.deleteAllBySourceType).toHaveBeenCalledWith(
        'project-1',
        'code'
      );
    });

    it('should not call deleteAllBySourceType when graphifyEnabled is not present in update payload', async () => {
      mockProjectRepo.findBySlug.mockResolvedValueOnce(mockProject);
      mockProjectRepo.updateBySlug.mockResolvedValueOnce(mockProject);

      await service.update('test-project', { name: 'Updated Name' });

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });

    it('should not call deleteAllBySourceType when graphifyEnabled changes from false to true', async () => {
      const projectWithGraphifyDisabled = {
        ...mockProject,
        graphifyEnabled: false,
      };
      mockProjectRepo.findBySlug.mockResolvedValueOnce(projectWithGraphifyDisabled);
      mockProjectRepo.updateBySlug.mockResolvedValueOnce(mockProject);

      await service.update('test-project', { graphifyEnabled: true });

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });

    it('should not call deleteAllBySourceType when graphifyEnabled is true in both current and update payload', async () => {
      mockProjectRepo.findBySlug.mockResolvedValueOnce(mockProject);
      mockProjectRepo.updateBySlug.mockResolvedValueOnce(mockProject);

      await service.update('test-project', { graphifyEnabled: true });

      expect(ragService.deleteAllBySourceType).not.toHaveBeenCalled();
    });

    it('should log at warn level when deleteAllBySourceType throws, and not re-throw', async () => {
      mockProjectRepo.findBySlug.mockResolvedValueOnce(mockProject);
      mockProjectRepo.updateBySlug.mockResolvedValueOnce({
        ...mockProject,
        graphifyEnabled: false,
      });
      ragService.deleteAllBySourceType.mockRejectedValueOnce(
        new Error('RAG service error')
      );

      const warnSpy = jest.spyOn(service['logger'], 'warn');

      const result = await service.update('test-project', {
        graphifyEnabled: false,
      });

      expect(ragService.deleteAllBySourceType).toHaveBeenCalledWith(
        'project-1',
        'code'
      );
      expect(warnSpy).toHaveBeenCalled();
      expect(result).toBeDefined();

      warnSpy.mockRestore();
    });

    it('should throw NotFoundAppException when project is not found', async () => {
      mockProjectRepo.findBySlug.mockResolvedValueOnce(null);

      await expect(
        service.update('non-existent', { name: 'Updated' })
      ).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('findProjectIdBySlug', () => {
    it('throws NotFoundAppException when project is null', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue(null);
      await expect(service.findProjectIdBySlug('missing')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: new Date(),
      });
      await expect(service.findProjectIdBySlug('proj')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('returns project id for an active project', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: null,
      });
      expect(await service.findProjectIdBySlug('proj')).toBe('p1');
    });
  });

  describe('assertProjectMembership', () => {
    const adminUser: KodaPrincipal = {
      actorType: 'user', id: 'u1', role: 'ADMIN', email: 'a@a.com',
    } as KodaPrincipal;

    const memberUser: KodaPrincipal = {
      actorType: 'user', id: 'u2', role: 'MEMBER', email: 'm@m.com',
    } as KodaPrincipal;

    const agentPrincipal = {
      actorType: 'agent', id: 'ag1', slug: 'agent-1', status: 'ACTIVE',
      agentRoles: [], capabilities: [],
    } as unknown as KodaPrincipal;

    it('passes without checking membership for ADMIN user', async () => {
      await expect(service.assertProjectMembership('p1', adminUser)).resolves.toBeUndefined();
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('passes without checking membership for agent principal', async () => {
      await expect(service.assertProjectMembership('p1', agentPrincipal)).resolves.toBeUndefined();
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('throws ForbiddenAppException when membership role is null', async () => {
      mockProjectRepo.findMembershipRole.mockResolvedValue(null);
      await expect(service.assertProjectMembership('p1', memberUser)).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('resolves when user has a valid membership role', async () => {
      mockProjectRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      await expect(service.assertProjectMembership('p1', memberUser)).resolves.toBeUndefined();
    });
  });

  describe('findAllProjectIds', () => {
    it('delegates to projectRepo.findAllIds and returns the result', async () => {
      const ids = [{ id: 'p1' }, { id: 'p2' }];
      mockProjectRepo.findAllIds.mockResolvedValue(ids);
      expect(await service.findAllProjectIds()).toBe(ids);
    });
  });
});
