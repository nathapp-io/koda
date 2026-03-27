/**
 * US-003: Fix ticket status PATCH no-op — Unit tests
 *
 * Acceptance Criteria (AC-1 through AC-4):
 * AC-1: update() with status 'IN_PROGRESS' on CREATED ticket calls validateTransition and returns updated ticket
 * AC-2: update() passes status: 'IN_PROGRESS' to db.ticket.update() data
 * AC-3: update() with invalid transition throws ValidationAppException and never calls db.ticket.update()
 * AC-4: update() with no status in DTO does not include status key in updateData
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from '../../src/tickets/tickets.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { UpdateTicketDto } from '../../src/tickets/dto/update-ticket.dto';
import { TicketStatus } from '../../src/common/enums';
import * as ticketTransitions from '../../src/tickets/state-machine/ticket-transitions';

describe('US-003: TicketsService.update() — status field', () => {
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-1: valid transition calls validateTransition and returns updated ticket with new status', () => {
    it('calls validateTransition("CREATED", "IN_PROGRESS") without throwing and returns ticket with status IN_PROGRESS', async () => {
      const updateDto: UpdateTicketDto = {
        status: TicketStatus.IN_PROGRESS,
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...mockCreatedTicket,
        status: TicketStatus.IN_PROGRESS,
      });

      const validateSpy = jest.spyOn(ticketTransitions, 'validateTransition');

      const result = await service.update(
        'koda',
        'KODA-1',
        updateDto,
        { id: 'user-123', sub: 'user-123' },
        'user',
      );

      expect(validateSpy).toHaveBeenCalledWith(TicketStatus.CREATED, TicketStatus.IN_PROGRESS);
      expect(result.status).toBe(TicketStatus.IN_PROGRESS);
    });
  });

  describe('AC-2: valid transition passes status to db.ticket.update()', () => {
    it('includes status: "IN_PROGRESS" in the data passed to db.ticket.update()', async () => {
      const updateDto: UpdateTicketDto = {
        status: TicketStatus.IN_PROGRESS,
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...mockCreatedTicket,
        status: TicketStatus.IN_PROGRESS,
      });

      await service.update(
        'koda',
        'KODA-1',
        updateDto,
        { id: 'user-123', sub: 'user-123' },
        'user',
      );

      expect(mockPrismaService.client.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TicketStatus.IN_PROGRESS }),
        }),
      );
    });
  });

  describe('AC-3: invalid transition throws ValidationAppException and does not call db.ticket.update()', () => {
    it('throws when transitioning CREATED → CLOSED (invalid) and never calls db.ticket.update()', async () => {
      const updateDto: UpdateTicketDto = {
        status: TicketStatus.CLOSED,
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);

      await expect(
        service.update('koda', 'KODA-1', updateDto, { id: 'user-123', sub: 'user-123' }, 'user'),
      ).rejects.toThrow();

      expect(mockPrismaService.client.ticket.update).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: omitting status from DTO does not include status key in updateData', () => {
    it('does not pass a status key to db.ticket.update() when status is absent in DTO', async () => {
      const updateDto: UpdateTicketDto = {
        title: 'Updated title only',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockCreatedTicket);
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...mockCreatedTicket,
        title: 'Updated title only',
      });

      await service.update(
        'koda',
        'KODA-1',
        updateDto,
        { id: 'user-123', sub: 'user-123' },
        'user',
      );

      const updateCall = mockPrismaService.client.ticket.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('status');
    });
  });
});
