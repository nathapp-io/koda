import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectResponseDto } from './dto/project-response.dto';

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
  let impactAnalysisService: jest.Mocked<ImpactAnalysisService>;
  let agentsService: jest.Mocked<AgentsService>;

  beforeEach(async () => {
    projectsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findBySlug: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      assertProjectMembership: jest.fn(),
      findMembershipRole: jest.fn(),
      findCiWebhookToken: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService>;

    impactAnalysisService = {
      getChangeImpact: jest.fn(),
    } as unknown as jest.Mocked<ImpactAnalysisService>;

    agentsService = {
      findByProject: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<AgentsService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: projectsService },
        { provide: ImpactAnalysisService, useValue: impactAnalysisService },
        { provide: AgentsService, useValue: agentsService },
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

  describe('H3: ciWebhookToken exposure', () => {
    const projectWithToken = { ...mockProject, ciWebhookToken: 'secret-token' };

    it('H3: list responses do not contain ciWebhookToken', async () => {
      projectsService.findAll.mockResolvedValue(
        [ProjectResponseDto.from(projectWithToken)] as any,
      );

      const res = await controller.findAll();

      expect(JSON.stringify(res)).not.toContain('ciWebhookToken');
      expect(JSON.stringify(res)).not.toContain('secret-token');
    });

    it('H3: findBySlug response does not contain ciWebhookToken', async () => {
      projectsService.findBySlug.mockResolvedValue(
        ProjectResponseDto.from(projectWithToken) as any,
      );

      const res = await controller.findBySlug('alpha');

      expect(JSON.stringify(res)).not.toContain('ciWebhookToken');
      expect(JSON.stringify(res)).not.toContain('secret-token');
    });

    it('H3: admin-only token endpoint returns the token', async () => {
      projectsService.findCiWebhookToken.mockResolvedValue('tok');

      const res = await controller.getCiWebhookToken('alpha');

      expect(projectsService.findCiWebhookToken).toHaveBeenCalledWith('alpha');
      expect((res as any).data.ciWebhookToken).toBe('tok');
    });

    it('H3: admin-only token endpoint returns null when project has no token', async () => {
      projectsService.findCiWebhookToken.mockResolvedValue(null);

      const res = await controller.getCiWebhookToken('alpha');

      expect((res as any).data.ciWebhookToken).toBeNull();
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
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
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
      projectsService.assertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

      await expect(
        controller.getChangeImpact('alpha', 'repo-1', 'abc', 'file.ts', memberPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('getProjectAgents', () => {
    const mockAgent = {
      id: 'agent-1',
      name: 'Bot',
      slug: 'bot',
      status: 'ACTIVE',
      maxConcurrentTickets: 3,
      roles: [],
      capabilities: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('returns agents for a project (admin bypasses membership check)', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);

      expect(projectsService.findBySlug).toHaveBeenCalledWith('alpha');
      expect(agentsService.findByProject).toHaveBeenCalledWith('alpha');
      expect((result as any).data).toHaveLength(1);
      expect((result as any).data[0].slug).toBe('bot');
    });

    it('returns agents for a project member', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', memberPrincipal);

      expect((result as any).data).toHaveLength(1);
    });

    it('throws ForbiddenAppException for non-member', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

      await expect(
        controller.getProjectAgents('alpha', memberPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('allows agent principals without membership check', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', agentPrincipal);

      expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('proj-1', agentPrincipal);
      expect((result as any).data).toHaveLength(1);
    });
  });

  describe('updateProjectAgent', () => {
    const mockUpdatedAgent = {
      id: 'agent-1',
      name: 'Bot',
      slug: 'bot',
      status: 'PAUSED',
      maxConcurrentTickets: 3,
      roles: [],
      capabilities: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const makeAgentPrincipal = (id: string, slug: string): KodaPrincipal => ({
      actorType: 'agent',
      id,
      name: slug,
      slug,
      status: 'ACTIVE',
      agentRoles: ['DEVELOPER'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: ['WORKER'],
    });

    it('updates agent status for admin principal', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([mockUpdatedAgent] as any);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

      const result = await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, adminPrincipal);

      expect(projectsService.findBySlug).toHaveBeenCalledWith('alpha');
      expect(agentsService.update).toHaveBeenCalledWith('bot', { status: 'PAUSED' });
      expect((result as any).data.status).toBe('PAUSED');
    });

    it('propagates 404 when the project does not exist', async () => {
      projectsService.findBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.updateProjectAgent('missing', 'bot', { status: 'PAUSED' }, adminPrincipal),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('H4: allows a project-level ADMIN (global MEMBER with ProjectMember role ADMIN)', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([mockUpdatedAgent] as any);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);
      projectsService.findMembershipRole.mockResolvedValue('ADMIN');

      const result = await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal);

      expect(projectsService.findMembershipRole).toHaveBeenCalledWith('proj-1', 'user-member');
      expect(agentsService.update).toHaveBeenCalledWith('bot', { status: 'PAUSED' });
      expect((result as any).data.status).toBe('PAUSED');
    });

    it('H4: forbids a non-admin user (project member) from updating agent status', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([mockUpdatedAgent] as any);

      await expect(
        controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal),
      ).rejects.toThrow(ForbiddenAppException);
      expect(agentsService.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppException when agent is not in the project', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([]);

      await expect(
        controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('H4: another agent cannot change my status', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([{ ...mockUpdatedAgent, id: 'agent-b', slug: 'agent-b' }] as any);

      await expect(
        controller.updateProjectAgent('alpha', 'agent-b', { status: 'OFFLINE' }, makeAgentPrincipal('agent-a', 'agent-a')),
      ).rejects.toThrow(ForbiddenAppException);
      expect(agentsService.update).not.toHaveBeenCalled();
    });

    it('H4: an agent can set its own status to OFFLINE', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([{ ...mockUpdatedAgent, id: 'agent-a', slug: 'agent-a' }] as any);
      agentsService.update.mockResolvedValue({ ...mockUpdatedAgent, id: 'agent-a', slug: 'agent-a', status: 'OFFLINE' } as any);

      const result = await controller.updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE' }, makeAgentPrincipal('agent-a', 'agent-a'));

      expect(agentsService.update).toHaveBeenCalledWith('agent-a', { status: 'OFFLINE' });
      expect((result as any).data.status).toBe('OFFLINE');
    });
  });
});
