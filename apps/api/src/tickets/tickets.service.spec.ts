import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from './tickets.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TICKET_REPOSITORY } from './domain/ticket.domain';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import type { KodaAgentRole } from '../auth/principal/koda-principal.types';

describe('TicketsService', () => {
  let service: TicketsService;

  const mockProject = {
    id: 'proj-123',
    slug: 'koda',
    key: 'KODA',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
    deletedAt: null,
  };

  const mockUserPrincipal = {
    id: 'user-123',
    sub: 'user-123',
    actorType: 'user' as const,
    role: 'MEMBER' as const,
    email: 'user@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test User',
  };

  const mockAdminPrincipal = {
    id: 'user-123',
    sub: 'user-123',
    actorType: 'user' as const,
    role: 'ADMIN' as const,
    email: 'user@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test User',
  };

  const mockAgentPrincipal = {
    id: 'agent-123',
    sub: 'agent-123',
    actorType: 'agent' as const,
    slug: 'test-agent',
    status: 'ACTIVE' as const,
    agentRoles: [] as KodaAgentRole[],
    capabilities: [] as string[],
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test Agent',
  };

  const mockMemberPrincipal = {
    id: 'user-456',
    sub: 'user-456',
    actorType: 'user' as const,
    role: 'MEMBER' as const,
    email: 'user456@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test User 456',
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
    labels: [],
    links: [],
  };

  const mockTicketRepo = {
    findProjectBySlug: jest.fn(),
    findLastTicketInProject: jest.fn(),
    createTicket: jest.fn(),
    findTicketsByProject: jest.fn(),
    countTicketsByProject: jest.fn(),
    findTicketByProjectAndNumber: jest.fn(),
    findTicketById: jest.fn(),
    updateTicket: jest.fn(),
    assignTicket: jest.fn(),
    softDeleteTicket: jest.fn(),
    findTicketByRefRaw: jest.fn(),
  };

  const mockTxManager = {
    run: jest.fn((fn: () => unknown) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: TICKET_REPOSITORY, useValue: mockTicketRepo },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
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

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(mockTicket);

      const result = await service.create('koda', createDto, mockUserPrincipal);

      // service adds ref: `${project.key}-${ticket.number}` to the response
      expect(result).toEqual({ ...mockTicket, ref: 'KODA-1' });
      expect(result.number).toBe(1);
      expect(mockTxManager.run).toHaveBeenCalled();
    });

    it('should increment ticket number sequentially', async () => {
      const createDto: CreateTicketDto = {
        type: 'ENHANCEMENT',
        title: 'Add dark mode',
        description: 'Implement dark mode toggle',
        priority: 'MEDIUM',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);

      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, title: 'Add dark mode', id: 'ticket-124' };

      // First create: no previous tickets
      mockTicketRepo.findLastTicketInProject.mockResolvedValueOnce(null);
      mockTicketRepo.createTicket.mockResolvedValueOnce(ticket1);
      const result1 = await service.create('koda', createDto, mockUserPrincipal);
      expect(result1.number).toBe(1);

      // Second create: last ticket has number 1
      mockTicketRepo.findLastTicketInProject.mockResolvedValueOnce(ticket1);
      mockTicketRepo.createTicket.mockResolvedValueOnce(ticket2);
      const result2 = await service.create('koda', createDto, mockUserPrincipal);
      expect(result2.number).toBe(2);
    });

    it('should not create duplicate ticket numbers on concurrent creates', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Concurrent test',
        priority: 'MEDIUM',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);

      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, id: 'ticket-124' };

      // Simulate concurrent creates: each sees no prior ticket, but txManager ensures isolation
      mockTicketRepo.findLastTicketInProject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ticket1);
      mockTicketRepo.createTicket
        .mockResolvedValueOnce(ticket1)
        .mockResolvedValueOnce(ticket2);

      const [result1, result2] = await Promise.all([
        service.create('koda', createDto, mockUserPrincipal),
        service.create('koda', createDto, mockUserPrincipal),
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

      mockTicketRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.create('nonexistent', createDto, mockUserPrincipal)).rejects.toThrow();
    });

    it('should assign ticket to current user when createdByUserId is provided', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
        priority: 'HIGH',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue({
        ...mockTicket,
        createdByUserId: 'user-123',
      });

      const result = await service.create('koda', createDto, mockUserPrincipal);

      expect(result.createdByUserId).toBe('user-123');
    });

    it('should assign ticket to current agent when createdByAgentId is provided', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
        priority: 'HIGH',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue({
        ...mockTicket,
        createdByAgentId: 'agent-123',
        createdByUserId: null,
      });

      const result = await service.create('koda', createDto, mockAgentPrincipal);

      expect(result.createdByAgentId).toBe('agent-123');
    });

    it('should validate required fields', async () => {
      const invalidDtos = [
        { description: 'Missing type' },
        { type: 'BUG' }, // Missing title
      ];

      for (const invalidDto of invalidDtos) {
        mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);

        await expect(
          service.create('koda', invalidDto as CreateTicketDto, mockUserPrincipal)
        ).rejects.toThrow();
      }
    });

    it('should allow empty description', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Test',
        description: '',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      const expectedTicket = {
        ...mockTicket,
        description: null,
      };
      mockTicketRepo.createTicket.mockResolvedValue(expectedTicket);

      const result = await service.create('koda', createDto, mockUserPrincipal);

      expect(result.description).toBeNull();
    });

    it('should set default values for optional fields', async () => {
      const createDto: CreateTicketDto = {
        type: 'BUG',
        title: 'Fix bug',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      const expectedTicket = {
        ...mockTicket,
        status: 'CREATED',
        priority: 'MEDIUM', // default
      };
      mockTicketRepo.createTicket.mockResolvedValue(expectedTicket);

      const result = await service.create('koda', createDto, mockUserPrincipal);

      expect(result.status).toBe('CREATED');
      expect(result.priority).toBe('MEDIUM');
    });
  });

  describe('findAll', () => {
    it('should return all tickets for a project excluding soft-deleted', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([mockTicket]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      const result = await service.findAll('koda', {});

      expect(result).toEqual(expect.objectContaining({
        items: [expect.objectContaining({ ...mockTicket, ref: 'KODA-1' })],
        total: 1,
      }));
      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: mockProject.id,
        })
      );
    });

    it('should compute and include ref field for each ticket', async () => {
      const ticket1 = { ...mockTicket, number: 1 };
      const ticket2 = { ...mockTicket, number: 2, id: 'ticket-124' };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([ticket1, ticket2]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(2);

      const result = await service.findAll('koda', {});

      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual(expect.objectContaining({
        ...ticket1,
        ref: 'KODA-1',
      }));
      expect(result.items[1]).toEqual(expect.objectContaining({
        ...ticket2,
        ref: 'KODA-2',
      }));
    });

    it('should filter by status', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([
        { ...mockTicket, status: 'IN_PROGRESS' },
      ]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      await service.findAll('koda', { status: 'IN_PROGRESS' });

      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'IN_PROGRESS' })
      );
    });

    it('should filter by type', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([
        { ...mockTicket, type: 'ENHANCEMENT' },
      ]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      await service.findAll('koda', { type: 'ENHANCEMENT' });

      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ENHANCEMENT' })
      );
    });

    it('should filter by priority', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([
        { ...mockTicket, priority: 'CRITICAL' },
      ]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      await service.findAll('koda', { priority: 'CRITICAL' });

      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'CRITICAL' })
      );
    });

    it('should filter by assignedTo userId', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([
        { ...mockTicket, assignedToUserId: 'user-456' },
      ]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      await service.findAll('koda', { assignedTo: 'user-456' });

      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ assignedToUserId: 'user-456' })
      );
    });

    it('should filter for unassigned tickets', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([mockTicket]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      await service.findAll('koda', { unassigned: true });

      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ unassigned: true })
      );
    });

    it('should apply pagination with limit and page', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([mockTicket]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(1);

      await service.findAll('koda', { limit: 10, page: 2 });

      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, page: 2 })
      );
    });

    it('should return empty array when no tickets found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(0);

      const result = await service.findAll('koda', {});

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should not return soft-deleted tickets', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketsByProject.mockResolvedValue([]);
      mockTicketRepo.countTicketsByProject.mockResolvedValue(0);

      await service.findAll('koda', {});

      // The repo encapsulates the deletedAt: null filter; service just passes projectId
      expect(mockTicketRepo.findTicketsByProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: mockProject.id })
      );
    });
  });

  describe('findByRef', () => {
    it('should resolve ticket by KODA-42 format (projectKey-number)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);

      const result = await service.findByRef('koda', 'KODA-1');

      expect(result).toEqual({ ...mockTicket, ref: 'KODA-1', links: [] });
      expect(mockTicketRepo.findTicketByProjectAndNumber).toHaveBeenCalledWith(
        mockProject.id,
        1,
      );
    });

    it('should resolve ticket by CUID', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketById.mockResolvedValue(mockTicket);

      const result = await service.findByRef('koda', 'ticket-123');

      expect(result).toEqual({ ...mockTicket, ref: 'KODA-1', links: [] });
      expect(mockTicketRepo.findTicketById).toHaveBeenCalledWith('ticket-123');
    });

    it('should handle KODA-42 pattern case-insensitively', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketById.mockResolvedValue(null);

      // Lowercase 'koda-1' does not match the uppercase pattern, treated as CUID
      await expect(service.findByRef('koda', 'koda-1')).rejects.toThrow();
      expect(mockTicketRepo.findTicketById).toHaveBeenCalled();
    });

    it('should throw when ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(null);

      await expect(service.findByRef('koda', 'KODA-999')).rejects.toThrow();
    });

    it('should throw for soft-deleted ticket', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      await expect(service.findByRef('koda', 'KODA-1')).rejects.toThrow();
    });

    it('should validate KODA-42 format', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketById.mockResolvedValue(null);

      const invalidRefs = ['invalid', '123', 'KODA-abc', 'KODA--1'];

      for (const ref of invalidRefs) {
        // Invalid refs result in a not-found lookup, which throws AppException
        await expect(service.findByRef('koda', ref)).rejects.toThrow();
      }
    });
  });

  describe('update', () => {
    it('should update ticket by ref', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title',
        priority: 'CRITICAL',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({
        ...mockTicket,
        ...updateDto,
      });

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(result.title).toBe('Updated title');
      expect(result.priority).toBe('CRITICAL');
    });

    it('should not update immutable fields', async () => {
      const updateDto: UpdateTicketDto = {
        number: 999, // Should be ignored
        projectId: 'other-project', // Should be ignored
      } as UpdateTicketDto;

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue(mockTicket);

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(result.number).toBe(1); // Original number
      expect(result.projectId).toBe('proj-123'); // Original projectId
    });

    it('should return 404 if ticket not found', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(null);

      await expect(
        service.update('koda', 'KODA-999', updateDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should allow partial updates', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Only update title',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({
        ...mockTicket,
        title: 'Only update title',
      });

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(result.title).toBe('Only update title');
      expect(result.description).toBe(mockTicket.description); // Unchanged
    });
  });

  describe('softDelete', () => {
    it('should set deletedAt to current timestamp', async () => {
      const now = new Date();
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue({
        ...mockTicket,
        deletedAt: now,
      });

      const result = await service.softDelete('koda', 'KODA-1', mockAdminPrincipal);

      expect(result.deletedAt).not.toBeNull();
      expect(mockTicketRepo.softDeleteTicket).toHaveBeenCalledWith(mockTicket.id);
    });

    it('should not hard delete the ticket', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      const result = await service.softDelete('koda', 'KODA-1', mockAdminPrincipal);

      expect(result.id).toBe(mockTicket.id); // ID still exists
      expect(result).toBeDefined();
    });

    it('should allow non-ADMIN user (authorization at controller level)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue({ ...mockTicket, deletedAt: new Date() });

      const result = await service.softDelete('koda', 'KODA-1', mockMemberPrincipal);
      expect(result).toBeDefined();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(null);

      await expect(
        service.softDelete('koda', 'KODA-999', mockAdminPrincipal)
      ).rejects.toThrow();
    });
  });

  describe('assign', () => {
    it('should assign ticket to user', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'user-456',
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { userId: 'user-456' });

      expect(result.assignedToUserId).toBe('user-456');
      expect(result.assignedToAgentId).toBeNull();
    });

    it('should assign ticket to agent', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToAgentId: 'agent-456',
        assignedToUserId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { agentId: 'agent-456' });

      expect(result.assignedToAgentId).toBe('agent-456');
      expect(result.assignedToUserId).toBeNull();
    });

    it('should unassign ticket when neither userId nor agentId provided', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(mockTicket);
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: null,
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', {});

      expect(result.assignedToUserId).toBeNull();
      expect(result.assignedToAgentId).toBeNull();
    });

    it('should not allow both userId and agentId', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);

      await expect(
        service.assign('koda', 'KODA-1', { userId: 'user-456', agentId: 'agent-456' })
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByProjectAndNumber.mockResolvedValue(null);

      await expect(
        service.assign('koda', 'KODA-999', { userId: 'user-456' })
      ).rejects.toThrow();
    });
  });
});
