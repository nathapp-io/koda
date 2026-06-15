import {
  CanonicalStateService,
  CanonicalSnapshotQuery,
  CanonicalTicket,
  CanonicalEvent,
  CanonicalDecision,
} from './canonical-state.service';
import type { ICanonicalStateRepository } from './domain/canonical-state.domain';
import { CANONICAL_STATE_REPOSITORY } from './domain/canonical-state.domain';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { Test } from '@nestjs/testing';
import { createMock } from '@golevelup/ts-jest';

describe('CanonicalStateService', () => {
  let service: CanonicalStateService;
  let repo: jest.Mocked<ICanonicalStateRepository>;

  beforeEach(async () => {
    repo = createMock<ICanonicalStateRepository>();

    const module = await Test.createTestingModule({
      providers: [
        CanonicalStateService,
        { provide: CANONICAL_STATE_REPOSITORY, useValue: repo },
      ],
    }).compile();

    service = module.get(CanonicalStateService);

    jest.clearAllMocks();
  });

  const setupValidProject = () => {
    repo.findProject.mockResolvedValue({ id: 'project-123', deletedAt: null });
    repo.findTickets.mockResolvedValue([]);
    repo.findEvents.mockResolvedValue([]);
    repo.findActiveDecisions.mockResolvedValue([]);
  };

  describe('AC-1: retrievedAt timestamp', () => {
    test('returns retrievedAt set to the server timestamp at snapshot creation', async () => {
      setupValidProject();

      const before = new Date();
      const result = await service.getSnapshot({ projectId: 'project-123' });
      const after = new Date();

      expect(result.retrievedAt).toBeInstanceOf(Date);
      expect(result.retrievedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.retrievedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('AC-2: tickets filtered by ticketIds', () => {
    test('returns only tickets belonging to the project and matching given IDs', async () => {
      setupValidProject();

      const matchingTickets: CanonicalTicket[] = [
        {
          id: 'ticket-1',
          title: 'Fix bug',
          status: 'IN_PROGRESS',
          priority: 'HIGH',
          assignedToUserId: 'user-1',
          assignedToAgentId: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-02'),
        },
        {
          id: 'ticket-3',
          title: 'Add feature',
          status: 'CREATED',
          priority: 'MEDIUM',
          assignedToUserId: null,
          assignedToAgentId: 'agent-1',
          createdAt: new Date('2025-01-03'),
          updatedAt: new Date('2025-01-04'),
        },
      ];

      repo.findTickets.mockResolvedValue(matchingTickets);

      const query: CanonicalSnapshotQuery = {
        projectId: 'project-123',
        ticketIds: ['ticket-1', 'ticket-3'],
      };
      const result = await service.getSnapshot(query);

      expect(repo.findTickets).toHaveBeenCalledWith(query);
      expect(result.tickets).toEqual(matchingTickets);
    });

    test('delegates soft-delete filtering to the repository', async () => {
      setupValidProject();

      const query: CanonicalSnapshotQuery = {
        projectId: 'project-123',
        ticketIds: ['ticket-1'],
      };
      await service.getSnapshot(query);

      expect(repo.findTickets).toHaveBeenCalledWith(query);
    });
  });

  describe('AC-3: empty or undefined ticketIds', () => {
    test('returns empty tickets array when ticketIds is empty array', async () => {
      setupValidProject();
      repo.findTickets.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        ticketIds: [],
      });

      expect(result.tickets).toEqual([]);
    });

    test('returns empty tickets array when ticketIds is undefined', async () => {
      setupValidProject();
      repo.findTickets.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(result.tickets).toEqual([]);
    });
  });

  describe('AC-4: timeWindow filters recentEvents', () => {
    test('returns only events within the time window, ordered by createdAt DESC', async () => {
      setupValidProject();

      const jan1 = new Date('2025-01-01T00:00:00Z');
      const jan2 = new Date('2025-01-02T00:00:00Z');
      const jan3 = new Date('2025-01-03T00:00:00Z');

      const events: CanonicalEvent[] = [
        {
          id: 'ae-1',
          eventType: 'agent_event',
          actorId: 'actor-2',
          action: 'decision_made',
          payload: { decision: 'approved' },
          rationale: null,
          createdAt: jan3,
        },
        {
          id: 'te-1',
          eventType: 'ticket_event',
          actorId: 'actor-1',
          action: 'CREATED',
          payload: { status: 'CREATED' },
          rationale: null,
          createdAt: jan2,
        },
        {
          id: 'de-1',
          eventType: 'decision_event',
          actorId: 'agent-1',
          action: 'decided',
          payload: { reason: 'test' },
          rationale: null,
          createdAt: jan1,
        },
      ];

      repo.findEvents.mockResolvedValue(events);

      const query: CanonicalSnapshotQuery = {
        projectId: 'project-123',
        timeWindow: { from: jan1, to: jan3 },
      };
      const result = await service.getSnapshot(query);

      expect(repo.findEvents).toHaveBeenCalledWith(query);
      expect(result.recentEvents).toHaveLength(3);

      // Should be ordered by createdAt DESC (jan3, jan2, jan1) as returned by repo
      expect(result.recentEvents[0].createdAt).toEqual(jan3);
      expect(result.recentEvents[1].createdAt).toEqual(jan2);
      expect(result.recentEvents[2].createdAt).toEqual(jan1);
    });

    test('returns empty recentEvents when no timeWindow and no actorId provided', async () => {
      setupValidProject();
      repo.findEvents.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(result.recentEvents).toEqual([]);
    });

    test('maps decision event agentId to actorId', async () => {
      setupValidProject();

      const events: CanonicalEvent[] = [
        {
          id: 'de-1',
          eventType: 'decision_event',
          actorId: 'agent-42',
          action: 'decided',
          payload: {},
          rationale: null,
          createdAt: new Date(),
        },
      ];
      repo.findEvents.mockResolvedValue(events);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        timeWindow: { from: new Date('2025-01-01') },
      });

      expect(result.recentEvents[0].actorId).toBe('agent-42');
      expect(result.recentEvents[0].eventType).toBe('decision_event');
    });
  });

  describe('AC-5: activeDecisions from MemoryItem', () => {
    test('populates activeDecisions from active MemoryItem rows with kind=DECISION and status=active', async () => {
      setupValidProject();

      const decisions: CanonicalDecision[] = [
        {
          id: 'mem-1',
          topic: 'architecture-choice',
          decision: 'Use microservices',
          rationale: null,
          createdAt: new Date('2025-01-01'),
        },
        {
          id: 'mem-2',
          topic: 'api-design',
          decision: 'REST over GraphQL',
          rationale: null,
          createdAt: new Date('2025-01-02'),
        },
      ];

      repo.findActiveDecisions.mockResolvedValue(decisions);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(repo.findActiveDecisions).toHaveBeenCalledWith('project-123');
      expect(result.activeDecisions).toHaveLength(2);
      expect(result.activeDecisions[0]).toEqual(decisions[0]);
      expect(result.activeDecisions[1]).toEqual(decisions[1]);
    });

    test('returns empty array when no active decisions exist', async () => {
      setupValidProject();
      repo.findActiveDecisions.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(result.activeDecisions).toEqual([]);
    });
  });

  describe('AC-6: non-existent projectId', () => {
    test('throws NotFoundAppException when project does not exist', async () => {
      repo.findProject.mockResolvedValue(null);

      await expect(
        service.getSnapshot({ projectId: 'nonexistent' }),
      ).rejects.toThrow(NotFoundAppException);
    });

    test('throws NotFoundAppException when project is soft-deleted', async () => {
      repo.findProject.mockResolvedValue({
        id: 'project-deleted',
        deletedAt: new Date(),
      });

      await expect(
        service.getSnapshot({ projectId: 'project-deleted' }),
      ).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('Bug: actorId filtering on events', () => {
    test('passes actorId to repo.findEvents for filtering', async () => {
      setupValidProject();
      repo.findEvents.mockResolvedValue([]);

      const query: CanonicalSnapshotQuery = {
        projectId: 'project-123',
        actorId: 'actor-42',
        timeWindow: { from: new Date('2025-01-01') },
      };
      await service.getSnapshot(query);

      expect(repo.findEvents).toHaveBeenCalledWith(query);
    });

    test('passes actorId to repo.findEvents even when timeWindow is absent', async () => {
      setupValidProject();
      repo.findEvents.mockResolvedValue([]);

      const query: CanonicalSnapshotQuery = {
        projectId: 'project-123',
        actorId: 'actor-42',
      };
      await service.getSnapshot(query);

      expect(repo.findEvents).toHaveBeenCalledWith(query);
    });
  });

  describe('Bug: rationale field ignored in decision events', () => {
    test('includes rationale from DecisionEvent in CanonicalEvent output', async () => {
      setupValidProject();

      const events: CanonicalEvent[] = [
        {
          id: 'de-1',
          eventType: 'decision_event',
          actorId: 'agent-42',
          action: 'decided',
          payload: { reason: 'test' },
          rationale: 'The approach aligns with architecture principles',
          createdAt: new Date('2025-01-01'),
        },
      ];
      repo.findEvents.mockResolvedValue(events);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        timeWindow: { from: new Date('2025-01-01') },
      });

      expect(result.recentEvents).toHaveLength(1);
      expect(result.recentEvents[0].rationale).toBe(
        'The approach aligns with architecture principles',
      );
    });
  });

  describe('AC-7: canonical reads only', () => {
    test('calls all repo methods for a full snapshot query', async () => {
      setupValidProject();

      const query: CanonicalSnapshotQuery = {
        projectId: 'project-123',
        ticketIds: ['ticket-1'],
        timeWindow: { from: new Date('2025-01-01') },
      };
      await service.getSnapshot(query);

      expect(repo.findProject).toHaveBeenCalledWith('project-123');
      expect(repo.findTickets).toHaveBeenCalledWith(query);
      expect(repo.findEvents).toHaveBeenCalledWith(query);
      expect(repo.findActiveDecisions).toHaveBeenCalledWith('project-123');
    });
  });
});
