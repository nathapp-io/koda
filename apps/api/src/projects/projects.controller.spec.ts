import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectContext } from './project-context';
import { ProjectAccessService } from './project-access.service';
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
  // US-002: the list route is `findAllForPrincipal(principal)`; the mock carries
  // that member explicitly so these tests type against the finished service.
  let projectsService: jest.Mocked<ProjectsService> & { findAllForPrincipal: jest.Mock };
  let impactAnalysisService: jest.Mocked<ImpactAnalysisService>;
  let agentsService: jest.Mocked<AgentsService>;

  beforeEach(async () => {
    projectsService = {
      create: jest.fn(),
      findAllForPrincipal: jest.fn(),
      findBySlug: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      assertProjectMembership: jest.fn(),
      findMembershipRole: jest.fn(),
      findCiWebhookToken: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService> & { findAllForPrincipal: jest.Mock };

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
        // US-001: the route-level ProjectMembershipGuard is instantiated by the DI
        // container even though these tests call the handlers directly, so its
        // ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
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
    it('scopes the project list to the calling principal', async () => {
      projectsService.findAllForPrincipal.mockResolvedValue([mockProject] as any);

      const result = await controller.findAll(memberPrincipal);

      expect(projectsService.findAllForPrincipal).toHaveBeenCalledWith(memberPrincipal);
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
      projectsService.findAllForPrincipal.mockResolvedValue(
        [ProjectResponseDto.from(projectWithToken)] as any,
      );

      const res = await controller.findAll(adminPrincipal);

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
    // Slice 4: the route is guarded by ProjectMembershipGuard, so the handler
    // receives the guard-resolved ProjectContext instead of a slug+principal.
    const adminCtx: ProjectContext = { project: { id: 'proj-1', slug: 'alpha' }, role: 'ADMIN' };

    it('throws BadRequestException when required params are missing', async () => {
      await expect(
        controller.getChangeImpact('', 'abc123', 'file.ts', adminCtx),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.getChangeImpact('repo-1', '', 'file.ts', adminCtx),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.getChangeImpact('repo-1', 'abc123', '', adminCtx),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls impactAnalysisService with parsed changed files', async () => {
      impactAnalysisService.getChangeImpact.mockResolvedValue({ affected: [] } as any);

      const result = await controller.getChangeImpact(
        'repo-1',
        'abc123',
        'src/auth.ts, src/user.ts',
        adminCtx,
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

    it('US-002 AC1: returns the scoped project roster including agents without tickets', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);
      const data = (result as any).data;

      expect(projectsService.findBySlug).toHaveBeenCalledWith('alpha');
      expect(data.scoping).toBe(true);
      expect(data.items.map((agent: { slug: string }) => agent.slug)).toContain('bot');
    });

    it('US-002 AC2: exposes roster metadata, roles, capabilities, and ticket summary', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);
      const data = (result as any).data;
      const entry = data.items?.[0];

      expect(entry).toMatchObject({
        slug: 'bot',
        status: 'ACTIVE',
        roles: [],
        capabilities: [],
        openTicketCount: 0,
        openTicketRefs: [],
        addedBy: { id: expect.any(String), name: expect.anything() },
      });
      expect(entry?.addedAt).toEqual(expect.any(String));
    });

    it('US-002 AC3: returns null addedBy for backfilled roster entries', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);
      const data = (result as any).data;

      expect(data.items?.[0]?.addedBy).toBeNull();
    });

    it('US-002 AC4: lists only roster entries rather than ticket-derived agents', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);
      const data = (result as any).data;

      expect(data.items).toEqual(expect.any(Array));
      expect(data.items.map((agent: { slug: string }) => agent.slug)).not.toContain('ticket-only-agent');
    });

    it('US-002 AC5: reports open ticket count and oldest-first references', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);
      const data = (result as any).data;
      const entry = data.items?.[0];

      expect(entry?.openTicketCount).toBe(2);
      expect(entry?.openTicketRefs).toEqual(['ALP-1', 'ALP-2']);
    });

    it('US-002 AC6: caps open ticket refs at ten without capping the count', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', adminPrincipal);
      const data = (result as any).data;
      const entry = data.items?.[0];

      expect(entry?.openTicketCount).toBe(12);
      expect(entry?.openTicketRefs).toHaveLength(10);
    });

    it('US-002 AC9: reports roster scoping disabled when the feature flag is off', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', memberPrincipal);

      expect((result as any).data.scoping).toBe(false);
    });

    it('returns agents for a project member', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      projectsService.assertProjectMembership.mockResolvedValue(undefined);
      agentsService.findByProject.mockResolvedValue([mockAgent] as any);

      const result = await controller.getProjectAgents('alpha', memberPrincipal);

      expect((result as any).data).toHaveLength(1);
    });

    it('US-002 AC7: returns forbidden for a non-member user', async () => {
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

    it('US-002 AC10: updates a rostered agent status for admin principal', async () => {
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

    it('US-002 AC11: returns not found for an assigned agent with no roster row', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([mockUpdatedAgent] as any);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

      await expect(
        controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, adminPrincipal),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when agent is not in the project', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([]);

      await expect(
        controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('US-002 AC12: denies an unrostered agent changing its own status', async () => {
      projectsService.findBySlug.mockResolvedValue(mockProject as any);
      agentsService.findByProject.mockResolvedValue([]);

      await expect(
        controller.updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE' }, makeAgentPrincipal('agent-a', 'agent-a')),
      ).rejects.toThrow(ForbiddenAppException);
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
