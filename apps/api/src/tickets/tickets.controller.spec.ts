import { Test, TestingModule } from '@nestjs/testing';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

describe('TicketsController', () => {
  let controller: TicketsController;
  let service: TicketsService;

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
    id: 'user-123',
    sub: 'user-123',
    email: 'admin@example.com',
    role: 'ADMIN',
  };

  const mockMemberUser = {
    id: 'user-456',
    sub: 'user-456',
    email: 'member@example.com',
    role: 'MEMBER',
  };

  const mockAgent = {
    id: 'agent-123',
    sub: 'agent-123',
    slug: 'test-agent',
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

      const result = await controller.createTicket('koda', createDto, mockAdminUser, 'user');

      expect(result).toEqual(mockTicket);
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAdminUser, 'user');
    });

    it('should allow member to create ticket', async () => {
      const createDto: CreateTicketDto = {
        type: 'ENHANCEMENT',
        title: 'Add feature',
        priority: 'MEDIUM',
      };

      mockTicketsService.create.mockResolvedValue(mockTicket);

      const result = await controller.createTicket('koda', createDto, mockMemberUser, 'user');

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

      const result = await controller.createTicket('koda', createDto, mockAgent, 'agent');

      expect(result).toBeDefined();
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAgent, 'agent');
    });

    it('should validate DTO fields', async () => {
      const invalidDtos = [
        { description: 'Missing type' }, // Missing required field
        { type: 'INVALID', title: 'Test' }, // Invalid type enum
      ];

      mockTicketsService.create.mockRejectedValue(new Error('Validation error'));

      for (const invalidDto of invalidDtos) {
        await expect(
          controller.createTicket('koda', invalidDto as CreateTicketDto, mockAdminUser, 'user')
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
        controller.createTicket('nonexistent', createDto, mockAdminUser, 'user')
      ).rejects.toThrow();
    });
  });

  describe('GET /api/projects/:slug/tickets', () => {
    it('should return all tickets with pagination', async () => {
      const tickets = [mockTicket, { ...mockTicket, number: 2, id: 'ticket-124' }];
      mockTicketsService.findAll.mockResolvedValue({
        tickets,
        total: 2,
      });

      const result = await controller.listTickets('koda', {});

      expect((result as any).tickets).toEqual(tickets);
      expect((result as any).total).toBe(2);
    });

    it('should accept filters as query parameters', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [mockTicket],
        total: 1,
      });

      const query = {
        status: 'IN_PROGRESS',
        type: 'BUG',
        priority: 'HIGH',
        assignedTo: 'user-456',
        unassigned: false,
        limit: 10,
        page: 1,
      };

      const result = await controller.listTickets('koda', query);

      expect(service.findAll).toHaveBeenCalledWith('koda', expect.objectContaining(query));
      expect((result as any).total).toEqual(1);
    });

    it('should apply status filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, status: 'VERIFIED' }],
        total: 1,
      });

      const result = await controller.listTickets('koda', { status: 'VERIFIED' });

      expect(service.findAll).toHaveBeenCalledWith('koda', { status: 'VERIFIED' });
      expect((result as any).tickets[0].status).toBe('VERIFIED');
    });

    it('should apply type filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, type: 'ENHANCEMENT' }],
        total: 1,
      });

      const result = await controller.listTickets('koda', { type: 'ENHANCEMENT' });

      expect(service.findAll).toHaveBeenCalledWith('koda', { type: 'ENHANCEMENT' });
      expect((result as any).tickets[0].type).toBe('ENHANCEMENT');
    });

    it('should apply priority filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, priority: 'CRITICAL' }],
        total: 1,
      });

      const result = await controller.listTickets('koda', { priority: 'CRITICAL' });

      expect(service.findAll).toHaveBeenCalledWith('koda', { priority: 'CRITICAL' });
      expect((result as any).tickets[0].priority).toBe('CRITICAL');
    });

    it('should apply assignedTo filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, assignedToUserId: 'user-456' }],
        total: 1,
      });

      const result = await controller.listTickets('koda', { assignedTo: 'user-456' });

      expect(service.findAll).toHaveBeenCalledWith('koda', { assignedTo: 'user-456' });
      expect((result as any).tickets[0].assignedToUserId).toBe('user-456');
    });

    it('should filter for unassigned tickets', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [mockTicket],
        total: 1,
      });

      await controller.listTickets('koda', { unassigned: true });

      expect(service.findAll).toHaveBeenCalledWith('koda', { unassigned: true });
    });

    it('should apply pagination with limit and page', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [mockTicket],
        total: 1,
      });

      await controller.listTickets('koda', { limit: 10, page: 2 });

      expect(service.findAll).toHaveBeenCalledWith('koda', { limit: 10, page: 2 });
    });

    it('should return empty list when no tickets found', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [],
        total: 0,
      });

      const result = await controller.listTickets('koda', {});

      expect((result as any).tickets).toEqual([]);
      expect((result as any).total).toBe(0);
    });

    it('should return 404 if project not found', async () => {
      mockTicketsService.findAll.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.listTickets('nonexistent', {})
      ).rejects.toThrow();
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

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockAdminUser, 'user');

      expect((result as any).title).toBe('Updated title');
      expect((result as any).priority).toBe('CRITICAL');
      expect(service.update).toHaveBeenCalledWith('koda', 'KODA-1', updateDto, mockAdminUser, 'user');
    });

    it('should allow member to update ticket', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated by member',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        title: 'Updated by member',
      });

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockMemberUser, 'user');

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

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockAgent, 'agent');

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

      const result = await controller.updateTicket('koda', 'KODA-1', updateDto, mockAdminUser, 'user');

      expect((result as any).priority).toBe('MEDIUM');
    });

    it('should return 404 if ticket not found', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated',
      };

      mockTicketsService.update.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.updateTicket('koda', 'KODA-999', updateDto, mockAdminUser, 'user')
      ).rejects.toThrow();
    });
  });

  describe('DELETE /api/projects/:slug/tickets/:ref', () => {
    it('should soft-delete ticket for ADMIN user', async () => {
      mockTicketsService.softDelete.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      const result = await controller.deleteTicket('koda', 'KODA-1', mockAdminUser, 'user');

      expect((result as any).deletedAt).not.toBeNull();
      expect(service.softDelete).toHaveBeenCalledWith('koda', 'KODA-1', mockAdminUser, 'user');
    });

    it('should reject delete from non-ADMIN user with 403', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.deleteTicket('koda', 'KODA-1', mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should reject delete from agent with 403', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.deleteTicket('koda', 'KODA-1', mockAgent, 'agent')
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.deleteTicket('koda', 'KODA-999', mockAdminUser, 'user')
      ).rejects.toThrow();
    });

    it('should not hard-delete ticket', async () => {
      const deletedTicket = { ...mockTicket, deletedAt: new Date() };
      mockTicketsService.softDelete.mockResolvedValue(deletedTicket);

      const result = await controller.deleteTicket('koda', 'KODA-1', mockAdminUser, 'user');

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
      expect(service.assign).toHaveBeenCalledWith('koda', 'KODA-1', { userId: 'user-456' });
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
  });
});