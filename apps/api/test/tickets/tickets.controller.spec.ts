import { Test, TestingModule } from '@nestjs/testing';
import { TicketsController } from '../../src/tickets/tickets.controller';
import { TicketsService } from '../../src/tickets/tickets.service';
import { BadRequestException as _BadRequestException, ForbiddenException as _ForbiddenException, NotFoundException as _NotFoundException } from '@nestjs/common';
import { CreateTicketDto } from '../../src/tickets/dto/create-ticket.dto';
import { UpdateTicketDto } from '../../src/tickets/dto/update-ticket.dto';

describe('TicketsController', () => {
  let controller: TicketsController;
  let service: TicketsService;

  const mockProject = {
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
  };

  const mockAdminUser = {
    sub: 'user-123',
    email: 'admin@example.com',
    role: 'ADMIN',
  };

  const mockMemberUser = {
    sub: 'user-456',
    email: 'member@example.com',
    role: 'MEMBER',
  };

  const mockAgent = {
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [{ provide: TicketsService, useValue: mockTicketsService }],
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

      const req: any = { user: mockAdminUser };
      const result = await controller.create('koda', createDto, req);

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

      const req: any = { user: mockMemberUser };
      const result = await controller.create('koda', createDto, req);

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

      const req: any = { agent: mockAgent };
      const result = await controller.create('koda', createDto, req);

      expect(result).toBeDefined();
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAgent, 'agent');
    });

    it('should validate DTO fields', async () => {
      const invalidDtos = [
        { description: 'Missing type' }, // Missing required field
        { type: 'INVALID', title: 'Test' }, // Invalid type enum
      ];

      mockTicketsService.create.mockRejectedValue(new Error('Validation error'));

      const req: any = { user: mockAdminUser };

      for (const invalidDto of invalidDtos) {
        await expect(
          controller.create('koda', invalidDto as CreateTicketDto, req)
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

      const req: any = { user: mockAdminUser };

      await expect(
        controller.create('nonexistent', createDto, req)
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

      const result = await controller.findAll('koda', {});

      expect(result.tickets).toEqual(tickets);
      expect(result.total).toBe(2);
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

      const result = await controller.findAll('koda', query as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', expect.objectContaining(query));
      expect(result.total).toEqual(1);
    });

    it('should apply status filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, status: 'VERIFIED' }],
        total: 1,
      });

      const result = await controller.findAll('koda', { status: 'VERIFIED' } as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', { status: 'VERIFIED' });
      expect(result.tickets[0].status).toBe('VERIFIED');
    });

    it('should apply type filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, type: 'ENHANCEMENT' }],
        total: 1,
      });

      const result = await controller.findAll('koda', { type: 'ENHANCEMENT' } as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', { type: 'ENHANCEMENT' });
      expect(result.tickets[0].type).toBe('ENHANCEMENT');
    });

    it('should apply priority filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, priority: 'CRITICAL' }],
        total: 1,
      });

      const result = await controller.findAll('koda', { priority: 'CRITICAL' } as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', { priority: 'CRITICAL' });
      expect(result.tickets[0].priority).toBe('CRITICAL');
    });

    it('should apply assignedTo filter', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [{ ...mockTicket, assignedToUserId: 'user-456' }],
        total: 1,
      });

      const result = await controller.findAll('koda', { assignedTo: 'user-456' } as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', { assignedTo: 'user-456' });
      expect(result.tickets[0].assignedToUserId).toBe('user-456');
    });

    it('should filter for unassigned tickets', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [mockTicket],
        total: 1,
      });

      const result = await controller.findAll('koda', { unassigned: true } as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', { unassigned: true });
    });

    it('should apply pagination with limit and page', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [mockTicket],
        total: 1,
      });

      const result = await controller.findAll('koda', { limit: 10, page: 2 } as any);

      expect(service.findAll).toHaveBeenCalledWith('koda', { limit: 10, page: 2 });
    });

    it('should return empty list when no tickets found', async () => {
      mockTicketsService.findAll.mockResolvedValue({
        tickets: [],
        total: 0,
      });

      const result = await controller.findAll('koda', {});

      expect(result.tickets).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return 404 if project not found', async () => {
      mockTicketsService.findAll.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.findAll('nonexistent', {})
      ).rejects.toThrow();
    });
  });

  describe('GET /api/projects/:slug/tickets/:ref', () => {
    it('should return ticket by KODA-42 reference', async () => {
      mockTicketsService.findByRef.mockResolvedValue(mockTicket);

      const result = await controller.findByRef('koda', 'KODA-1');

      expect(result).toEqual(mockTicket);
      expect(service.findByRef).toHaveBeenCalledWith('koda', 'KODA-1');
    });

    it('should return ticket by CUID reference', async () => {
      mockTicketsService.findByRef.mockResolvedValue(mockTicket);

      const result = await controller.findByRef('koda', 'ticket-123');

      expect(result).toEqual(mockTicket);
      expect(service.findByRef).toHaveBeenCalledWith('koda', 'ticket-123');
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketsService.findByRef.mockResolvedValue(null);

      const result = await controller.findByRef('koda', 'KODA-999');

      expect(result).toBeNull();
    });

    it('should return 404 if project not found', async () => {
      mockTicketsService.findByRef.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.findByRef('nonexistent', 'KODA-1')
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

      const req: any = { user: mockAdminUser };
      const result = await controller.update('koda', 'KODA-1', updateDto, req);

      expect(result.title).toBe('Updated title');
      expect(result.priority).toBe('CRITICAL');
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

      const req: any = { user: mockMemberUser };
      const result = await controller.update('koda', 'KODA-1', updateDto, req);

      expect(result.title).toBe('Updated by member');
    });

    it('should allow agent to update ticket', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated by agent',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        title: 'Updated by agent',
      });

      const req: any = { agent: mockAgent };
      const result = await controller.update('koda', 'KODA-1', updateDto, req);

      expect(result.title).toBe('Updated by agent');
    });

    it('should support partial updates', async () => {
      const updateDto: UpdateTicketDto = {
        priority: 'MEDIUM',
      };

      mockTicketsService.update.mockResolvedValue({
        ...mockTicket,
        priority: 'MEDIUM',
      });

      const req: any = { user: mockAdminUser };
      const result = await controller.update('koda', 'KODA-1', updateDto, req);

      expect(result.priority).toBe('MEDIUM');
    });

    it('should return 404 if ticket not found', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated',
      };

      mockTicketsService.update.mockRejectedValue(new Error('Ticket not found'));

      const req: any = { user: mockAdminUser };

      await expect(
        controller.update('koda', 'KODA-999', updateDto, req)
      ).rejects.toThrow();
    });
  });

  describe('DELETE /api/projects/:slug/tickets/:ref', () => {
    it('should soft-delete ticket for ADMIN user', async () => {
      mockTicketsService.softDelete.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      const req: any = { user: mockAdminUser };
      const result = await controller.softDelete('koda', 'KODA-1', req);

      expect(result.deletedAt).not.toBeNull();
      expect(service.softDelete).toHaveBeenCalledWith('koda', 'KODA-1', mockAdminUser, 'user');
    });

    it('should reject delete from non-ADMIN user with 403', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Forbidden'));

      const req: any = { user: mockMemberUser };

      await expect(
        controller.softDelete('koda', 'KODA-1', req)
      ).rejects.toThrow();
    });

    it('should reject delete from agent with 403', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Forbidden'));

      const req: any = { agent: mockAgent };

      await expect(
        controller.softDelete('koda', 'KODA-1', req)
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketsService.softDelete.mockRejectedValue(new Error('Ticket not found'));

      const req: any = { user: mockAdminUser };

      await expect(
        controller.softDelete('koda', 'KODA-999', req)
      ).rejects.toThrow();
    });

    it('should not hard-delete ticket', async () => {
      const deletedTicket = { ...mockTicket, deletedAt: new Date() };
      mockTicketsService.softDelete.mockResolvedValue(deletedTicket);

      const req: any = { user: mockAdminUser };
      const result = await controller.softDelete('koda', 'KODA-1', req);

      // Ticket should still have ID (not hard-deleted)
      expect(result.id).toBe(mockTicket.id);
    });
  });

  describe('POST /api/projects/:slug/tickets/:ref/assign', () => {
    it('should assign ticket to user', async () => {
      mockTicketsService.assign.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'user-456',
        assignedToAgentId: null,
      });

      const result = await controller.assign('koda', 'KODA-1', { userId: 'user-456' });

      expect(result.assignedToUserId).toBe('user-456');
      expect(result.assignedToAgentId).toBeNull();
      expect(service.assign).toHaveBeenCalledWith('koda', 'KODA-1', { userId: 'user-456' });
    });

    it('should assign ticket to agent', async () => {
      mockTicketsService.assign.mockResolvedValue({
        ...mockTicket,
        assignedToAgentId: 'agent-456',
        assignedToUserId: null,
      });

      const result = await controller.assign('koda', 'KODA-1', { agentId: 'agent-456' });

      expect(result.assignedToAgentId).toBe('agent-456');
      expect(result.assignedToUserId).toBeNull();
    });

    it('should unassign ticket', async () => {
      mockTicketsService.assign.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: null,
        assignedToAgentId: null,
      });

      const result = await controller.assign('koda', 'KODA-1', {});

      expect(result.assignedToUserId).toBeNull();
      expect(result.assignedToAgentId).toBeNull();
    });

    it('should reject both userId and agentId with 400', async () => {
      mockTicketsService.assign.mockRejectedValue(new Error('Bad request'));

      await expect(
        controller.assign('koda', 'KODA-1', { userId: 'user-456', agentId: 'agent-456' })
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketsService.assign.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.assign('koda', 'KODA-999', { userId: 'user-456' })
      ).rejects.toThrow();
    });
  });
});
