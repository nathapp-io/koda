import { Test, TestingModule } from '@nestjs/testing';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { PERMISSION_KEY, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { ValidationAppException, Page } from '@nathapp/nestjs-common';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { ProjectsService } from '../projects/projects.service';
import { TransitionWithCommentDto } from './dto/transition-with-comment.dto';

describe('TicketsController', () => {
  let controller: TicketsController;
  let service: TicketsService;

  const mockProjectsService = {
    findProjectIdBySlug: jest.fn().mockResolvedValue('proj-123'),
    assertProjectMembership: jest.fn().mockResolvedValue(undefined),
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
    create: jest.fn(),
    findAll: jest.fn(),
    findByRef: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    assign: jest.fn(),
  };

  const mockTransitionsService = {
    verify: jest.fn(),
    start: jest.fn(),
    fix: jest.fn(),
    verifyFix: jest.fn(),
    close: jest.fn(),
    reject: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [
        { provide: TicketsService, useValue: mockTicketsService },
        { provide: TicketTransitionsService, useValue: mockTransitionsService },
        { provide: ProjectsService, useValue: mockProjectsService },
      ],
    }).compile();

    controller = module.get<TicketsController>(TicketsController);
    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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

  describe('PATCH /api/projects/:slug/tickets/:ref', () => {
    it('requires UPDATE Ticket permission on the HTTP route', () => {
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.update)).toEqual([
        [KodaAction.UPDATE as CaslPermissionAction, 'Ticket'],
      ]);
    });

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
    it('requires DELETE Ticket permission on the HTTP route', () => {
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.softDelete)).toEqual([
        [CaslPermissionAction.DELETE, 'Ticket'],
      ]);
    });

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

    it('should check project membership via findProjectIdBySlug + assertProjectMembership (BUG-2)', async () => {
      mockProjectsService.findProjectIdBySlug.mockResolvedValue('proj-123');
      mockTicketsService.assign.mockResolvedValue(mockTicket);

      await controller.assign('koda', 'KODA-1', {} as AssignTicketDto, mockAdminUser);

      expect(mockProjectsService.findProjectIdBySlug).toHaveBeenCalledWith('koda');
      expect(mockProjectsService.assertProjectMembership).toHaveBeenCalledWith('proj-123', mockAdminUser);
      expect(service.assign).toHaveBeenCalledWith('koda', 'KODA-1', {}, mockAdminUser);
    });

    it('should not assign when the caller is not a project member (BUG-2)', async () => {
      mockProjectsService.assertProjectMembership.mockRejectedValueOnce(new Error('Forbidden'));

      await expect(
        controller.assign('koda', 'KODA-1', {} as AssignTicketDto, mockMemberUser)
      ).rejects.toThrow('Forbidden');

      expect(service.assign).not.toHaveBeenCalled();
    });
  });

  describe('ticket transition route permissions', () => {
    const transitionPermission = [[KodaAction.TRANSITION as CaslPermissionAction, 'Ticket']];

    it('requires TRANSITION Ticket permission on all transition HTTP routes', () => {
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.verify)).toEqual(transitionPermission);
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.start)).toEqual(transitionPermission);
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.fix)).toEqual(transitionPermission);
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.verifyFix)).toEqual(transitionPermission);
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.close)).toEqual(transitionPermission);
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.reject)).toEqual(transitionPermission);
    });

    it('requires UPDATE Ticket permission on the assign HTTP route (BUG-2)', () => {
      expect(Reflect.getMetadata(PERMISSION_KEY, controller.assign)).toEqual([
        [KodaAction.UPDATE as CaslPermissionAction, 'Ticket'],
      ]);
    });
  });

  describe('comment-required transitions (M1)', () => {
    const commentRequiredRoutes = ['verify', 'fix', 'verifyFix', 'reject'] as const;

    it.each(commentRequiredRoutes)(
      'M1: blank body on %s route throws ValidationAppException and never reaches the transitions service',
      async (route) => {
        await expect(
          (controller as any)[route]('koda', 'KODA-1', { body: '   ' } as TransitionWithCommentDto, mockAdminUser),
        ).rejects.toThrow(ValidationAppException);

        expect(mockTransitionsService[route]).not.toHaveBeenCalled();
      },
    );

    it.each(commentRequiredRoutes)(
      'M1: missing body on %s route throws ValidationAppException and never reaches the transitions service',
      async (route) => {
        await expect(
          (controller as any)[route]('koda', 'KODA-1', {} as TransitionWithCommentDto, mockAdminUser),
        ).rejects.toThrow(ValidationAppException);

        expect(mockTransitionsService[route]).not.toHaveBeenCalled();
      },
    );

    it('M1: blank body on verify-fix throws before any approve/reject branching', async () => {
      for (const approve of [true, false]) {
        await expect(
          controller.verifyFix('koda', 'KODA-1', { body: '  ' } as TransitionWithCommentDto, approve, mockAdminUser),
        ).rejects.toThrow(ValidationAppException);
      }

      expect(mockTransitionsService.verifyFix).not.toHaveBeenCalled();
    });

    it('M1: non-blank body passes through to the transitions service (positive control)', async () => {
      mockTransitionsService.verify.mockResolvedValue({ ticket: mockTicket });

      await controller.verify('koda', 'KODA-1', { body: 'Verified against staging' }, mockAdminUser);

      expect(mockTransitionsService.verify).toHaveBeenCalledWith(
        'koda',
        'KODA-1',
        'Verified against staging',
        mockAdminUser,
      );
    });

    it('M1: start route has no required comment and still works without a body', async () => {
      mockTransitionsService.start.mockResolvedValue({ ticket: mockTicket });

      await controller.start('koda', 'KODA-1', mockAdminUser);

      expect(mockTransitionsService.start).toHaveBeenCalledWith('koda', 'KODA-1', mockAdminUser);
    });
  });
});
