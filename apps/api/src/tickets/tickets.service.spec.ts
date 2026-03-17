import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from './tickets.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException as _BadRequestException, NotFoundException as _NotFoundException, ForbiddenException as _ForbiddenException } from '@nestjs/common';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

describe('TicketsService', () => {
  let service: TicketsService;
  let prismaService: PrismaService;

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

  const _mockUser = {
    id: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    role: 'MEMBER',
    passwordHash: 'hash',
    createdAt: new Date(),
    updatedAt: new Date(),
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

  const mockPrismaService = {
    project: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    ticket: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new ticket with auto-incremented number', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix login bug',
        description: 'Users cannot login',
        priority: 'HIGH',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      // Mock transaction to return ticket with number 1
      mockPrismaService.$transaction.mockResolvedValue(mockTicket);

      const result = await service.create('koda', createDto, { sub: 'user-123' }, 'user');

      expect(result).toEqual(mockTicket);
      expect(result.number).toBe(1);
      expect(prismaService.$transaction).toHaveBeenCalled();
    });

    it('should increment ticket number sequentially', async () => {
      const createDto: CreateTicketDto = {
        type: 'ENHANCEMENT',
        title: 'Add dark mode',
        description: 'Implement dark mode toggle',
        priority: 'MEDIUM',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, title: 'Add dark mode', id: 'ticket-124' };

      // First create
      mockPrismaService.$transaction.mockResolvedValueOnce(ticket1);
      const result1 = await service.create('koda', createDto, { sub: 'user-123' }, 'user');
      expect(result1.number).toBe(1);

      // Second create
      mockPrismaService.$transaction.mockResolvedValueOnce(ticket2);
      const result2 = await service.create('koda', createDto, { sub: 'user-123' }, 'user');
      expect(result2.number).toBe(2);
    });

    it('should not create duplicate ticket numbers on concurrent creates', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Concurrent test',
        priority: 'MEDIUM',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, id: 'ticket-124' };

      // Simulate concurrent creates
      mockPrismaService.$transaction
        .mockResolvedValueOnce(ticket1)
        .mockResolvedValueOnce(ticket2);

      const [result1, result2] = await Promise.all([
        service.create('koda', createDto, { sub: 'user-123' }, 'user'),
        service.create('koda', createDto, { sub: 'user-123' }, 'user'),
      ]);

      // Numbers should be different and sequential
      expect(result1.number).not.toEqual(result2.number);
      expect(Math.abs(result1.number - result2.number)).toBe(1);
    });

    it('should return 404 if project not found', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Test',
        priority: 'MEDIUM',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(null);

      await expect(service.create('nonexistent', createDto, { sub: 'user-123' }, 'user')).rejects.toThrow();
    });

    it('should assign ticket to current user when createdByUserId is provided', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
        priority: 'HIGH',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.$transaction.mockResolvedValue({
        ...mockTicket,
        createdByUserId: 'user-123',
      });

      const result = await service.create('koda', createDto, { sub: 'user-123' }, 'user');

      expect(result.createdByUserId).toBe('user-123');
    });

    it('should assign ticket to current agent when createdByAgentId is provided', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
        priority: 'HIGH',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.$transaction.mockResolvedValue({
        ...mockTicket,
        createdByAgentId: 'agent-123',
        createdByUserId: null,
      });

      const result = await service.create('koda', createDto, { sub: 'agent-123' }, 'agent');

      expect(result.createdByAgentId).toBe('agent-123');
    });

    it('should validate required fields', async () => {
      const invalidDtos = [
        { description: 'Missing type' },
        { type: 'BUG' }, // Missing title
        { type: 'BUG', title: 'Test', description: '' }, // Empty description is ok
      ];

      for (const invalidDto of invalidDtos) {
        mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

        await expect(
          service.create('koda', invalidDto as CreateTicketDto, { sub: 'user-123' }, 'user')
        ).rejects.toThrow();
      }
    });

    it('should set default values for optional fields', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      const expectedTicket = {
        ...mockTicket,
        status: 'CREATED',
        priority: 'MEDIUM', // default
      };
      mockPrismaService.$transaction.mockResolvedValue(expectedTicket);

      const result = await service.create('koda', createDto, { sub: 'user-123' }, 'user');

      expect(result.status).toBe('CREATED');
      expect(result.priority).toBe('MEDIUM');
    });
  });

  describe('findAll', () => {
    it('should return all tickets for a project excluding soft-deleted', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([mockTicket]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      const result = await service.findAll('koda', {});

      expect(result).toEqual(expect.objectContaining({
        tickets: [mockTicket],
        total: 1,
      }));
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: mockProject.id,
            deletedAt: null,
          }),
        })
      );
    });

    it('should filter by status', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([
        { ...mockTicket, status: 'IN_PROGRESS' },
      ]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await service.findAll('koda', { status: 'IN_PROGRESS' });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'IN_PROGRESS',
          }),
        })
      );
    });

    it('should filter by type', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([
        { ...mockTicket, type: 'ENHANCEMENT' },
      ]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await service.findAll('koda', { type: 'ENHANCEMENT' });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'ENHANCEMENT',
          }),
        })
      );
    });

    it('should filter by priority', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([
        { ...mockTicket, priority: 'CRITICAL' },
      ]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await service.findAll('koda', { priority: 'CRITICAL' });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            priority: 'CRITICAL',
          }),
        })
      );
    });

    it('should filter by assignedTo userId', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([
        { ...mockTicket, assignedToUserId: 'user-456' },
      ]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await service.findAll('koda', { assignedTo: 'user-456' });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            assignedToUserId: 'user-456',
          }),
        })
      );
    });

    it('should filter for unassigned tickets', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([mockTicket]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await service.findAll('koda', { unassigned: true });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              { assignedToUserId: null },
              { assignedToAgentId: null },
            ],
          }),
        })
      );
    });

    it('should apply pagination with limit and page', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([mockTicket]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await service.findAll('koda', { limit: 10, page: 2 });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 10, // (page - 1) * limit
        })
      );
    });

    it('should return empty array when no tickets found', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([]);
      mockPrismaService.ticket.count.mockResolvedValue(0);

      const result = await service.findAll('koda', {});

      expect(result.tickets).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should not return soft-deleted tickets', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([]);
      mockPrismaService.ticket.count.mockResolvedValue(0);

      await service.findAll('koda', {});

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
          }),
        })
      );
    });
  });

  describe('findByRef', () => {
    it('should resolve ticket by KODA-42 format (projectKey-number)', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);

      const result = await service.findByRef('koda', 'KODA-1');

      expect(result).toEqual(mockTicket);
      expect(prismaService.ticket.findUnique).toHaveBeenCalledWith({
        where: {
          projectId_number: {
            projectId: mockProject.id,
            number: 1,
          },
        },
      });
    });

    it('should resolve ticket by CUID', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);

      const result = await service.findByRef('koda', 'ticket-123');

      expect(result).toEqual(mockTicket);
      expect(prismaService.ticket.findUnique).toHaveBeenCalledWith({
        where: { id: 'ticket-123' },
      });
    });

    it('should handle KODA-42 pattern case-insensitively', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);

      // Test lowercase
      await service.findByRef('koda', 'koda-1');

      // Should convert to uppercase or project key
      expect(prismaService.ticket.findUnique).toHaveBeenCalled();
    });

    it('should return null if ticket not found', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      const result = await service.findByRef('koda', 'KODA-999');

      expect(result).toBeNull();
    });

    it('should not return soft-deleted ticket', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      const result = await service.findByRef('koda', 'KODA-1');

      if (result && result.deletedAt) {
        expect(result.deletedAt).toBeNull();
      }
    });

    it('should validate KODA-42 format', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const invalidRefs = ['invalid', '123', 'KODA-abc', 'KODA--1'];

      for (const ref of invalidRefs) {
        // Should either treat as CUID or throw
        await service.findByRef('koda', ref);
        // At minimum, should attempt lookup
        expect(prismaService.ticket.findUnique).toHaveBeenCalled();
      }
    });
  });

  describe('update', () => {
    it('should update ticket by ref', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title',
        priority: 'CRITICAL',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        ...updateDto,
      });

      const result = await service.update('koda', 'KODA-1', updateDto, { sub: 'user-123' }, 'user');

      expect(result.title).toBe('Updated title');
      expect(result.priority).toBe('CRITICAL');
    });

    it('should not update immutable fields', async () => {
      const updateDto: UpdateTicketDto = {
        number: 999, // Should be ignored
        projectId: 'other-project', // Should be ignored
      } as UpdateTicketDto;

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue(mockTicket);

      const result = await service.update('koda', 'KODA-1', updateDto, { sub: 'user-123' }, 'user');

      expect(result.number).toBe(1); // Original number
      expect(result.projectId).toBe('proj-123'); // Original projectId
    });

    it('should return 404 if ticket not found', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.update('koda', 'KODA-999', updateDto, { sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });

    it('should allow partial updates', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Only update title',
      };

      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        title: 'Only update title',
      });

      const result = await service.update('koda', 'KODA-1', updateDto, { sub: 'user-123' }, 'user');

      expect(result.title).toBe('Only update title');
      expect(result.description).toBe(mockTicket.description); // Unchanged
    });
  });

  describe('softDelete', () => {
    it('should set deletedAt to current timestamp', async () => {
      const now = new Date();
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        deletedAt: now,
      });

      const result = await service.softDelete('koda', 'KODA-1', { sub: 'user-123' }, 'user');

      expect(result.deletedAt).not.toBeNull();
      expect(prismaService.ticket.update).toHaveBeenCalledWith({
        where: { id: mockTicket.id },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should not hard delete the ticket', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      const result = await service.softDelete('koda', 'KODA-1', { sub: 'user-123' }, 'user');

      expect(result.id).toBe(mockTicket.id); // ID still exists
      expect(result).toBeDefined();
    });

    it('should require ADMIN role', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);

      // Non-admin user should be rejected
      await expect(
        service.softDelete('koda', 'KODA-1', { sub: 'user-456', role: 'MEMBER' }, 'user')
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.softDelete('koda', 'KODA-999', { sub: 'user-123', role: 'ADMIN' }, 'user')
      ).rejects.toThrow();
    });
  });

  describe('assign', () => {
    it('should assign ticket to user', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'user-456',
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { userId: 'user-456' });

      expect(result.assignedToUserId).toBe('user-456');
      expect(result.assignedToAgentId).toBeNull();
    });

    it('should assign ticket to agent', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        assignedToAgentId: 'agent-456',
        assignedToUserId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { agentId: 'agent-456' });

      expect(result.assignedToAgentId).toBe('agent-456');
      expect(result.assignedToUserId).toBeNull();
    });

    it('should unassign ticket when neither userId nor agentId provided', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: null,
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', {});

      expect(result.assignedToUserId).toBeNull();
      expect(result.assignedToAgentId).toBeNull();
    });

    it('should not allow both userId and agentId', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      await expect(
        service.assign('koda', 'KODA-1', { userId: 'user-456', agentId: 'agent-456' })
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.assign('koda', 'KODA-999', { userId: 'user-456' })
      ).rejects.toThrow();
    });
  });
});
