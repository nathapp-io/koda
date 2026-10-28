import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectContext } from './project-context';
import { ProjectAccessService } from './project-access.service';
import { ProjectResponseDto } from './dto/project-response.dto';
import { PermissionService } from '../permissions/permission.service';
import { REQUIRES_METADATA, RequiresMetadata } from '../permissions/requires.decorator';

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  name: 'Alpha',
  key: 'ALP',
  description: 'Alpha project',
  // US-001: the response DTO carries the brief; the literal lists every field
  // the controller returns so an added field cannot go unnoticed here.
  brief: null,
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

describe('ProjectsController route permission metadata (US-007)', () => {
  /** Every migrated project, roster and assignee route declares its catalog key with @Requires. */
  const requiresCases: Array<[keyof ProjectsController, string[], 'guard' | 'service']> = [
    ['create', ['project.create'], 'guard'],
    ['findAll', ['project.read'], 'service'],
    ['findBySlug', ['project.read'], 'guard'],
    ['getCiWebhookToken', ['project.ci-token.read'], 'guard'],
    ['update', ['project.update'], 'guard'],
    ['remove', ['project.delete'], 'guard'],
    ['getProjectAgents', ['project.agent.read'], 'guard'],
    ['updateProjectAgent', ['agent.update'], 'service'],
    ['getChangeImpact', ['codeintel.impact.read'], 'guard'],
  ];

  it.each(requiresCases)('%s declares @Requires(%j, enforcedBy %s)', (handler, keys, enforcedBy) => {
    const fn = ProjectsController.prototype[handler] as unknown as object;

    expect(Reflect.getMetadata(REQUIRES_METADATA, fn) as RequiresMetadata).toEqual({
      keys,
      mode: 'all',
      enforcedBy,
    });
    // The legacy decorators are gone from the migrated routes, so only one mechanism decides them.
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });

  /** A route with a `:slug` lists the membership guard first, in the same @UseGuards call. */
  const projectScoped = requiresCases.filter(([handler]) => handler !== 'create' && handler !== 'findAll');

  it.each(projectScoped)('%s runs ProjectMembershipGuard before RequiresGuard', (handler) => {
    const fn = ProjectsController.prototype[handler] as unknown as object;
    const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];

    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });

  it.each(['create', 'findAll'] as Array<keyof ProjectsController>)(
    '%s is a global route: RequiresGuard only, no membership guard',
    (handler) => {
      const fn = ProjectsController.prototype[handler] as unknown as object;
      const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];

      expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual(['RequiresGuard']);
    },
  );

});

