import { HttpException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectAccessService } from './project-access.service';
import { RagService } from '../rag/rag.service';
import {
  NotFoundAppException,
  ForbiddenAppException,
  ValidationAppException,
} from '@nathapp/nestjs-common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { IProjectRepository } from './domain/project.domain';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

/** The rejection of `promise`, or undefined when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<HttpException | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
}

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
      isAgentOnRoster: jest.fn(),
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

    it('passes a rostered agent principal without a membership lookup', async () => {
      mockProjectRepo.isAgentOnRoster.mockResolvedValue(true);
      await expect(service.assertProjectMembership('p1', agentPrincipal)).resolves.toBeUndefined();
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('refuses an agent principal absent from the project roster', async () => {
      mockProjectRepo.isAgentOnRoster.mockResolvedValue(false);
      await expect(service.assertProjectMembership('p1', agentPrincipal)).rejects.toBeInstanceOf(ForbiddenAppException);
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

  describe('findCiWebhookToken (H3)', () => {
    it('throws NotFoundAppException when project is null', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue(null);
      await expect(service.findCiWebhookToken('missing')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: new Date(),
      });
      await expect(service.findCiWebhookToken('proj')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('returns the token for an active project', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: null, ciWebhookToken: 'tok',
      });
      expect(await service.findCiWebhookToken('proj')).toBe('tok');
    });

    it('returns null when project has no token', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: null, ciWebhookToken: null,
      });
      expect(await service.findCiWebhookToken('proj')).toBeNull();
    });
  });

  // US-004: a duplicate slug/key is a 409 state conflict, not a 400 validation
  // error, and updating a soft-deleted project is a 404 — the same AppException
  // types the HTTP layer maps to those statuses.
  describe('US-004: conflict and soft-delete responses', () => {
    const activeProject = {
      id: 'project-1',
      slug: 'alpha',
      name: 'Alpha',
      key: 'ALPH',
      description: null,
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

    const otherProject = {
      ...activeProject,
      id: 'project-2',
      slug: 'other',
      key: 'OTHR',
    };

    describe('create', () => {
      it('AC1: throws ConflictAppException (409) when the slug already exists', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue(otherProject);

        const error = await rejectionOf(service.create({ name: 'Beta', slug: 'other', key: 'BETA' }));

        expect(error).toBeInstanceOf(ConflictAppException);
        expect(error?.getStatus()).toBe(409);
        expect(mockProjectRepo.createProject).not.toHaveBeenCalled();
      });

      it('AC2: throws ConflictAppException (409) when the key already exists', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue(null);
        mockProjectRepo.findByKey.mockResolvedValue(otherProject);

        const error = await rejectionOf(service.create({ name: 'Beta', slug: 'beta', key: 'OTHR' }));

        expect(error).toBeInstanceOf(ConflictAppException);
        expect(error?.getStatus()).toBe(409);
        expect(mockProjectRepo.createProject).not.toHaveBeenCalled();
      });

      it('keeps invalid-format validation at 400 (ValidationAppException)', async () => {
        const error = await rejectionOf(service.create({ name: 'Beta', slug: 'Not-A-Slug', key: 'BETA' }));

        expect(error).toBeInstanceOf(ValidationAppException);
        expect(error?.getStatus()).toBe(400);
      });

      it('creates the project when slug and key are free', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue(null);
        mockProjectRepo.findByKey.mockResolvedValue(null);
        mockProjectRepo.createProject.mockResolvedValue(activeProject);

        await expect(service.create({ name: 'Alpha', slug: 'alpha', key: 'ALPH' })).resolves.toMatchObject({
          slug: 'alpha',
          key: 'ALPH',
        });
      });
    });

    describe('update', () => {
      it('AC3: throws NotFoundAppException (404) when the project is soft-deleted', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ ...activeProject, deletedAt: new Date() });
        // Keeps the RED run on an assertion: an implementation without the
        // soft-delete guard resolves here instead of throwing.
        mockProjectRepo.updateBySlug.mockResolvedValue(activeProject);

        const error = await rejectionOf(service.update('alpha', { name: 'Renamed' }));

        expect(error).toBeInstanceOf(NotFoundAppException);
        expect(error?.getStatus()).toBe(404);
        expect(mockProjectRepo.updateBySlug).not.toHaveBeenCalled();
      });

      it('AC15: throws ConflictAppException (409) when the requested slug belongs to another project', async () => {
        mockProjectRepo.findBySlug.mockImplementation(async (slug: string) =>
          slug === 'alpha' ? activeProject : otherProject,
        );
        mockProjectRepo.updateBySlug.mockResolvedValue(activeProject);

        const error = await rejectionOf(service.update('alpha', { slug: 'other' }));

        expect(error).toBeInstanceOf(ConflictAppException);
        expect(error?.getStatus()).toBe(409);
        expect(mockProjectRepo.updateBySlug).not.toHaveBeenCalled();
      });

      it('AC15: throws ConflictAppException (409) when the requested key belongs to another project', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue(activeProject);
        mockProjectRepo.findByKey.mockResolvedValue(otherProject);
        mockProjectRepo.updateBySlug.mockResolvedValue(activeProject);

        const error = await rejectionOf(service.update('alpha', { key: 'OTHR' }));

        expect(error).toBeInstanceOf(ConflictAppException);
        expect(error?.getStatus()).toBe(409);
        expect(mockProjectRepo.updateBySlug).not.toHaveBeenCalled();
      });

      it('allows re-submitting the project’s own slug and key', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue(activeProject);
        mockProjectRepo.findByKey.mockResolvedValue(activeProject);
        mockProjectRepo.updateBySlug.mockResolvedValue(activeProject);

        await expect(service.update('alpha', { slug: 'alpha', key: 'ALPH' })).resolves.toBeDefined();
        expect(mockProjectRepo.updateBySlug).toHaveBeenCalled();
      });
    });
  });

  describe('#145 dead code', () => {
    it('has no unscoped findAll (findAllForPrincipal is the only list method)', () => {
      expect('findAll' in ProjectsService.prototype).toBe(false);
      expect(typeof ProjectsService.prototype.findAllForPrincipal).toBe('function');
    });
  });
});
