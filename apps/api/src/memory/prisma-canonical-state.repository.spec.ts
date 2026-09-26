import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaCanonicalStateRepository } from './prisma-canonical-state.repository';

const makeTicketRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ticket-1',
  title: 'Fix bug',
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  assignedToUserId: 'user-1',
  assignedToAgentId: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-02'),
  ...overrides,
});

const makeTicketEventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'te-1',
  actorId: 'actor-1',
  action: 'STATUS_CHANGE',
  data: JSON.stringify({ status: 'CLOSED' }),
  createdAt: new Date('2025-01-02'),
  ...overrides,
});

const makeAgentEventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ae-1',
  actorId: 'actor-1',
  action: 'decision_made',
  data: JSON.stringify({ decision: 'use REST' }),
  createdAt: new Date('2025-01-01'),
  ...overrides,
});

const makeDecisionEventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'de-1',
  agentId: 'agent-1',
  action: 'decided',
  data: JSON.stringify({ reason: 'performance' }),
  rationale: 'Better scalability',
  createdAt: new Date('2025-01-03'),
  ...overrides,
});

const makeMemoryItemRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  predicate: 'architecture',
  object: 'use microservices',
  createdAt: new Date('2025-01-01'),
  ...overrides,
});

describe('PrismaCanonicalStateRepository', () => {
  let repository: PrismaCanonicalStateRepository;

  const mockTicketEvent = { findMany: jest.fn() };
  const mockAgentEvent = { findMany: jest.fn() };
  const mockDecisionEvent = { findMany: jest.fn() };
  const mockMemoryItem = { findMany: jest.fn() };
  const mockProject = { findUnique: jest.fn() };
  const mockTicket = { findMany: jest.fn() };

  const mockPrismaClient = {
    project: mockProject,
    ticket: mockTicket,
    ticketEvent: mockTicketEvent,
    agentEvent: mockAgentEvent,
    decisionEvent: mockDecisionEvent,
    memoryItem: mockMemoryItem,
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaCanonicalStateRepository,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    repository = module.get<PrismaCanonicalStateRepository>(PrismaCanonicalStateRepository);

    jest.clearAllMocks();
  });

  describe('findProject', () => {
    it('returns the project when found', async () => {
      const project = { id: 'project-1', deletedAt: null };
      mockProject.findUnique.mockResolvedValue(project);

      const result = await repository.findProject('project-1');

      expect(result).toEqual(project);
      expect(mockProject.findUnique).toHaveBeenCalledWith({ where: { id: 'project-1' } });
    });

    it('returns null when project is not found', async () => {
      mockProject.findUnique.mockResolvedValue(null);

      const result = await repository.findProject('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findTickets', () => {
    it('returns empty array when ticketIds is empty', async () => {
      const result = await repository.findTickets({ projectId: 'project-1', ticketIds: [] });
      expect(result).toEqual([]);
      expect(mockTicket.findMany).not.toHaveBeenCalled();
    });

    it('returns empty array when ticketIds is undefined', async () => {
      const result = await repository.findTickets({ projectId: 'project-1' });
      expect(result).toEqual([]);
      expect(mockTicket.findMany).not.toHaveBeenCalled();
    });

    it('queries tickets filtered by projectId and ticketIds', async () => {
      const rows = [makeTicketRow()];
      mockTicket.findMany.mockResolvedValue(rows);

      const result = await repository.findTickets({
        projectId: 'project-1',
        ticketIds: ['ticket-1'],
      });

      expect(mockTicket.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'project-1',
          id: { in: ['ticket-1'] },
          deletedAt: null,
        },
        select: expect.objectContaining({
          id: true,
          title: true,
          status: true,
          priority: true,
        }),
      });
      expect(result).toEqual(rows);
    });
  });

  describe('findEvents', () => {
    it('returns empty array when no timeWindow and no actorId provided', async () => {
      const result = await repository.findEvents({ projectId: 'project-1' });
      expect(result).toEqual([]);
      expect(mockTicketEvent.findMany).not.toHaveBeenCalled();
    });

    it('fetches and merges ticket, agent and decision events sorted by createdAt DESC', async () => {
      const ticketRow = makeTicketEventRow({ id: 'te-1', createdAt: new Date('2025-01-02') });
      const agentRow = makeAgentEventRow({ id: 'ae-1', createdAt: new Date('2025-01-01') });
      const decisionRow = makeDecisionEventRow({ id: 'de-1', createdAt: new Date('2025-01-03') });

      mockTicketEvent.findMany.mockResolvedValue([ticketRow]);
      mockAgentEvent.findMany.mockResolvedValue([agentRow]);
      mockDecisionEvent.findMany.mockResolvedValue([decisionRow]);

      const result = await repository.findEvents({
        projectId: 'project-1',
        timeWindow: { from: new Date('2025-01-01'), to: new Date('2025-01-04') },
      });

      expect(result).toHaveLength(3);
      // sorted DESC: de-1 (jan3), te-1 (jan2), ae-1 (jan1)
      expect(result[0].id).toBe('de-1');
      expect(result[0].eventType).toBe('decision_event');
      expect(result[1].id).toBe('te-1');
      expect(result[1].eventType).toBe('ticket_event');
      expect(result[2].id).toBe('ae-1');
      expect(result[2].eventType).toBe('agent_event');
    });

    it('maps decision event agentId to actorId in the result', async () => {
      mockTicketEvent.findMany.mockResolvedValue([]);
      mockAgentEvent.findMany.mockResolvedValue([]);
      mockDecisionEvent.findMany.mockResolvedValue([
        makeDecisionEventRow({ agentId: 'agent-99' }),
      ]);

      const result = await repository.findEvents({
        projectId: 'project-1',
        timeWindow: { from: new Date('2025-01-01') },
      });

      expect(result[0].actorId).toBe('agent-99');
    });

    it('includes rationale from decision events', async () => {
      mockTicketEvent.findMany.mockResolvedValue([]);
      mockAgentEvent.findMany.mockResolvedValue([]);
      mockDecisionEvent.findMany.mockResolvedValue([
        makeDecisionEventRow({ rationale: 'Better scalability' }),
      ]);

      const result = await repository.findEvents({
        projectId: 'project-1',
        timeWindow: { from: new Date('2025-01-01') },
      });

      expect(result[0].rationale).toBe('Better scalability');
    });

    it('gracefully handles malformed JSON data by returning empty payload', async () => {
      mockTicketEvent.findMany.mockResolvedValue([
        makeTicketEventRow({ data: 'not-valid-json' }),
      ]);
      mockAgentEvent.findMany.mockResolvedValue([]);
      mockDecisionEvent.findMany.mockResolvedValue([]);

      const result = await repository.findEvents({
        projectId: 'project-1',
        timeWindow: { from: new Date('2025-01-01') },
      });

      expect(result[0].payload).toEqual({});
    });

    it('filters by actorId when provided without timeWindow', async () => {
      mockTicketEvent.findMany.mockResolvedValue([]);
      mockAgentEvent.findMany.mockResolvedValue([]);
      mockDecisionEvent.findMany.mockResolvedValue([]);

      await repository.findEvents({
        projectId: 'project-1',
        actorId: 'actor-42',
      });

      expect(mockTicketEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ actorId: 'actor-42' }),
        }),
      );
    });

    it('pushes take into all three event tables and returns the newest eventLimit overall', async () => {
      const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
      mockTicketEvent.findMany.mockResolvedValue([
        { id: 't3', actorId: 'u', action: 'a', data: '{}', createdAt: t(3) },
        { id: 't1', actorId: 'u', action: 'a', data: '{}', createdAt: t(1) },
      ]);
      mockAgentEvent.findMany.mockResolvedValue([
        { id: 'a2', actorId: 'u', action: 'a', data: '{}', createdAt: t(2) },
      ]);
      mockDecisionEvent.findMany.mockResolvedValue([
        { id: 'd4', agentId: 'u', action: 'a', data: '{}', rationale: null, createdAt: t(4) },
      ]);

      const events = await repository.findEvents({ projectId: 'p1', timeWindow: { from: new Date(0) }, eventLimit: 2 });

      for (const model of [mockTicketEvent, mockAgentEvent, mockDecisionEvent]) {
        expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
      }
      expect(events.map((e) => e.id)).toEqual(['d4', 't3']);
    });

    it('defaults eventLimit to 20', async () => {
      mockTicketEvent.findMany.mockResolvedValue([]);
      mockAgentEvent.findMany.mockResolvedValue([]);
      mockDecisionEvent.findMany.mockResolvedValue([]);

      await repository.findEvents({ projectId: 'p1', actorId: 'u' });

      expect(mockTicketEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
    });
  });

  describe('findActiveDecisions', () => {
    it('returns mapped CanonicalDecision objects from active DECISION memory items', async () => {
      const rows = [
        makeMemoryItemRow({ id: 'mem-1', predicate: 'architecture', object: 'microservices' }),
        makeMemoryItemRow({ id: 'mem-2', predicate: 'api-design', object: 'REST' }),
      ];
      mockMemoryItem.findMany.mockResolvedValue(rows);

      const result = await repository.findActiveDecisions('project-1');

      expect(mockMemoryItem.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'project-1',
          kind: 'DECISION',
          status: 'active',
          deletedAt: null,
        },
        select: expect.objectContaining({ id: true, predicate: true, object: true }),
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'mem-1', topic: 'architecture', decision: 'microservices', rationale: null });
      expect(result[1]).toMatchObject({ id: 'mem-2', topic: 'api-design', decision: 'REST', rationale: null });
    });

    it('returns empty string for decision when object is null', async () => {
      mockMemoryItem.findMany.mockResolvedValue([
        makeMemoryItemRow({ object: null }),
      ]);

      const result = await repository.findActiveDecisions('project-1');

      expect(result[0].decision).toBe('');
    });

    it('returns empty array when no active decisions exist', async () => {
      mockMemoryItem.findMany.mockResolvedValue([]);

      const result = await repository.findActiveDecisions('project-1');

      expect(result).toEqual([]);
    });
  });
});