describe('ProjectsController', () => {
  let controller: ProjectsController;
  let routeGate: ApprovalRouteGate;
  // US-002: the list route is `findAllForPrincipal(principal)`; the mock carries
  // that member explicitly so these tests type against the finished service.
  let projectsService: Mocked<ProjectsService> & { findAllForPrincipal: Mock };
  let impactAnalysisService: Mocked<ImpactAnalysisService>;
  let agentsService: Mocked<AgentsService>;
  // US-007: the roster PATCH asks `can` instead of reading the legacy project role.
  let permissions: { can: Mock };

  beforeEach(async () => {
    projectsService = {
      create: vi.fn(),
      findAllForPrincipal: vi.fn(),
      findBySlug: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      findCiWebhookToken: vi.fn(),
    } as unknown as Mocked<ProjectsService> & { findAllForPrincipal: Mock };

    impactAnalysisService = {
      getChangeImpact: vi.fn(),
    } as unknown as Mocked<ImpactAnalysisService>;

    agentsService = {
      findByProject: vi.fn(),
      listProjectRoster: vi.fn(),
      isOnProjectRosterBySlug: vi.fn(),
      update: vi.fn(),
    } as unknown as Mocked<AgentsService>;

    permissions = { can: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ApprovalRouteGate, useValue: { run: vi.fn().mockResolvedValue({ status: 'executed', result: mockProject }) } },
        { provide: ProjectsService, useValue: projectsService },
        { provide: ImpactAnalysisService, useValue: impactAnalysisService },
        { provide: AgentsService, useValue: agentsService },
        // US-001: the route-level ProjectMembershipGuard is instantiated by the DI
        // container even though these tests call the handlers directly, so its
        // ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
        // US-007: the controller's own key check, and the route-level RequiresGuard.
        { provide: PermissionService, useValue: permissions },
      ],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
    routeGate = module.get(ApprovalRouteGate);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('creates a project and wraps response', async () => {
      projectsService.create.mockResolvedValue(mockProject as any);

      const result = await controller.create({ name: 'Alpha', slug: 'alpha', key: 'ALP' } as any);

      expect(routeGate.run).toHaveBeenCalledExactlyOnceWith({
        key: 'project.create',
        variant: 'rest:projects.create',
        projectId: null,
        input: { name: 'Alpha', slug: 'alpha', key: 'ALP' },
      });
      expect(projectsService.create).not.toHaveBeenCalled();
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
    it.each(['a'.repeat(32), null])('keeps token-changing mixed patches out of approvals (%s)', async (ciWebhookToken) => {
      projectsService.update.mockResolvedValue(mockProject as any);
      const patch = { name: 'Updated', ciWebhookToken };
      await controller.update('alpha', patch as any, { project: { id: 'proj-1', slug: 'alpha' } });
      expect(routeGate.run).not.toHaveBeenCalled();
      expect(projectsService.update).toHaveBeenCalledExactlyOnceWith('alpha', patch);
    });
    it('updates a project', async () => {
      projectsService.update.mockResolvedValue({ ...mockProject, name: 'Updated' } as any);

      const projectContext: ProjectContext = { project: { id: 'proj-1', slug: 'alpha' } };
      const result = await controller.update('alpha', { name: 'Updated' } as any, projectContext);

      expect(routeGate.run).toHaveBeenCalledExactlyOnceWith({
        key: 'project.update',
        variant: 'rest:projects.update',
        projectId: 'proj-1',
        input: { slug: 'alpha', patch: { name: 'Updated' } },
      });
      expect(projectsService.update).not.toHaveBeenCalled();
      expect((result as any).data).toEqual(mockProject);
    });
  });

  describe('remove', () => {
    it('gates project deletion with the guard-resolved project id', async () => {
      expect(await controller.remove('alpha', { project: { id: 'proj-1', slug: 'alpha' } })).toBeUndefined();
      expect(routeGate.run).toHaveBeenCalledExactlyOnceWith({ key: 'project.delete', variant: 'rest:projects.delete', projectId: 'proj-1', input: { slug: 'alpha', projectId: 'proj-1' } });
      expect(projectsService.softDelete).not.toHaveBeenCalled();
    });
  });


  describe('getChangeImpact', () => {
    // Slice 4: the route is guarded by ProjectMembershipGuard, so the handler
    // receives the guard-resolved ProjectContext instead of a slug+principal.
    const adminCtx: ProjectContext = { project: { id: 'proj-1', slug: 'alpha' } };

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
    const mockAddedAt = new Date('2026-10-01T00:00:00.000Z');

    const makeRosterDto = (over: {
      slug?: string;
      name?: string;
      status?: string;
      capabilities?: string[];
      openTicketCount?: number;
      openTicketRefs?: string[];
      addedById?: string | null;
      addedByName?: string | null;
    } = {}) => {
      const addedById = over.addedById === undefined ? null : over.addedById;
      return {
        slug: over.slug ?? 'bot',
        name: over.name ?? 'Bot',
        status: over.status ?? 'ACTIVE',
        capabilities: over.capabilities ?? [],
        openTicketCount: over.openTicketCount ?? 0,
        openTicketRefs: over.openTicketRefs ?? [],
        addedAt: mockAddedAt.toISOString(),
        addedBy: addedById ? { id: addedById, name: over.addedByName ?? null } : null,
      };
    };

    it('US-006: returns { items } alone, including agents without tickets', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto()],
      } as any);

      const result = await controller.getProjectAgents('alpha');
      const data = (result as any).data;

      expect(agentsService.listProjectRoster).toHaveBeenCalledWith('alpha');
      // `scoping` was always true, so the envelope is the items alone.
      expect(Object.keys(data)).toEqual(['items']);
      expect(data.items.map((agent: { slug: string }) => agent.slug)).toContain('bot');
    });

    it('US-006: exposes roster metadata, capabilities and the ticket summary, with no roles', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto({ addedById: 'user-admin', addedByName: 'admin@example.com' })],
      } as any);

      const result = await controller.getProjectAgents('alpha');
      const data = (result as any).data;
      const entry = data.items?.[0];

      expect(entry).toMatchObject({
        slug: 'bot',
        status: 'ACTIVE',
        capabilities: [],
        openTicketCount: 0,
        openTicketRefs: [],
        addedBy: { id: expect.any(String), name: expect.anything() },
      });
      expect(entry).not.toHaveProperty('roles');
      expect(entry?.addedAt).toEqual(expect.any(String));
    });

    it('US-002 AC3: returns null addedBy for backfilled roster entries', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto({ addedById: null, addedByName: null })],
      } as any);

      const result = await controller.getProjectAgents('alpha');
      const data = (result as any).data;

      expect(data.items?.[0]?.addedBy).toBeNull();
    });

    it('US-002 AC4: lists only roster entries rather than ticket-derived agents', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto({ slug: 'bot' })],
      } as any);

      const result = await controller.getProjectAgents('alpha');
      const data = (result as any).data;

      expect(data.items).toEqual(expect.any(Array));
      expect(data.items.map((agent: { slug: string }) => agent.slug)).not.toContain('ticket-only-agent');
    });

    it('US-002 AC5: reports open ticket count and oldest-first references', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto({ openTicketCount: 2, openTicketRefs: ['ALP-1', 'ALP-2'] })],
      } as any);

      const result = await controller.getProjectAgents('alpha');
      const data = (result as any).data;
      const entry = data.items?.[0];

      expect(entry?.openTicketCount).toBe(2);
      expect(entry?.openTicketRefs).toEqual(['ALP-1', 'ALP-2']);
    });

    it('US-002 AC6: caps open ticket refs at ten without capping the count', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto({ openTicketCount: 12, openTicketRefs: Array.from({ length: 10 }, (_, i) => `ALP-${i + 1}`) })],
      } as any);

      const result = await controller.getProjectAgents('alpha');
      const data = (result as any).data;
      const entry = data.items?.[0];

      expect(entry?.openTicketCount).toBe(12);
      expect(entry?.openTicketRefs).toHaveLength(10);
    });

    it('returns agents for a project member', async () => {
      agentsService.listProjectRoster.mockResolvedValue({
        items: [makeRosterDto()],
      } as any);

      const result = await controller.getProjectAgents('alpha');

      expect((result as any).data.items).toHaveLength(1);
    });

    // US-007: the handler no longer asserts membership or looks the project up — ProjectMembershipGuard
    // plus `project.agent.read` decide, and the guard's 403/404 is covered over HTTP by
    // test/integration/permissions/core-project-routes.integration.spec.ts (AC-3 .. AC-5).
    it('US-007: reads the roster without a project lookup or a membership assertion', async () => {
      agentsService.listProjectRoster.mockResolvedValue({ items: [makeRosterDto()] } as any);

      await controller.getProjectAgents('alpha');

      expect(projectsService.findBySlug).not.toHaveBeenCalled();
    });
  });

  describe('updateProjectAgent', () => {
    const mockUpdatedAgent = {
      id: 'agent-1',
      name: 'Bot',
      slug: 'bot',
      status: 'PAUSED',
      maxConcurrentTickets: 3,
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

    // US-007 / US-001: `isAdmin` is the `can` answer for `agent.update`, so every case states it.
    const projectCtx: ProjectContext = { project: { id: 'proj-1', slug: 'alpha' } };
    const canAllow = () => permissions.can.mockResolvedValue({ allowed: true, reason: 'granted' });
    const canDeny = () => permissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

    it('US-002 AC10: updates a rostered agent status when the caller holds the key', async () => {
      canAllow();
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(true);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

      const result = await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, adminPrincipal, projectCtx);

      expect(permissions.can).toHaveBeenCalledWith(adminPrincipal, 'agent.update');
      expect(agentsService.isOnProjectRosterBySlug).toHaveBeenCalledWith('alpha', 'bot');
      expect(agentsService.update).toHaveBeenCalledWith('bot', { status: 'PAUSED' });
      expect((result as any).data.status).toBe('PAUSED');
    });

    it('US-001 AC-6: asks can exactly once, with exactly the two arguments (principal, agent.update)', async () => {
      canAllow();
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(true);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

      await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, adminPrincipal, projectCtx);

      expect(permissions.can).toHaveBeenCalledTimes(1);
      expect(permissions.can).toHaveBeenCalledWith(adminPrincipal, 'agent.update');
      expect(permissions.can.mock.calls[0]).toHaveLength(2);
    });

    it('US-007: a caller holding agent.update is admitted by its can answer', async () => {
      canAllow();
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(true);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

      const result = await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal, projectCtx);

      expect(permissions.can).toHaveBeenCalledWith(memberPrincipal, 'agent.update');
      expect(projectsService.findBySlug).not.toHaveBeenCalled();
      expect((result as any).data.status).toBe('PAUSED');
    });

    it('US-007: refuses a caller whose can answer is denied and is not the agent, with 403 permissions', async () => {
      canDeny();
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(true);

      const refusal = controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal, projectCtx);

      await expect(refusal).rejects.toThrow(ForbiddenAppException);
      // The refusal is the key's, not the old `projects` membership one.
      await expect(refusal).rejects.toMatchObject({ prefix: 'permissions' });
      expect(agentsService.update).not.toHaveBeenCalled();
    });

    it('US-002 AC11: returns not found for an assigned agent with no roster row', async () => {
      // The roster is empty: an agent that was assigned tickets is no longer in
      // scope through this route because it has no roster source.
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(false);
      agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

      await expect(
        controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, adminPrincipal, projectCtx),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when agent is not in the project', async () => {
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(false);

      await expect(
        controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal, projectCtx),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('US-002 AC12: denies an unrostered agent changing its own status', async () => {
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(false);

      await expect(
        controller.updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE' }, makeAgentPrincipal('agent-a', 'agent-a'), projectCtx),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('H4: another agent cannot change my status', async () => {
      canDeny();
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(true);

      await expect(
        controller.updateProjectAgent('alpha', 'agent-b', { status: 'OFFLINE' }, makeAgentPrincipal('agent-a', 'agent-a'), projectCtx),
      ).rejects.toThrow(ForbiddenAppException);
      expect(agentsService.update).not.toHaveBeenCalled();
    });

    it('H4: an agent can set its own status to OFFLINE without the key', async () => {
      canDeny();
      agentsService.isOnProjectRosterBySlug.mockResolvedValue(true);
      agentsService.update.mockResolvedValue({ ...mockUpdatedAgent, id: 'agent-a', slug: 'agent-a', status: 'OFFLINE' } as any);

      const result = await controller.updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE' }, makeAgentPrincipal('agent-a', 'agent-a'), projectCtx);

      expect(agentsService.update).toHaveBeenCalledWith('agent-a', { status: 'OFFLINE' });
      expect((result as any).data.status).toBe('OFFLINE');
    });
  });
});
