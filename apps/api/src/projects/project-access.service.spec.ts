import { ProjectAccessService } from './project-access.service';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

describe('ProjectAccessService', () => {
  let service: ProjectAccessService;
  let mockProjectRepo: any;

  beforeEach(() => {
    mockProjectRepo = {
      findBySlug: jest.fn(),
      findMembershipRole: jest.fn(),
    };

    service = new ProjectAccessService(mockProjectRepo as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
});
