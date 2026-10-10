import { Test, TestingModule } from '@nestjs/testing';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { PERMISSION_KEY, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { ValidationAppException, ForbiddenAppException, Page } from '@nathapp/nestjs-common';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { PROJECT_PERMISSION_KEY } from '../projects/project-permission.decorator';
import { withProjectRole } from '../projects/project-context';
import { ProjectsService } from '../projects/projects.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { TransitionWithCommentDto } from './dto/transition-with-comment.dto';

describe('TicketsController', () => {
  let controller: TicketsController;
  let service: TicketsService;

  const mockProjectsService = {
    findProjectIdBySlug: vi.fn().mockResolvedValue('proj-123'),
    assertProjectMembership: vi.fn().mockResolvedValue(undefined),
  };

  const _mockProject = {
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

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: 'Users cannot login',
    status: 'CREATED',
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: 'user-123',
    createdByAgentId: null,
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    gitRefUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    links: [],
  };

  const mockAdminUser = {
    actorType: 'user' as const,
    id: 'user-123',
    name: 'admin@example.com',
    email: 'admin@example.com',
    role: 'ADMIN' as const,
    blacklisted: false,
    revoked: false,
    authorities: ['ADMIN'],
    extra: {
      sub: 'user-123',
    },
  };

  const mockMemberUser = {
    actorType: 'user' as const,
    id: 'user-456',
    name: 'member@example.com',
    email: 'member@example.com',
    role: 'MEMBER' as const,
    blacklisted: false,
    revoked: false,
    authorities: ['MEMBER'],
    extra: {
      sub: 'user-456',
    },
  };

  const mockAgent = {
    actorType: 'agent' as const,
    id: 'agent-123',
    name: 'test-agent',
    slug: 'test-agent',
    status: 'ACTIVE' as const,
    agentRoles: ['DEVELOPER'] as const,
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: ['WORKER'],
  };

  const mockTicketsService = {
    create: vi.fn(),
    findAll: vi.fn(),
    findByRef: vi.fn(),
    findByRefWithActions: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    assign: vi.fn(),
  };

  // ProjectContext a global-ADMIN caller would receive from ProjectMembershipGuard.
  const adminProject = { project: { id: 'proj-1', slug: 'koda' }, role: 'ADMIN' };

  const mockTransitionsService = {
    verify: vi.fn(),
    start: vi.fn(),
    fix: vi.fn(),
    verifyFix: vi.fn(),
    close: vi.fn(),
    reject: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [
        { provide: TicketsService, useValue: mockTicketsService },
        { provide: TicketTransitionsService, useValue: mockTransitionsService },
        { provide: ProjectsService, useValue: mockProjectsService },
        // US-001: the class-level ProjectMembershipGuard is instantiated by the DI
        // container even though these tests call the handlers directly, so its
        // ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
      ],
    }).compile();

    controller = module.get<TicketsController>(TicketsController);
    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/projects/:slug/tickets', () => {
    it('should create ticket with 201 status', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix login bug',
        description: 'Users cannot login',
        priority: 'HIGH',
      };

      mockTicketsService.create.mockResolvedValue(mockTicket);

      const result = await controller.createTicket('koda', createDto, mockAdminUser);

      expect(result).toEqual(mockTicket);
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAdminUser);
    });

    it('should allow member to create ticket', async () => {
      const createDto: CreateTicketDto = {
        type: 'ENHANCEMENT',
        title: 'Add feature',
        priority: 'MEDIUM',
      };

      mockTicketsService.create.mockResolvedValue(mockTicket);

      const result = await controller.createTicket('koda', createDto, mockMemberUser);

      expect(result).toBeDefined();
      expect(service.create).toHaveBeenCalled();
    });

    it('should allow agent to create ticket', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
        priority: 'HIGH',
      };

      mockTicketsService.create.mockResolvedValue({
        ...mockTicket,
        createdByAgentId: 'agent-123',
        createdByUserId: null,
      });

      const result = await controller.createTicket('koda', createDto, mockAgent);

      expect(result).toBeDefined();
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAgent);
    });

    it('should validate DTO fields', async () => {
      const invalidDtos = [
        { description: 'Missing type' }, // Missing required field
        { type: 'INVALID', title: 'Test' }, // Invalid type enum
      ];

      mockTicketsService.create.mockRejectedValue(new Error('Validation error'));

      for (const invalidDto of invalidDtos) {
        await expect(
          controller.createTicket('koda', invalidDto as CreateTicketDto, mockAdminUser)
        ).rejects.toThrow();
      }
    });

    it('should return 404 if project not found', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Test',
        priority: 'MEDIUM',
      };

      mockTicketsService.create.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.createTicket('nonexistent', createDto, mockAdminUser)
      ).rejects.toThrow();
    });
  });

  describe('GET /projects/:slug/tickets', () => {
    it('parses the raw query into numbers and defaults before calling the service', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

      await controller.findAll('koda', { current: '2', size: '5', status: 'IN_PROGRESS' } as never);

      expect(mockTicketsService.findAll).toHaveBeenCalledWith(
        'koda',
        expect.objectContaining({ status: 'IN_PROGRESS' }),
        { current: 2, size: 5 },
      );
    });

    it('defaults to page 1 of 20 when no paging params are sent', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

      await controller.findAll('koda', {} as never);

      expect(mockTicketsService.findAll).toHaveBeenCalledWith('koda', expect.anything(), { current: 1, size: 20 });
    });

    it('returns only the six page fields', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, [{ ref: 'KODA-1' }]));

      const res = await controller.findAll('koda', {} as never);

      expect(Object.keys(res.data).sort()).toEqual(['current', 'hasNext', 'hasPrev', 'records', 'size', 'total']);
    });

    it('assignedTo=self resolves to the calling user', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
      const user = { actorType: 'user', id: 'user-7', role: 'MEMBER', email: 'u@k.t' } as never;

      await controller.findAll('koda', { assignedTo: 'self' } as never, user);

      const filters = mockTicketsService.findAll.mock.calls[0][1];
      expect(filters.assignedTo).toBe('user-7');
      expect(filters.assignedToAgentId).toBeUndefined();
    });

    it('assignedTo=self resolves to the calling agent', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
      const agent = { actorType: 'agent', id: 'agent-3', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [] } as never;

      await controller.findAll('koda', { assignedTo: 'self' } as never, agent);

      const filters = mockTicketsService.findAll.mock.calls[0][1];
      expect(filters.assignedTo).toBeUndefined();
      expect(filters.assignedToAgentId).toBe('agent-3');
    });

    it('any other assignedTo value passes through unchanged', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
      await controller.findAll('koda', { assignedTo: 'user-9' } as never, { actorType: 'user', id: 'user-7' } as never);
      expect(mockTicketsService.findAll.mock.calls[0][1].assignedTo).toBe('user-9');
    });
  });

  describe('GET /api/projects/:slug/tickets/:ref', () => {
    it('should return ticket by KODA-42 reference', async () => {
      mockTicketsService.findByRef.mockResolvedValue(mockTicket);

      const result = await controller.getTicket('koda', 'KODA-1');

      expect(result).toEqual(mockTicket);
      expect(service.findByRef).toHaveBeenCalledWith('koda', 'KODA-1');
    });

    it('should return ticket by CUID reference', async () => {
      mockTicketsService.findByRef.mockResolvedValue(mockTicket);

      const result = await controller.getTicket('koda', 'ticket-123');

      expect(result).toEqual(mockTicket);
      expect(service.findByRef).toHaveBeenCalledWith('koda', 'ticket-123');
    });

    it('should propagate rejection if ticket not found', async () => {
      mockTicketsService.findByRef.mockRejectedValue(new Error('Ticket not found'));

      await expect(controller.getTicket('koda', 'KODA-999')).rejects.toThrow();
    });

    it('should return 404 if project not found', async () => {
      mockTicketsService.findByRef.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.getTicket('nonexistent', 'KODA-1')
      ).rejects.toThrow();
    });
  });

  describe('GET :ref (M25 allowedActions)', () => {
    it('GET :ref returns allowedActions computed for the enriched principal', async () => {
      mockTicketsService.findByRefWithActions.mockResolvedValue({ id: 't1', allowedActions: ['start'] });
      const res = await controller.findByRef('koda', 'KODA-1', mockMemberUser, { project: { id: 'p1', slug: 'koda' }, role: 'DEVELOPER' });
      expect(mockTicketsService.findByRefWithActions).toHaveBeenCalledWith('koda', 'KODA-1', { ...mockMemberUser, projectRole: 'DEVELOPER' });
      expect(res).toEqual(expect.objectContaining({ data: { id: 't1', allowedActions: ['start'] } }));
    });
  });

  describe('PATCH /api/projects/:slug/tickets/:ref', () => {
    it('should update ticket', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title',
        priority: 'CRITICAL',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        title: 'Updated title',
        priority: 'CRITICAL',
      });

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockAdminUser);

      expect((result as any).title).toBe('Updated title');
      expect((result as any).priority).toBe('CRITICAL');
      expect(service.update).toHaveBeenCalledWith('koda', 'KODA-1', updateDto, mockAdminUser);
    });

    it('should allow member to update ticket', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated by member',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        title: 'Updated by member',
      });

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockMemberUser);

      expect((result as any).title).toBe('Updated by member');
    });

    it('should allow agent to update ticket', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated by agent',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        title: 'Updated by agent',
      });

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockAgent);

      expect((result as any).title).toBe('Updated by agent');
    });

    it('should support partial updates', async () => {
      const updateDto: UpdateTicketDto = {
        priority: 'MEDIUM',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        priority: 'MEDIUM',
      });

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockAdminUser);

      expect((result as any).priority).toBe('MEDIUM');
    });

    it('should return 404 if ticket not found', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated',
      };

      mockTicketsService.update.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.updateTicket('koda', 'KODA-999', updateDto, mockAdminUser)
      ).rejects.toThrow();
    });
  });

  describe('DELETE /api/projects/:slug/tickets/:ref', () => {
    it('should soft-delete ticket for ADMIN user', async () => {
      mockTicketsService.softDelete.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      const result = await controller.deleteTicket('koda', 'KODA-1', mockAdminUser);

      expect((result as any).deletedAt).not.toBeNull();
      expect(service.softDelete).toHaveBeenCalledWith('koda', 'KODA-1', mockAdminUser);
    });

    it('should reject delete from non-ADMIN user with 403', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.deleteTicket('koda', 'KODA-1', mockMemberUser)
      ).rejects.toThrow();
    });

    it('should reject delete from agent with 403', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.deleteTicket('koda', 'KODA-1', mockAgent)
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.deleteTicket('koda', 'KODA-999', mockAdminUser)
      ).rejects.toThrow();
    });

    it('should not hard-delete ticket', async () => {
      const deletedTicket = { ...mockTicket, deletedAt: new Date() };
      mockTicketsService.softDelete.mockResolvedValue(deletedTicket);

      const result = await controller.deleteTicket('koda', 'KODA-1', mockAdminUser);

      // Ticket should still have ID (not hard-deleted)
      expect((result as any).id).toBe(mockTicket.id);
    });
  });

  describe('POST /api/projects/:slug/tickets/:ref/assign', () => {
    it('should assign ticket to user', async () => {
      mockTicketsService.assign.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'user-456',
        assignedToAgentId: null,
      });

      const result = await controller.assignTicket('koda', 'KODA-1', { userId: 'user-456' });

      expect((result as any).assignedToUserId).toBe('user-456');
      expect((result as any).assignedToAgentId).toBeNull();
      expect(service.assign).toHaveBeenCalledWith('koda', 'KODA-1', { userId: 'user-456' }, undefined);
    });

    it('should assign ticket to agent', async () => {
      mockTicketsService.assign.mockResolvedValue({
        ...mockTicket,
        assignedToAgentId: 'agent-456',
        assignedToUserId: null,
      });

      const result = await controller.assignTicket('koda', 'KODA-1', { agentId: 'agent-456' });

      expect((result as any).assignedToAgentId).toBe('agent-456');
      expect((result as any).assignedToUserId).toBeNull();
    });

    it('should unassign ticket', async () => {
      mockTicketsService.assign.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: null,
        assignedToAgentId: null,
      });

      const result = await controller.assignTicket('koda', 'KODA-1', {});

      expect((result as any).assignedToUserId).toBeNull();
      expect((result as any).assignedToAgentId).toBeNull();
    });

    it('should reject both userId and agentId with 400', async () => {
      mockTicketsService.assign.mockRejectedValue(new Error('Bad request'));

      await expect(
        controller.assignTicket('koda', 'KODA-1', { userId: 'user-456', agentId: 'agent-456' })
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketsService.assign.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.assignTicket('koda', 'KODA-999', { userId: 'user-456' })
      ).rejects.toThrow();
    });

    // US-001 AC9: the membership gate for this route now lives in
    // ProjectMembershipGuard (applied to TicketsController). The handler performs
    // no project lookup and no membership check of its own.
    it('AC9: assign called directly does not call ProjectsService.assertProjectMembership', async () => {
      mockTicketsService.assign.mockResolvedValue(mockTicket);

      await controller.assign('koda', 'KODA-1', {} as AssignTicketDto, mockMemberUser, adminProject);

      expect(mockProjectsService.assertProjectMembership).not.toHaveBeenCalled();
      expect(service.assign).toHaveBeenCalledWith('koda', 'KODA-1', {}, withProjectRole(mockMemberUser, 'ADMIN'));
    });

    it('AC9 boundary: assign called directly does not resolve the project by slug either', async () => {
      mockTicketsService.assign.mockResolvedValue(mockTicket);

      await controller.assign('koda', 'KODA-1', {} as AssignTicketDto, mockMemberUser, adminProject);

      expect(mockProjectsService.findProjectIdBySlug).not.toHaveBeenCalled();
    });
  });

  describe('#144 project permissions on ticket routes', () => {
    const T = KodaAction.TRANSITION as CaslPermissionAction;
    const U = KodaAction.UPDATE as CaslPermissionAction;
    const cases: Array<[keyof TicketsController, [CaslPermissionAction, string]]> = [
      ['create', [CaslPermissionAction.CREATE, 'Ticket']],
      ['update', [U, 'Ticket']],
      ['softDelete', [CaslPermissionAction.DELETE, 'Ticket']],
      ['assign', [U, 'Ticket']],
      ['verify', [T, 'Ticket']],
      ['start', [T, 'Ticket']],
      ['fix', [T, 'Ticket']],
      ['verifyFix', [T, 'Ticket']],
      ['close', [T, 'Ticket']],
      ['reject', [T, 'Ticket']],
    ];

    it.each(cases)('%s carries @ProjectPermission(%j) and no global @RequiredPermission', (handler, permission) => {
      const fn = TicketsController.prototype[handler] as unknown as object;
      expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, fn)).toEqual({ permission, exemptAgents: false });
      expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
    });

    it('passes the principal enriched with the resolved project role to the service', async () => {
      const project = { project: { id: 'p1', slug: 'koda' }, role: 'DEVELOPER' };
      mockTicketsService.update.mockResolvedValue({ id: 't1' });
      await controller.update('koda', 'KODA-1', { title: 'x' }, mockMemberUser, project);
      expect(mockTicketsService.update).toHaveBeenCalledWith(
        'koda', 'KODA-1', { title: 'x' }, { ...mockMemberUser, projectRole: 'DEVELOPER' },
      );
    });
  });

  describe('comment-required transitions (M1)', () => {
    const commentRequiredRoutes = ['verify', 'fix', 'verifyFix', 'reject'] as const;

    it.each(commentRequiredRoutes)(
      'M1: blank body on %s route throws ValidationAppException and never reaches the transitions service',
      async (route) => {
        await expect(
          (controller as any)[route]('koda', 'KODA-1', { body: '   ' } as TransitionWithCommentDto, mockAdminUser, adminProject),
        ).rejects.toThrow(ValidationAppException);

        expect(mockTransitionsService[route]).not.toHaveBeenCalled();
      },
    );

    it.each(commentRequiredRoutes)(
      'M1: missing body on %s route throws ValidationAppException and never reaches the transitions service',
      async (route) => {
        await expect(
          (controller as any)[route]('koda', 'KODA-1', {} as TransitionWithCommentDto, mockAdminUser, adminProject),
        ).rejects.toThrow(ValidationAppException);

        expect(mockTransitionsService[route]).not.toHaveBeenCalled();
      },
    );

    it('M1: blank body on verify-fix throws before any approve/reject branching', async () => {
      for (const approve of [true, false]) {
        await expect(
          controller.verifyFix('koda', 'KODA-1', { body: '  ' } as TransitionWithCommentDto, approve, mockAdminUser, adminProject),
        ).rejects.toThrow(ValidationAppException);
      }

      expect(mockTransitionsService.verifyFix).not.toHaveBeenCalled();
    });

    it('M1: non-blank body passes through to the transitions service (positive control)', async () => {
      mockTransitionsService.verify.mockResolvedValue({ ticket: mockTicket });

      await controller.verify('koda', 'KODA-1', { body: 'Verified against staging' }, mockAdminUser, adminProject);

      expect(mockTransitionsService.verify).toHaveBeenCalledWith(
        'koda',
        'KODA-1',
        'Verified against staging',
        withProjectRole(mockAdminUser, 'ADMIN'),
      );
    });

    it('M1: start route has no required comment and still works without a body', async () => {
      mockTransitionsService.start.mockResolvedValue({ ticket: mockTicket });

      await controller.start('koda', 'KODA-1', mockAdminUser, adminProject);

      expect(mockTransitionsService.start).toHaveBeenCalledWith('koda', 'KODA-1', withProjectRole(mockAdminUser, 'ADMIN'));
    });
  });

  describe('POST :ref/close (admin override)', () => {
    const project = (role: string | null) => ({ project: { id: 'p1', slug: 'koda' }, role });

    it('403 for a project DEVELOPER, before any service call', async () => {
      await expect(controller.close('koda', 'KODA-1', { body: 'why' }, mockMemberUser, project('DEVELOPER')))
        .rejects.toBeInstanceOf(ForbiddenAppException);
      expect(mockTransitionsService.close).not.toHaveBeenCalled();
    });

    it('403 for an agent even with every agent role', async () => {
      await expect(controller.close('koda', 'KODA-1', { body: 'why' }, mockAgent, project(null)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    // Authorization runs BEFORE body validation: a non-admin gets 403 even
    // when their request body is malformed. Pin the ordering so a future
    // re-order does not silently turn the 403 into a 400 (the body's
    // validation only fires for callers who passed the admin check).
    it.each([undefined, '', '   '])('403 for a non-admin with malformed body %j (authz runs before validation)', async (body) => {
      await expect(controller.close('koda', 'KODA-1', { body }, mockMemberUser, project('DEVELOPER')))
        .rejects.toBeInstanceOf(ForbiddenAppException);
      expect(mockTransitionsService.close).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '   '])('400 for a project ADMIN with reason %j', async (body) => {
      await expect(controller.close('koda', 'KODA-1', { body }, mockMemberUser, project('ADMIN')))
        .rejects.toBeInstanceOf(ValidationAppException);
      expect(mockTransitionsService.close).not.toHaveBeenCalled();
    });

    // Regression (fix round 1, #144): a request with no body at all makes Nest
    // pass undefined for @Body(), which used to TypeError on dto.body and 500.
    // The controller now defaults the dto, so the missing reason is a 400.
    it('400 for a project ADMIN when the request carries no body at all', async () => {
      await expect(controller.close('koda', 'KODA-1', undefined, mockMemberUser, project('ADMIN')))
        .rejects.toBeInstanceOf(ValidationAppException);
      expect(mockTransitionsService.close).not.toHaveBeenCalled();
    });

    it('closes for a project ADMIN with a reason, passing the enriched principal', async () => {
      mockTransitionsService.close.mockResolvedValue({ ticket: { id: 't1', status: 'CLOSED' }, comment: {}, activity: {} });
      const res = await controller.close('koda', 'KODA-1', { body: 'dup' }, mockMemberUser, project('ADMIN'));
      expect(mockTransitionsService.close).toHaveBeenCalledWith('koda', 'KODA-1', 'dup', { ...mockMemberUser, projectRole: 'ADMIN' });
      expect(res).toEqual(expect.objectContaining({ data: { id: 't1', status: 'CLOSED' } }));
    });
  });
});
