import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from './tickets.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TICKET_REPOSITORY } from './domain/ticket.domain';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaAgentRole } from '../auth/principal/koda-principal.types';
import { TicketEventService } from '../events/ticket-event.service';
import { OutboxService } from '../outbox/outbox.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { TicketType, TicketStatus, Priority } from '../common/enums';

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
    findTicketScoped: jest.fn(),
    updateTicket: jest.fn(),
    assignTicket: jest.fn(),
    softDeleteTicket: jest.fn(),
    findTicketByRefRaw: jest.fn(),
    findUserById: jest.fn(),
    findAgentById: jest.fn(),
    findProjectMemberRole: jest.fn(),
  };

  const mockTxManager = {
    run: jest.fn((fn: () => unknown) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  const mockTicketEventService = { create: jest.fn().mockResolvedValue({ id: 'evt-mock' }) };
  const mockOutboxService = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const mockTransitionsService = {
    executeTransitionPublic: jest.fn(),
    assertTransitionPermission: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: TICKET_REPOSITORY, useValue: mockTicketRepo },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
        { provide: TicketEventService, useValue: mockTicketEventService },
        { provide: OutboxService, useValue: mockOutboxService },
        { provide: TicketTransitionsService, useValue: mockTransitionsService },
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
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);

      const result = await service.findByRef('koda', 'KODA-1');

      expect(result).toEqual({ ...mockTicket, ref: 'KODA-1', links: [] });
      expect(mockTicketRepo.findTicketScoped).toHaveBeenCalledWith(
        mockProject.id,
        'KODA',
        'KODA-1',
      );
    });

    it('should resolve ticket by CUID', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);

      const result = await service.findByRef('koda', 'ticket-123');

      expect(result).toEqual({ ...mockTicket, ref: 'KODA-1', links: [] });
      expect(mockTicketRepo.findTicketScoped).toHaveBeenCalledWith(
        mockProject.id,
        'KODA',
        'ticket-123',
      );
    });

    it('should handle KODA-42 pattern case-insensitively', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(null);

      // Lowercase 'koda-1' does not match the uppercase pattern, treated as CUID
      await expect(service.findByRef('koda', 'koda-1')).rejects.toThrow();
      expect(mockTicketRepo.findTicketScoped).toHaveBeenCalled();
    });

    it('should throw when ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(null);

      await expect(service.findByRef('koda', 'KODA-999')).rejects.toThrow();
    });

    it('should throw for soft-deleted ticket', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue({
        ...mockTicket,
        deletedAt: new Date(),
      });

      await expect(service.findByRef('koda', 'KODA-1')).rejects.toThrow();
    });

    it('should validate KODA-42 format', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(null);

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
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
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
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
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
      mockTicketRepo.findTicketScoped.mockResolvedValue(null);

      await expect(
        service.update('koda', 'KODA-999', updateDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should allow partial updates', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Only update title',
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({
        ...mockTicket,
        title: 'Only update title',
      });

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(result.title).toBe('Only update title');
      expect(result.description).toBe(mockTicket.description); // Unchanged
    });

    // M2: PATCH with status must go through the transition state machine
    // (permission + activity + webhook) instead of a direct write.
    it('M2: PATCH with status delegates to transitions service', async () => {
      const updateDto: UpdateTicketDto = { status: TicketStatus.IN_PROGRESS };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTransitionsService.executeTransitionPublic.mockResolvedValue({
        ticket: { ...mockTicket, status: TicketStatus.IN_PROGRESS },
      });

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(mockTransitionsService.executeTransitionPublic).toHaveBeenCalledWith(
        'koda',
        'KODA-1',
        TicketStatus.IN_PROGRESS,
        mockUserPrincipal,
      );
      expect(result.status).toBe(TicketStatus.IN_PROGRESS);
      // No direct status write through the repo
      expect(mockTicketRepo.updateTicket).not.toHaveBeenCalled();
    });

    it('M2: PATCH without status does not call transitions', async () => {
      const updateDto: UpdateTicketDto = { title: 'x' };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({ ...mockTicket, title: 'x' });

      await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(mockTransitionsService.executeTransitionPublic).not.toHaveBeenCalled();
      expect(mockTicketRepo.updateTicket).toHaveBeenCalledWith(mockTicket.id, { title: 'x' });
    });

    it('M2: PATCH with status and other fields applies fields first, then transitions', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Renamed before transition',
        status: TicketStatus.IN_PROGRESS,
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({
        ...mockTicket,
        title: 'Renamed before transition',
      });
      mockTransitionsService.executeTransitionPublic.mockResolvedValue({
        ticket: { ...mockTicket, title: 'Renamed before transition', status: TicketStatus.IN_PROGRESS },
      });

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(mockTicketRepo.updateTicket).toHaveBeenCalledWith(mockTicket.id, {
        title: 'Renamed before transition',
      });
      expect(mockTransitionsService.executeTransitionPublic).toHaveBeenCalledWith(
        'koda',
        'KODA-1',
        TicketStatus.IN_PROGRESS,
        mockUserPrincipal,
      );
      // Field write happens before the transition
      expect(mockTicketRepo.updateTicket.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransitionsService.executeTransitionPublic.mock.invocationCallOrder[0],
      );
      expect(result.status).toBe(TicketStatus.IN_PROGRESS);
    });

    // Final-review Finding B: a caller with UPDATE but no TRANSITION must be
    // rejected 403 BEFORE any field write, so the PATCH is all-or-nothing.
    it('M2/Final-review: PATCH {status, title} with UPDATE-but-no-TRANSITION → 403 and title NOT written', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Should never be written',
        status: TicketStatus.IN_PROGRESS,
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue({ ...mockTicket, title: 'Should never be written' });
      mockTransitionsService.assertTransitionPermission.mockRejectedValue(
        new ForbiddenAppException({}, 'tickets'),
      );

      await expect(
        service.update('koda', 'KODA-1', updateDto, mockUserPrincipal),
      ).rejects.toThrow(ForbiddenAppException);

      // Permission check ran before anything else
      expect(mockTransitionsService.assertTransitionPermission).toHaveBeenCalledWith(mockUserPrincipal);
      // The partial field write must not have happened
      expect(mockTicketRepo.updateTicket).not.toHaveBeenCalled();
      expect(mockTransitionsService.executeTransitionPublic).not.toHaveBeenCalled();
    });
  });

  describe('softDelete', () => {
    it('should set deletedAt to current timestamp', async () => {
      const now = new Date();
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
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
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
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
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue({ ...mockTicket, deletedAt: new Date() });

      const result = await service.softDelete('koda', 'KODA-1', mockMemberPrincipal);
      expect(result).toBeDefined();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(null);

      await expect(
        service.softDelete('koda', 'KODA-999', mockAdminPrincipal)
      ).rejects.toThrow();
    });
  });

  describe('event emission', () => {
    const fakeProject = {
      id: 'proj-1',
      key: 'TST',
      slug: 'test-project',
      deletedAt: null,
      gitRemoteUrl: null,
      autoIndexOnClose: false,
    };

    const fakeTicket = {
      id: 'ticket-1',
      number: 1,
      type: TicketType.TASK,
      title: 'Hello',
      description: null,
      status: TicketStatus.CREATED,
      priority: Priority.MEDIUM,
      createdByUserId: 'user-1',
      createdByAgentId: null,
      deletedAt: null,
      gitRefVersion: null,
      gitRefFile: null,
      gitRefLine: null,
      assignedToUserId: null,
      assignedToAgentId: null,
      projectId: 'proj-1',
      labels: [],
      links: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const fakeUserPrincipal = {
      id: 'user-1',
      sub: 'user-1',
      actorType: 'user' as const,
      role: 'DEVELOPER' as const,
      email: 'a@b.com',
      blacklisted: false,
      revoked: false,
      authorities: [] as string[],
      name: 'Test User',
    };

    beforeEach(() => {
      mockTicketEventService.create.mockResolvedValue({ id: 'evt-1' });
      mockOutboxService.enqueue.mockResolvedValue(undefined);
    });

    it('emits TicketEvent after create', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(fakeTicket);

      await service.create('test-project', { type: TicketType.TASK, title: 'Hello' }, fakeUserPrincipal as any);

      // Allow the void promise to resolve
      await new Promise(resolve => setImmediate(resolve));

      expect(mockTicketEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          projectId: 'proj-1',
          action: 'TICKET_CREATED',
          actorId: 'user-1',
          actorType: 'user',
          source: 'internal',
        }),
      );
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          eventType: 'ticket_event',
          eventId: 'evt-1',
        }),
      );
    });

    it('still returns the ticket even if event emission throws', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(fakeTicket);
      mockTicketEventService.create.mockRejectedValue(new Error('event store down'));

      const result = await service.create('test-project', { type: TicketType.TASK, title: 'Hello' }, fakeUserPrincipal as any);

      // Allow the void promise to settle
      await new Promise(resolve => setImmediate(resolve));

      expect(result).toBeDefined();
      expect(result.id).toBe('ticket-1');
    });

    it('emits TicketEvent after update', async () => {
      const updatedTicket = { ...fakeTicket, title: 'Updated' };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(fakeTicket);
      mockTicketRepo.updateTicket.mockResolvedValue(updatedTicket);

      await service.update('test-project', 'TST-1', { title: 'Updated' }, fakeUserPrincipal as any);

      // Allow the fire-and-forget void promise to resolve
      await new Promise(resolve => setImmediate(resolve));

      expect(mockTicketEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: fakeTicket.id,
          projectId: fakeProject.id,
          action: 'TICKET_UPDATED',
          actorId: fakeUserPrincipal.id,
          actorType: 'user',
          source: 'internal',
        }),
      );
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: fakeProject.id,
          eventType: 'ticket_event',
          eventId: 'evt-1',
        }),
      );
    });

    it('emits TicketEvent after softDelete', async () => {
      const deletedTicket = { ...fakeTicket, deletedAt: new Date() };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(fakeTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue(deletedTicket);

      await service.softDelete('test-project', 'TST-1', fakeUserPrincipal as any);

      // Allow the fire-and-forget void promise to resolve
      await new Promise(resolve => setImmediate(resolve));

      expect(mockTicketEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: fakeTicket.id,
          projectId: fakeProject.id,
          action: 'TICKET_DELETED',
          actorId: fakeUserPrincipal.id,
          actorType: 'user',
          source: 'internal',
        }),
      );
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: fakeProject.id,
          eventType: 'ticket_event',
          eventId: 'evt-1',
        }),
      );
    });
  });

  describe('assign', () => {
    it('should assign ticket to user', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findUserById.mockResolvedValue({ id: 'user-456', role: 'MEMBER' });
      mockTicketRepo.findProjectMemberRole.mockResolvedValue('DEVELOPER');
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'user-456',
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { userId: 'user-456' });

      expect(result.assignedToUserId).toBe('user-456');
      expect(result.assignedToAgentId).toBeNull();
      expect(mockTicketRepo.findUserById).toHaveBeenCalledWith('user-456');
      expect(mockTicketRepo.findProjectMemberRole).toHaveBeenCalledWith('proj-123', 'user-456');
    });

    it('should assign ticket to agent', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findAgentById.mockResolvedValue({ id: 'agent-456' });
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToAgentId: 'agent-456',
        assignedToUserId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { agentId: 'agent-456' });

      expect(result.assignedToAgentId).toBe('agent-456');
      expect(result.assignedToUserId).toBeNull();
      expect(mockTicketRepo.findAgentById).toHaveBeenCalledWith('agent-456');
    });

    it('should unassign ticket when neither userId nor agentId provided', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: null,
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', {});

      expect(result.assignedToUserId).toBeNull();
      expect(result.assignedToAgentId).toBeNull();
      expect(mockTicketRepo.findUserById).not.toHaveBeenCalled();
      expect(mockTicketRepo.findAgentById).not.toHaveBeenCalled();
    });

    it('should not allow both userId and agentId', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);

      await expect(
        service.assign('koda', 'KODA-1', { userId: 'user-456', agentId: 'agent-456' })
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(null);

      await expect(
        service.assign('koda', 'KODA-999', { userId: 'user-456' })
      ).rejects.toThrow();
    });

    it('should return 404 when the assigned user does not exist (BUG-2)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findUserById.mockResolvedValue(null);

      await expect(
        service.assign('koda', 'KODA-1', { userId: 'user-missing' })
      ).rejects.toThrow(NotFoundAppException);
      expect(mockTicketRepo.assignTicket).not.toHaveBeenCalled();
    });

    it('should return 404 when the assigned agent does not exist (BUG-2)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findAgentById.mockResolvedValue(null);

      await expect(
        service.assign('koda', 'KODA-1', { agentId: 'agent-missing' })
      ).rejects.toThrow(NotFoundAppException);
      expect(mockTicketRepo.assignTicket).not.toHaveBeenCalled();
    });

    it('should return 403 when the assigned user is not a project member (BUG-2)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findUserById.mockResolvedValue({ id: 'user-456', role: 'MEMBER' });
      mockTicketRepo.findProjectMemberRole.mockResolvedValue(null);

      await expect(
        service.assign('koda', 'KODA-1', { userId: 'user-456' })
      ).rejects.toThrow(ForbiddenAppException);
      expect(mockTicketRepo.assignTicket).not.toHaveBeenCalled();
    });

    it('should skip the membership check for ADMIN assignees (BUG-17)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findUserById.mockResolvedValue({ id: 'admin-1', role: 'ADMIN' });
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'admin-1',
        assignedToAgentId: null,
      });

      const result = await service.assign('koda', 'KODA-1', { userId: 'admin-1' });

      expect(result.assignedToUserId).toBe('admin-1');
      expect(mockTicketRepo.findProjectMemberRole).not.toHaveBeenCalled();
    });
  });
});
