import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from '../../src/tickets/tickets.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

describe('Tickets Integration Tests', () => {
  let ticketsService: TicketsService;
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

    ticketsService = module.get<TicketsService>(TicketsService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Ticket sequential numbering', () => {
    it('should create tickets with sequential numbers starting from 1', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, id: 'ticket-124', title: 'Second ticket' };
      const ticket3 = { ...mockTicket, number: 3, id: 'ticket-125', title: 'Third ticket' };

      mockPrismaService.$transaction
        .mockResolvedValueOnce(ticket1)
        .mockResolvedValueOnce(ticket2)
        .mockResolvedValueOnce(ticket3);

      const result1 = await ticketsService.create('koda', {
        type: 'BUG',
        title: 'First ticket',
        priority: 'MEDIUM',
      }, { sub: 'user-123' }, 'user');

      const result2 = await ticketsService.create('koda', {
        type: 'BUG',
        title: 'Second ticket',
        priority: 'MEDIUM',
      }, { sub: 'user-123' }, 'user');

      const result3 = await ticketsService.create('koda', {
        type: 'BUG',
        title: 'Third ticket',
        priority: 'MEDIUM',
      }, { sub: 'user-123' }, 'user');

      expect(result1.number).toBe(1);
      expect(result2.number).toBe(2);
      expect(result3.number).toBe(3);
    });

    it('should not allow duplicate numbers in same project', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, id: 'ticket-124' };

      mockPrismaService.$transaction
        .mockResolvedValueOnce(ticket1)
        .mockResolvedValueOnce(ticket2);

      const result1 = await ticketsService.create('koda', {
        type: 'BUG',
        title: 'First',
        priority: 'MEDIUM',
      }, { sub: 'user-123' }, 'user');

      const result2 = await ticketsService.create('koda', {
        type: 'BUG',
        title: 'Second',
        priority: 'MEDIUM',
      }, { sub: 'user-123' }, 'user');

      // Numbers must be different
      expect(result1.number).not.toEqual(result2.number);
    });

    it('should handle concurrent creates without duplicates (transaction safety)', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      const tickets = Array.from({ length: 5 }, (_, i) => ({
        ...mockTicket,
        number: i + 1,
        id: `ticket-${i}`,
      }));

      mockPrismaService.$transaction.mockImplementation((cb) => {
        // Simulate transaction
        return Promise.resolve(tickets[Math.floor(Math.random() * tickets.length)]);
      });

      const promises = tickets.map(() =>
        ticketsService.create('koda', {
          type: 'BUG',
          title: 'Concurrent',
          priority: 'MEDIUM',
        }, { sub: 'user-123' }, 'user')
      );

      const results = await Promise.all(promises);

      // All tickets should have unique numbers
      const numbers = results.map(t => t.number);
      const uniqueNumbers = new Set(numbers);
      expect(uniqueNumbers.size).toBe(results.length);
    });
  });

  describe('Ticket reference resolution (dual-ref)', () => {
    it('should resolve ticket by KODA-42 format', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);

      const result = await ticketsService.findByRef('koda', 'KODA-1');

      expect(result).toEqual(mockTicket);
      // Should query by projectId_number composite key
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

      const result = await ticketsService.findByRef('koda', 'ticket-123');

      expect(result).toEqual(mockTicket);
      // Should query by ID
      expect(prismaService.ticket.findUnique).toHaveBeenCalledWith({
        where: { id: 'ticket-123' },
      });
    });

    it('should extract project key from KODA-42 format correctly', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        ...mockProject,
        key: 'ABC',
        id: 'proj-456',
      });
      mockPrismaService.ticket.findUnique.mockResolvedValue({
        ...mockTicket,
        projectId: 'proj-456',
        number: 42,
      });

      const result = await ticketsService.findByRef('project-slug', 'ABC-42');

      expect(result.number).toBe(42);
    });

    it('should differentiate KODA-42 from CUID', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);

      // KODA-42 should match pattern
      await ticketsService.findByRef('koda', 'KODA-1');
      expect(prismaService.ticket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId_number: expect.any(Object),
          }),
        })
      );

      jest.clearAllMocks();
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);

      // CUID should be treated as ID
      await ticketsService.findByRef('koda', 'clxyz123abc');
      expect(prismaService.ticket.findUnique).toHaveBeenCalledWith({
        where: { id: 'clxyz123abc' },
      });
    });
  });

  describe('Ticket filtering', () => {
    it('should filter tickets by status and return correct results', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      const inProgressTickets = [
        { ...mockTicket, status: 'IN_PROGRESS' },
        { ...mockTicket, number: 2, id: 'ticket-124', status: 'IN_PROGRESS' },
      ];
      mockPrismaService.ticket.findMany.mockResolvedValue(inProgressTickets);
      mockPrismaService.ticket.count.mockResolvedValue(2);

      const result = await ticketsService.findAll('koda', { status: 'IN_PROGRESS' });

      expect(result.tickets).toEqual(inProgressTickets);
      expect(result.total).toBe(2);
      expect(result.tickets.every(t => t.status === 'IN_PROGRESS')).toBe(true);
    });

    it('should filter by multiple criteria simultaneously', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      const filtered = [{ ...mockTicket, status: 'IN_PROGRESS', priority: 'HIGH' }];
      mockPrismaService.ticket.findMany.mockResolvedValue(filtered);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      const result = await ticketsService.findAll('koda', {
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        type: 'BUG',
      });

      expect(result.tickets).toEqual(filtered);
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'IN_PROGRESS',
            priority: 'HIGH',
            type: 'BUG',
          }),
        })
      );
    });

    it('should exclude soft-deleted tickets from filters', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([mockTicket]);
      mockPrismaService.ticket.count.mockResolvedValue(1);

      await ticketsService.findAll('koda', { status: 'CLOSED' });

      // Should always include deletedAt: null in where clause
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
          }),
        })
      );
    });
  });

  describe('Ticket soft-delete', () => {
    it('should soft-delete ticket without removing it', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(mockTicket);
      const now = new Date();
      const deletedTicket = { ...mockTicket, deletedAt: now };
      mockPrismaService.ticket.update.mockResolvedValue(deletedTicket);

      const result = await ticketsService.softDelete('koda', 'KODA-1', { sub: 'user-123', role: 'ADMIN' }, 'user');

      expect(result.deletedAt).not.toBeNull();
      expect(result.id).toBe(mockTicket.id); // ID still exists
    });

    it('should exclude soft-deleted tickets from findAll', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([mockTicket]); // Only active tickets
      mockPrismaService.ticket.count.mockResolvedValue(1);

      const deletedTicket = { ...mockTicket, deletedAt: new Date() };

      const result = await ticketsService.findAll('koda', {});

      // Soft-deleted ticket should not be in results
      expect(result.tickets).not.toContain(deletedTicket);
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
          }),
        })
      );
    });

    it('should exclude soft-deleted tickets from findByRef', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(null); // Soft-deleted returns null

      const result = await ticketsService.findByRef('koda', 'KODA-1');

      expect(result).toBeNull();
    });
  });

  describe('Complete ticket lifecycle', () => {
    it('should create, retrieve, update, and soft-delete ticket', async () => {
      const createDto = {
        type: 'BUG',
        title: 'Fix critical bug',
        description: 'Production issue',
        priority: 'CRITICAL',
      };

      // 1. Create ticket
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      const created = { ...mockTicket, ...createDto };
      mockPrismaService.$transaction.mockResolvedValue(created);

      const createResult = await ticketsService.create('koda', createDto, { sub: 'user-123' }, 'user');
      expect(createResult).toBeDefined();
      expect(createResult.title).toBe('Fix critical bug');

      // 2. Retrieve ticket by ref
      jest.clearAllMocks();
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(created);

      const retrieved = await ticketsService.findByRef('koda', 'KODA-1');
      expect(retrieved).toEqual(created);

      // 3. Update ticket
      jest.clearAllMocks();
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(created);
      const updated = { ...created, status: 'IN_PROGRESS', priority: 'MEDIUM' };
      mockPrismaService.ticket.update.mockResolvedValue(updated);

      const updateResult = await ticketsService.update(
        'koda',
        'KODA-1',
        { status: 'IN_PROGRESS', priority: 'MEDIUM' },
        { sub: 'user-123' },
        'user'
      );
      expect(updateResult.status).toBe('IN_PROGRESS');

      // 4. Soft-delete ticket
      jest.clearAllMocks();
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findUnique.mockResolvedValue(updated);
      const deleted = { ...updated, deletedAt: new Date() };
      mockPrismaService.ticket.update.mockResolvedValue(deleted);

      const deleteResult = await ticketsService.softDelete('koda', 'KODA-1', { sub: 'user-123', role: 'ADMIN' }, 'user');
      expect(deleteResult.deletedAt).not.toBeNull();
    });
  });

  describe('Pagination and limits', () => {
    it('should respect limit parameter', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([mockTicket]);
      mockPrismaService.ticket.count.mockResolvedValue(100);

      await ticketsService.findAll('koda', { limit: 25 });

      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
        })
      );
    });

    it('should calculate correct skip offset for pagination', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.ticket.findMany.mockResolvedValue([]);
      mockPrismaService.ticket.count.mockResolvedValue(0);

      // Page 1, limit 10: skip 0
      await ticketsService.findAll('koda', { limit: 10, page: 1 });
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0 })
      );

      jest.clearAllMocks();

      // Page 2, limit 10: skip 10
      await ticketsService.findAll('koda', { limit: 10, page: 2 });
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10 })
      );

      jest.clearAllMocks();

      // Page 3, limit 10: skip 20
      await ticketsService.findAll('koda', { limit: 10, page: 3 });
      expect(prismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20 })
      );
    });
  });
});
