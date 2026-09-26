import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from './tickets.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma } from '@prisma/client';
import { TICKET_REPOSITORY } from './domain/ticket.domain';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { NotFoundAppException, ForbiddenAppException, Page } from '@nathapp/nestjs-common';
import type { KodaAgentRole } from '../auth/principal/koda-principal.types';
import { TicketEventService } from '../events/ticket-event.service';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
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
    findTicketPage: jest.fn(),
    findTicketScoped: jest.fn(),
    updateTicket: jest.fn(),
    assignTicket: jest.fn(),
    softDeleteTicket: jest.fn(),
    findTicketByRefRaw: jest.fn(),
    findUserById: jest.fn(),
    findAgentById: jest.fn(),
    findProjectMemberRole: jest.fn(),
  };

  let inTx = false;
  const mockTxManager = {
    run: jest.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn();
      } finally {
        inTx = false;
      }
    }),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => inTx),
  };

  const mockTicketEventService = { create: jest.fn().mockResolvedValue({ id: 'evt-mock' }) };
  const mockOutbox = { record: jest.fn().mockResolvedValue(undefined) };

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
        { provide: NathappOutboxService, useValue: mockOutbox },
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

    it('retries ticket creation on a concurrent-number conflict (M6)', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['projectId', 'number'] },
      });
      // Only the first run() attempt hits the conflict; the retry falls through
      // to the default in-transaction implementation above.
      mockTxManager.run.mockImplementationOnce(() => Promise.reject(conflict));
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.createTicket.mockResolvedValue(mockTicket);

      await service.create('koda', { type: 'TASK', title: 'x' } as CreateTicketDto, mockUserPrincipal);

      expect(mockTxManager.run).toHaveBeenCalledTimes(2);
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
    const page1 = { current: 1, size: 20 };

    it('returns a page of response DTOs with refs and gitRefUrl', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketPage.mockResolvedValue(new Page(page1, 1, [mockTicket]));

      const result = await service.findAll('koda', {}, page1);

      expect(result.total).toBe(1);
      expect(result.current).toBe(1);
      expect(result.size).toBe(20);
      expect(result.hasNext).toBe(false);
      expect(result.records).toEqual([expect.objectContaining({ ref: 'KODA-1' })]);
      expect(result.records[0]).toHaveProperty('gitRefUrl');
    });

    it('maps filters to the repository and passes the page through', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketPage.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

      await service.findAll(
        'koda',
        { status: 'IN_PROGRESS', type: 'BUG', priority: 'HIGH', assignedTo: 'user-1', unassigned: false },
        { current: 2, size: 5 },
      );

      expect(mockTicketRepo.findTicketPage).toHaveBeenCalledWith(
        {
          projectId: mockProject.id,
          status: 'IN_PROGRESS',
          type: 'BUG',
          priority: 'HIGH',
          assignedToUserId: 'user-1',
          unassigned: false,
        },
        { current: 2, size: 5 },
      );
    });

    it('throws NotFound for a missing or soft-deleted project', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });
      await expect(service.findAll('koda', {}, page1)).rejects.toThrow(NotFoundAppException);
      expect(mockTicketRepo.findTicketPage).not.toHaveBeenCalled();
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
      // The outbox envelope echoes the stored event's action/timestamp, so the
      // mocked TicketEvent carries them from the create() input.
      mockTicketEventService.create.mockImplementation(async (input: { action: string }) => ({
        id: 'evt-1',
        action: input.action,
        timestamp: new Date('2026-01-01T00:00:00Z'),
      }));
      mockOutbox.record.mockResolvedValue(undefined);
    });

    it('emits TicketEvent after create', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(fakeTicket);

      await service.create('test-project', { type: TicketType.TASK, title: 'Hello' }, fakeUserPrincipal as any);

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
      expect(mockOutbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          payload: expect.objectContaining({ action: 'TICKET_CREATED', ticketId: 'ticket-1', projectId: 'proj-1' }),
          metadata: { projectId: 'proj-1', eventId: 'evt-1' },
        }),
      );
    });

    it('fails create() when event emission throws (no silent drop)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(fakeTicket);
      mockTicketEventService.create.mockRejectedValue(new Error('event store down'));

      await expect(
        service.create('test-project', { type: TicketType.TASK, title: 'Hello' }, fakeUserPrincipal as any),
      ).rejects.toThrow('event store down');
    });

    it('emits TicketEvent after update', async () => {
      const updatedTicket = { ...fakeTicket, title: 'Updated' };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(fakeTicket);
      mockTicketRepo.updateTicket.mockResolvedValue(updatedTicket);

      await service.update('test-project', 'TST-1', { title: 'Updated' }, fakeUserPrincipal as any);

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
      expect(mockOutbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          payload: expect.objectContaining({ action: 'TICKET_UPDATED', ticketId: fakeTicket.id, projectId: fakeProject.id }),
          metadata: { projectId: fakeProject.id, eventId: 'evt-1' },
        }),
      );
    });

    it('H13: ticket outbox payload carries the full event envelope', async () => {
      mockTicketEventService.create.mockResolvedValue({
        id: 'evt-1',
        ticketId: 't1',
        projectId: 'p1',
        action: 'status_changed',
        actorId: 'user-1',
        actorType: 'user',
        source: 'internal',
        data: '{}',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      });

      await service['recordTicketEvent']('t1', 'p1', 'status_changed', fakeUserPrincipal as never, {
        newStatus: 'IN_PROGRESS',
      });

      expect(mockOutbox.record).toHaveBeenCalledTimes(1);
      const call = mockOutbox.record.mock.calls[0][0];
      expect(call).toEqual({
        type: 'ticket_event',
        payload: {
          id: 'evt-1',
          type: 'ticket_event',
          action: 'status_changed',
          timestamp: '2026-01-01T00:00:00.000Z',
          ticketId: 't1',
          projectId: 'p1',
          actorId: 'user-1',
          actorType: 'user',
          data: { newStatus: 'IN_PROGRESS' },
        },
        metadata: { projectId: 'p1', eventId: 'evt-1' },
      });
    });

    it('emits TicketEvent after softDelete', async () => {
      const deletedTicket = { ...fakeTicket, deletedAt: new Date() };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(fakeProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(fakeTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue(deletedTicket);

      await service.softDelete('test-project', 'TST-1', fakeUserPrincipal as any);

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
      expect(mockOutbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          payload: expect.objectContaining({ action: 'TICKET_DELETED', ticketId: fakeTicket.id, projectId: fakeProject.id }),
          metadata: { projectId: fakeProject.id, eventId: 'evt-1' },
        }),
      );
    });
  });

  describe('outbox atomicity (record inside the write transaction)', () => {
    beforeEach(() => {
      mockOutbox.record.mockReset();
      mockOutbox.record.mockResolvedValue(undefined);
    });

    it('create() records the TICKET_CREATED event inside the ticket-create transaction', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(mockTicket);
      mockOutbox.record.mockImplementation(async () => {
        expect(inTx).toBe(true);
      });

      await service.create('koda', { type: 'BUG', title: 'Fix login bug' } as CreateTicketDto, mockUserPrincipal);

      expect(mockOutbox.record).toHaveBeenCalledTimes(1);
    });

    it('create() fails when the outbox record fails (no silent drop)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findLastTicketInProject.mockResolvedValue(null);
      mockTicketRepo.createTicket.mockResolvedValue(mockTicket);
      mockOutbox.record.mockRejectedValue(new Error('outbox down'));

      await expect(
        service.create('koda', { type: 'BUG', title: 'Fix login bug' } as CreateTicketDto, mockUserPrincipal),
      ).rejects.toThrow('outbox down');
    });

    it('update(), softDelete() and assign() record inside their transactions', async () => {
      const seen: boolean[] = [];
      mockOutbox.record.mockImplementation(async () => {
        seen.push(inTx);
      });
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicket.mockResolvedValue(mockTicket);
      mockTicketRepo.softDeleteTicket.mockResolvedValue(mockTicket);
      mockTicketRepo.findUserById.mockResolvedValue({ id: 'user-1', role: 'ADMIN' });
      mockTicketRepo.assignTicket.mockResolvedValue(mockTicket);

      await service.update('koda', 'KODA-1', { title: 'New' }, mockUserPrincipal);
      await service.softDelete('koda', 'KODA-1', mockUserPrincipal);
      await service.assign('koda', 'KODA-1', { userId: 'user-1' }, mockUserPrincipal);

      expect(seen).toEqual([true, true, true]);
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

    it('H13: assign emits an assigned ticket_event with the full envelope', async () => {
      mockTicketEventService.create.mockResolvedValue({
        id: 'evt-assign-1',
        ticketId: 'ticket-123',
        projectId: 'proj-123',
        action: 'assigned',
        actorId: 'user-123',
        actorType: 'user',
        source: 'internal',
        data: '{}',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      });
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockTicketRepo.findUserById.mockResolvedValue({ id: 'user-456', role: 'ADMIN' });
      mockTicketRepo.assignTicket.mockResolvedValue({
        ...mockTicket,
        assignedToUserId: 'user-456',
        assignedToAgentId: null,
      });

      await service.assign('koda', 'KODA-1', { userId: 'user-456' }, mockUserPrincipal);

      expect(mockTicketEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-123',
          projectId: 'proj-123',
          action: 'assigned',
          actorId: 'user-123',
          actorType: 'user',
          source: 'internal',
          data: { assignedTo: 'user-456' },
        }),
      );
      expect(mockOutbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          payload: expect.objectContaining({ action: 'assigned', ticketId: 'ticket-123', projectId: 'proj-123' }),
          metadata: { projectId: 'proj-123', eventId: 'evt-assign-1' },
        }),
      );
    });
  });
});
