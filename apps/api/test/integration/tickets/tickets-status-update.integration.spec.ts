/**
 * US-003 / M2: ticket status PATCH routes through the transition state machine
 *
 * Acceptance Criteria (AC-1 through AC-4, adapted for M2):
 * AC-1: update() with status 'IN_PROGRESS' on a CREATED ticket delegates to
 *       TicketTransitionsService.executeTransitionPublic and the caller sees the
 *       ticket with the new status
 * AC-2: update() passes the requested status to the transitions service (not to
 *       db.ticket.update() directly)
 * AC-3: update() with a status the transitions service rejects (invalid
 *       transition) propagates the exception and never writes via the repo
 * AC-4: update() with no status in DTO does not call the transitions service
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TICKET_REPOSITORY } from '../../../src/tickets/domain/ticket.domain';
import { UpdateTicketDto } from '../../../src/tickets/dto/update-ticket.dto';
import { TicketStatus } from '../../../src/common/enums';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { OutboxService } from '../../../src/outbox/outbox.service';

describe('US-003 (M2): TicketsService.update() — status field routes through transitions', () => {
  let service: TicketsService;

  const mockProject = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockCreatedTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: 'Users cannot login',
    status: TicketStatus.CREATED,
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: 'user-123',
    createdByAgentId: null,
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockUserPrincipal = {
    id: 'user-123',
    sub: 'user-123',
  } as unknown as KodaPrincipal;

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
      ticket: {
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };

  const mockTransitionsService = {
    executeTransitionPublic: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        PrismaTicketsRepository,
        { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: jest.fn((fn: () => Promise<unknown>) => fn()),
            getClient: jest.fn(),
            isInTransaction: jest.fn(() => false),
          },
        },
        { provide: TicketEventService, useValue: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) } },
        { provide: OutboxService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
        { provide: TicketTransitionsService, useValue: mockTransitionsService },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-1: valid status change delegates to the transitions service and returns the updated ticket', () => {
    it('calls executeTransitionPublic("koda", "KODA-1", IN_PROGRESS, principal) and returns the ticket with status IN_PROGRESS', async () => {
      const updateDto: UpdateTicketDto = {
        status: TicketStatus.IN_PROGRESS,
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      mockTransitionsService.executeTransitionPublic.mockResolvedValue({
        ticket: { ...mockCreatedTicket, status: TicketStatus.IN_PROGRESS },
      });

      const result = await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(mockTransitionsService.executeTransitionPublic).toHaveBeenCalledWith(
        'koda',
        'KODA-1',
        TicketStatus.IN_PROGRESS,
        mockUserPrincipal,
      );
      expect(result.status).toBe(TicketStatus.IN_PROGRESS);
    });
  });

  describe('AC-2: valid status change does not write status directly to db.ticket.update()', () => {
    it('routes the status through the transitions service instead of db.ticket.update()', async () => {
      const updateDto: UpdateTicketDto = {
        status: TicketStatus.IN_PROGRESS,
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      mockTransitionsService.executeTransitionPublic.mockResolvedValue({
        ticket: { ...mockCreatedTicket, status: TicketStatus.IN_PROGRESS },
      });

      await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(mockTransitionsService.executeTransitionPublic).toHaveBeenCalled();
      expect(mockPrismaService.client.ticket.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-3: invalid transition surfaces the transitions service error and never writes directly', () => {
    it('propagates the rejection from executeTransitionPublic and does not call db.ticket.update()', async () => {
      const updateDto: UpdateTicketDto = {
        status: TicketStatus.CLOSED,
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      // The transitions service owns state-machine validation; an invalid
      // transition (CREATED → CLOSED) is rejected there.
      mockTransitionsService.executeTransitionPublic.mockRejectedValue(
        new Error('Invalid status transition'),
      );

      await expect(
        service.update('koda', 'KODA-1', updateDto, mockUserPrincipal),
      ).rejects.toThrow();

      expect(mockPrismaService.client.ticket.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: omitting status from DTO does not involve the transitions service', () => {
    it('does not call the transitions service when status is absent in DTO', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title only',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...mockCreatedTicket,
        title: 'Updated title only',
      });

      await service.update('koda', 'KODA-1', updateDto, mockUserPrincipal);

      expect(mockTransitionsService.executeTransitionPublic).not.toHaveBeenCalled();
      const updateCall = mockPrismaService.client.ticket.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('status');
    });
  });
});
