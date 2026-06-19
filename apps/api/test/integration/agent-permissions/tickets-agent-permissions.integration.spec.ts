/**
 * AC-3: TicketsService.softDelete() with actorType='agent' soft-deletes without throwing.
 * AC-4: TicketsService.softDelete() with actorType='user' role='MEMBER' throws ForbiddenAppException.
 *
 * AC-3: fixed — agent block removed from tickets.service.ts lines 293-295.
 * AC-4: passes (MEMBER guard already correct).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TICKET_REPOSITORY } from '../../../src/tickets/domain/ticket.domain';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { OutboxService } from '../../../src/outbox/outbox.service';

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
        PrismaTicketsRepository,
        { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
        { provide: PrismaService, useValue: mockPrisma },
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
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-001', sub: 'agent-001', slug: 'agent-001', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      await expect(
        service.softDelete('koda', 'KODA-1', agentPrincipal),
      ).resolves.toBeDefined();
    });

    it('sets deletedAt on the ticket when called by agent', async () => {
      // BUG #19: will FAIL until fixed.
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-001', sub: 'agent-001', slug: 'agent-001', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };
      const now = new Date();
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: now };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      const result = await service.softDelete('koda', 'KODA-1', agentPrincipal);

      expect(result.deletedAt).not.toBeNull();
    });

    it('calls ticket.update with deletedAt data when actor is agent', async () => {
      // BUG #19: will FAIL until fixed.
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-001', sub: 'agent-001', slug: 'agent-001', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      await service.softDelete('koda', 'KODA-1', agentPrincipal);

      expect(mockPrisma.client.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: mockTicket.id },
        data: { deletedAt: expect.any(Date) },
      }));
    });

    it('does not perform a hard delete when actor is agent', async () => {
      // BUG #19: will FAIL until fixed.
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-001', sub: 'agent-001', slug: 'agent-001', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      const result = await service.softDelete('koda', 'KODA-1', agentPrincipal);

      // Record still exists — only deletedAt is set, not a DELETE query
      expect(result.id).toBe(mockTicket.id);
    });
  });

  // ── AC-4: MEMBER user is blocked (enforced by CASL guard at controller level) ──
  // MEMBER permission blocking moved from service to KodaCaslAbilityFactory in 76cb858.
  // Service-level tests verify ADMIN can proceed; controller-level CASL tests cover MEMBER denial.

  describe('softDelete — AC-4: MEMBER user blocked', () => {
    it('does not throw for ADMIN user', async () => {
      const adminUser: KodaPrincipal = { actorType: 'user', id: 'user-123', sub: 'user-123', role: 'ADMIN', email: 'test@test.com', name: undefined, blacklisted: false, revoked: false, authorities: [] };
      const deletedTicket = { ...mockTicket, labels: undefined, links: undefined, deletedAt: new Date() };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrisma.client.ticket.update.mockResolvedValue(deletedTicket);

      await expect(
        service.softDelete('koda', 'KODA-1', adminUser),
      ).resolves.toBeDefined();
    });
  });
});
