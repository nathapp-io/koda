/**
 * AC-3: TicketsService.softDelete() with actorType='agent' soft-deletes without throwing.
 * AC-4: TicketsService.softDelete() with actorType='user' role='MEMBER' throws ForbiddenAppException.
 *
 * Tests must fail for unimplemented behavior (RED phase).
 * Currently: AC-3 FAILS (bug #19 — explicit agent block at lines 293-295 of tickets.service.ts).
 *            AC-4 passes (MEMBER guard already correct).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

describe('TicketsService — agent permissions', () => {
  let service: TicketsService;

  const mockProject = {
    id: 'proj-001',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockTicket = {
    id: 'ticket-001',
    projectId: 'proj-001',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: null,
    status: 'CREATED',
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: null,
    createdByAgentId: 'agent-001',
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    labels: [],
    links: [],
  };

  const mockPrisma = {
    client: {
      project: { findUnique: jest.fn() },
      ticket: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── AC-3: agent actor allowed to delete ─────────────────────────

  describe('softDelete — AC-3: agent actor allowed (bug #19)', () => {
    it('resolves without throwing when actorType is agent', async () => {
      // BUG #19: tickets.service.ts lines 293-295 explicitly throw ForbiddenAppException
      // for agents — this test will FAIL until the bug is fixed (RED phase).
      const agentPrincipal = { id: 'agent-001', sub: 'agent-001' };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      await expect(
        service.softDelete('koda', 'KODA-1', agentPrincipal, 'agent'),
      ).resolves.toBeDefined();
    });

    it('sets deletedAt on the ticket when called by agent', async () => {
      // BUG #19: will FAIL until fixed.
      const agentPrincipal = { id: 'agent-001', sub: 'agent-001' };
      const now = new Date();
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: now };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      const result = await service.softDelete('koda', 'KODA-1', agentPrincipal, 'agent');

      expect(result.deletedAt).not.toBeNull();
    });

    it('calls ticket.update with deletedAt data when actor is agent', async () => {
      // BUG #19: will FAIL until fixed.
      const agentPrincipal = { id: 'agent-001', sub: 'agent-001' };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      await service.softDelete('koda', 'KODA-1', agentPrincipal, 'agent');

      expect(mockPrisma.client.ticket.update).toHaveBeenCalledWith({
        where: { id: mockTicket.id },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('does not perform a hard delete when actor is agent', async () => {
      // BUG #19: will FAIL until fixed.
      const agentPrincipal = { id: 'agent-001', sub: 'agent-001' };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      const result = await service.softDelete('koda', 'KODA-1', agentPrincipal, 'agent');

      // Record still exists — only deletedAt is set, not a DELETE query
      expect(result.id).toBe(mockTicket.id);
    });
  });

  // ── AC-4: MEMBER user is blocked ────────────────────────────────

  describe('softDelete — AC-4: MEMBER user blocked', () => {
    it('throws when actorType is user with role MEMBER', async () => {
      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };

      await expect(
        service.softDelete('koda', 'KODA-1', memberUser, 'user'),
      ).rejects.toThrow();
    });

    it('throws before reaching the database for MEMBER user', async () => {
      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };

      await expect(
        service.softDelete('koda', 'KODA-1', memberUser, 'user'),
      ).rejects.toThrow();

      expect(mockPrisma.client.project.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.client.ticket.findUnique).not.toHaveBeenCalled();
    });

    it('does not throw for ADMIN user', async () => {
      const adminUser = { id: 'user-123', sub: 'user-123', role: 'ADMIN' };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      await expect(
        service.softDelete('koda', 'KODA-1', adminUser, 'user'),
      ).resolves.toBeDefined();
    });
  });
});
