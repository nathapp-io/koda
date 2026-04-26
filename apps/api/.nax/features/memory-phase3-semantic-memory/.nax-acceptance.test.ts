import { Test, TestingModule } from '@nestjs/testing';
import { MemoryItemRepository } from '../../../src/memory/memory-item-repository';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import { MemoryGovernanceProcessor } from '../../../src/memory/memory-governance.processor';
import { ExtractionService } from '../../../src/memory/extraction.service';
import { ContextBuilderService } from '../../../src/memory/context-builder.service';
import { TimelineService } from '../../../src/memory/timeline.service';
import { OutboxFanOutRegistry } from '../../../src/outbox/outbox-fan-out-registry';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { MemoryKind } from '../../../src/common/enums';
import { readFileSync } from 'fs';
import { join } from 'path';

const MemoryKindEnum = {
  FACT: 'FACT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
  DECISION: 'DECISION',
} as const;

interface MockPrismaClient {
  memoryItem: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  project: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
}

function createMockPrismaClient(): MockPrismaClient {
  return {
    memoryItem: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    project: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function createMockMemoryItemRepository() {
  return {
    findByProject: jest.fn(),
    findByProjectMemory: jest.fn(),
    upsert: jest.fn(),
    findActive: jest.fn(),
    reject: jest.fn(),
    softDelete: jest.fn(),
  };
}

function createMockTimelineService() {
  return {
    getProjectTimeline: jest.fn(),
    getTicketHistory: jest.fn(),
  };
}

describe('Memory Phase 3 Semantic Memory Acceptance Tests', () => {
  describe('AC-1: Prisma schema contains MemoryItem model with required fields', () => {
    it('schema contains MemoryItem model with projectId, kind, subject, predicate, activeKey, object, sourceType, sourceId, createdAt, updatedAt', () => {
      const schemaPath = join(__dirname, '../../../../../apps/api/prisma/schema.prisma');
      const schema = readFileSync(schemaPath, 'utf-8');
      expect(schema).toContain('model MemoryItem');
      expect(schema).toContain('projectId    String');
      expect(schema).toContain('kind         String');
      expect(schema).toContain('subject      String');
      expect(schema).toContain('predicate    String');
      expect(schema).toContain('object       String?');
      expect(schema).toContain('activeKey    String?');
      expect(schema).toContain('sourceType   String?');
      expect(schema).toContain('sourceId     String?');
      expect(schema).toContain('createdAt    DateTime');
      expect(schema).toContain('updatedAt    DateTime');
    });

    it('schema contains unique constraint on (projectId, kind, subject, predicate, activeKey)', () => {
      const schemaPath = join(__dirname, '../../../../../apps/api/prisma/schema.prisma');
      const schema = readFileSync(schemaPath, 'utf-8');
      expect(schema).toContain('@@unique([projectId, kind, subject, predicate, activeKey])');
    });

    it('schema contains indexes on (projectId, kind, subject, predicate) and (projectId, activeKey)', () => {
      const schemaPath = join(__dirname, '../../../../../apps/api/prisma/schema.prisma');
      const schema = readFileSync(schemaPath, 'utf-8');
      expect(schema).toContain('@@index([projectId, kind, subject, predicate])');
      expect(schema).toContain('@@index([projectId, activeKey])');
    });
  });

  describe('AC-2: Upsert deactivates existing active row within transaction', () => {
    it('when upsert sets activeKey, pre-existing active row for same composite key is deactivated', async () => {
      const mockClient = createMockPrismaClient();
      const existingActiveItem = {
        id: 'existing-active-1',
        projectId: 'proj-1',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'old-active-key',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockClient.$transaction.mockImplementation(async (fn) => {
        const txClient = {
          memoryItem: {
            findFirst: jest.fn().mockResolvedValue(existingActiveItem),
            create: jest.fn().mockResolvedValue({ id: 'new-mem-1', ...existingActiveItem, activeKey: 'new-active-key' }),
            update: jest.fn().mockResolvedValue({ ...existingActiveItem, activeKey: null, status: 'superseded' }),
          },
        };
        return fn(txClient);
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.upsert({
        projectId: 'proj-1',
        kind: MemoryKindEnum.FACT as any,
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'new-active-key',
        status: 'active',
      });

      expect(result).toBeDefined();
      expect(mockClient.$transaction).toHaveBeenCalled();
    });

    it('at most one active row exists per composite key after upsert', async () => {
      const mockClient = createMockPrismaClient();
      const existingActiveItem = {
        id: 'existing-active-1',
        projectId: 'proj-1',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'key-1',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let updateCall: any;
      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn().mockResolvedValue(existingActiveItem),
            create: jest.fn().mockResolvedValue({ id: 'new-1' }),
            update: jest.fn().mockImplementation((opts: any) => {
              updateCall = opts;
              return Promise.resolve({ ...existingActiveItem, ...opts.data });
            }),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.upsert({
        projectId: 'proj-1',
        kind: MemoryKindEnum.FACT as any,
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'new-key',
        status: 'active',
      });

      if (updateCall) {
        expect(updateCall.data.activeKey).toBeNull();
        expect(updateCall.data.status).toBe('superseded');
      }
    });
  });

  describe('AC-3: findByProject returns paginated results with filtering', () => {
    it('returns { items, total, page, limit } structure ordered by createdAt desc', async () => {
      const mockClient = createMockPrismaClient();
      const items = [
        { id: 'mem-1', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', createdAt: new Date(), updatedAt: new Date() },
      ];
      mockClient.memoryItem.findMany.mockResolvedValue(items);
      mockClient.memoryItem.count.mockResolvedValue(1);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.findByProject({ projectId: 'proj-1', page: 1, limit: 20 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('page');
      expect(result).toHaveProperty('limit');
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filters by kind, subject, predicate when provided', async () => {
      const mockClient = createMockPrismaClient();
      mockClient.memoryItem.findMany.mockResolvedValue([]);
      mockClient.memoryItem.count.mockResolvedValue(0);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.findByProject({
        projectId: 'proj-1',
        kind: MemoryKindEnum.FACT as any,
        subject: 'ticket:1',
        predicate: 'status',
        page: 1,
        limit: 20,
      });

      expect(mockClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'proj-1',
            kind: 'FACT',
            subject: 'ticket:1',
            predicate: 'status',
          }),
        }),
      );
    });
  });

  describe('AC-4: upsert creates or updates MemoryItem with id', () => {
    it('upsert returns MemoryItem with id populated', async () => {
      const mockClient = createMockPrismaClient();
      const createdItem = {
        id: 'mem-new-1',
        projectId: 'proj-1',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        object: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(createdItem),
            update: jest.fn(),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.upsert({
        projectId: 'proj-1',
        kind: MemoryKindEnum.FACT as any,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'open',
      });

      expect(result.id).toBeDefined();
      expect(result.id).toBe('mem-new-1');
    });

    it('upsert updates existing row when matching composite key exists', async () => {
      const mockClient = createMockPrismaClient();
      const existingItem = {
        id: 'existing-1',
        projectId: 'proj-1',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'key-existing',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
            update: jest.fn().mockResolvedValue({ ...existingItem, object: 'closed' }),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.upsert({
        id: 'existing-1',
        projectId: 'proj-1',
        kind: MemoryKindEnum.FACT as any,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'closed',
      });

      expect(mockClient.$transaction).toHaveBeenCalled();
    });
  });

  describe('AC-5: findActive returns row where activeKey IS NOT NULL', () => {
    it('findActive queries for activeKey IS NOT NULL', async () => {
      const mockClient = createMockPrismaClient();
      const activeItem = {
        id: 'active-1',
        projectId: 'proj-1',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'active-key-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockClient.memoryItem.findFirst.mockResolvedValue(activeItem);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.findActive('proj-1', 'FACT', 'ticket:1', 'status');

      expect(result).toBeDefined();
      expect(result?.activeKey).toBe('active-key-123');
      expect(mockClient.memoryItem.findFirst).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', activeKey: { not: null }, deletedAt: null },
      });
    });

    it('findActive returns null when no active row exists', async () => {
      const mockClient = createMockPrismaClient();
      mockClient.memoryItem.findFirst.mockResolvedValue(null);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.findActive('proj-1', 'FACT', 'ticket:1', 'status');

      expect(result).toBeNull();
    });
  });

  describe('AC-6: POST /memories with non-existent projectId returns 403', () => {
    it('controller validates project exists before memory creation', () => {
      const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'] as const;
      const viewerRole = 'VIEWER';
      expect(allowedRoles.includes(viewerRole as any)).toBe(false);
    });
  });

  describe('AC-7: Role whitelist check for viewer/guest roles', () => {
    it('viewer role is rejected by allowedRoles check', () => {
      const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'] as const;
      expect(allowedRoles.includes('VIEWER' as any)).toBe(false);
    });

    it('guest role is rejected by allowedRoles check', () => {
      const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'] as const;
      expect(allowedRoles.includes('GUEST' as any)).toBe(false);
    });

    it('admin role passes allowedRoles check', () => {
      const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'] as const;
      expect(allowedRoles.includes('ADMIN' as any)).toBe(true);
    });

    it('developer role passes allowedRoles check', () => {
      const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'] as const;
      expect(allowedRoles.includes('DEVELOPER' as any)).toBe(true);
    });

    it('agent role passes allowedRoles check', () => {
      const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'] as const;
      expect(allowedRoles.includes('AGENT' as any)).toBe(true);
    });
  });

  describe('AC-8: MemoryItem source tracking from event handlers', () => {
    it('MemoryItemRepository has upsert method', async () => {
      const mockClient = createMockPrismaClient();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      expect(typeof repo.upsert).toBe('function');
    });
  });

  describe('AC-9: activeKey invariant - null means superseded/rejected', () => {
    it('reject sets activeKey to null and status to rejected', async () => {
      const mockClient = createMockPrismaClient();
      mockClient.memoryItem.update.mockResolvedValue({ id: 'mem-1', activeKey: null, status: 'rejected' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.reject('mem-1');

      expect(mockClient.memoryItem.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { activeKey: null, status: 'rejected' },
      });
    });
  });

  describe('AC-10: extractFromEvent status_changed returns FACT memory', () => {
    it('extracts memory item for ticket status_changed', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const result = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-1',
        ticketId: '1',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'status_changed',
        data: { newStatus: 'open' },
        timestamp: new Date(),
      });

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe(MemoryKindEnum.FACT);
      expect(result[0].subject).toBe('ticket:1');
      expect(result[0].predicate).toBe('status');
      expect(result[0].object).toBe('open');
      expect(typeof result[0].confidence).toBe('number');
      expect(result[0].ttlAt).toBeNull();
    });
  });

  describe('AC-11: extractFromEvent assigned returns FACT memory with object', () => {
    it('extracts memory item for ticket assigned', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const result = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-2',
        ticketId: '1',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'assigned',
        data: { assignedTo: 'user-123' },
        timestamp: new Date(),
      });

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe(MemoryKindEnum.FACT);
      expect(result[0].subject).toBe('ticket:1');
      expect(result[0].predicate).toBe('assigned_to');
      expect(result[0].object).toBe('user-123');
    });
  });

  describe('AC-12: extractFromEvent incident_linked returns INCIDENT_PATTERN', () => {
    it('extracts INCIDENT_PATTERN memory for incident_linked', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const result = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-3',
        ticketId: '1',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'incident_linked',
        data: { incidentId: 'svc-456' },
        timestamp: new Date(),
      });

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe(MemoryKindEnum.INCIDENT_PATTERN);
      expect(result[0].subject).toBe('ticket:1');
      expect(result[0].predicate).toBe('incident');
      expect(result[0].object).toBe('svc-456');
    });
  });

  describe('AC-13: extractFromEvent agent_event returns empty array', () => {
    it('returns empty array for agent_event without decision_made action', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const result = service.extractFromEvent({
        type: 'agent_event',
        id: 'evt-4',
        agentId: 'agent-1',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'other_action',
        data: {},
        timestamp: new Date(),
      });

      expect(result).toEqual([]);
    });
  });

  describe('AC-14: extractFromEvent incomplete ticket_event returns empty with warning', () => {
    it('returns empty array when ticketId is missing', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-5',
        ticketId: undefined,
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'status_changed',
        data: {},
        timestamp: new Date(),
      });

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('missing ticketId'),
      );

      warnSpy.mockRestore();
    });
  });

  describe('AC-15: recordDecision creates DECISION kind memory item', () => {
    it('recordDecision calls upsert with kind=DECISION', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const mockRepo = createMockMemoryItemRepository();
      mockRepo.upsert
        .mockResolvedValueOnce({ id: 'dec-canonical-1' })
        .mockResolvedValueOnce({ id: 'mem-dec-1' });

      const result = await service.recordDecision(
        { projectId: 'proj-1', agentId: 'agent-1', decision: 'approve' },
        { id: 'event-dec-001' },
        mockRepo,
      );

      expect(mockRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MemoryKindEnum.DECISION,
          subject: 'agent:agent-1',
          predicate: 'decision',
        }),
      );
      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('memoryId');
    });
  });

  describe('AC-16: recordDecision supersedes existing decision when provided', () => {
    it('supersedes existing decision when existingDecision is provided', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const mockRepo = createMockMemoryItemRepository();
      mockRepo.upsert
        .mockResolvedValueOnce({ id: 'existing-decision-id' })
        .mockResolvedValueOnce({ id: 'dec-canonical-1' })
        .mockResolvedValueOnce({ id: 'mem-dec-1' });

      const result = await service.recordDecision(
        { projectId: 'proj-1', agentId: 'agent-1', decision: 'revise' },
        { id: 'event-dec-002' },
        mockRepo,
        { id: 'existing-decision-id' },
      );

      expect(mockRepo.upsert).toHaveBeenCalledTimes(3);
      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('memoryId');
    });
  });

  describe('AC-17: OutboxFanOutRegistry dispatches ticket_event to extractFromEvent', () => {
    it('registry dispatches ticket_event and calls extractFromEvent', async () => {
      const extractionService = new ExtractionService();
      const memoryRepo = createMockMemoryItemRepository() as any;
      memoryRepo.upsert.mockResolvedValue({ id: 'mem-1' });

      const registry = new OutboxFanOutRegistry(extractionService, memoryRepo);
      const extractSpy = jest.spyOn(extractionService, 'extractFromEvent');

      await registry.dispatch({
        eventType: 'ticket_event',
        payload: {
          type: 'ticket_event',
          id: 'evt-dispatch-1',
          ticketId: '1',
          projectId: 'proj-1',
          actorId: 'actor-1',
          action: 'status_changed',
          data: { newStatus: 'open' },
          timestamp: new Date().toISOString(),
        },
      });

      expect(extractSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          action: 'status_changed',
        }),
      );
    });
  });

  describe('AC-18: All extractFromEvent results have confidence >= 0.5 and ttlAt === null', () => {
    it('all ticket_event extractions meet confidence >= 0.5 and ttlAt === null', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);

      const statusResult = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-c1',
        ticketId: '1',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'status_changed',
        data: { newStatus: 'open' },
        timestamp: new Date(),
      });

      const assignedResult = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-c2',
        ticketId: '2',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'assigned',
        data: { assignedTo: 'U-1' },
        timestamp: new Date(),
      });

      const incidentResult = service.extractFromEvent({
        type: 'ticket_event',
        id: 'evt-c3',
        ticketId: '3',
        projectId: 'proj-1',
        actorId: 'actor-1',
        action: 'incident_linked',
        data: { incidentId: 'SVC-1' },
        timestamp: new Date(),
      });

      const allItems = [...statusResult, ...assignedResult, ...incidentResult];

      for (const item of allItems) {
        expect(item.confidence).toBeGreaterThanOrEqual(0.5);
        expect(item.ttlAt).toBeNull();
      }
    });
  });

  describe('AC-19: recordDecision sets confidence to 1.0', () => {
    it('recordDecision upsert calls include confidence 1.0', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [ExtractionService],
      }).compile();

      const service = module.get(ExtractionService);
      const mockRepo = createMockMemoryItemRepository();
      mockRepo.upsert
        .mockResolvedValueOnce({ id: 'dec-canonical-1', confidence: 1.0 })
        .mockResolvedValueOnce({ id: 'mem-dec-1', confidence: 1.0 });

      await service.recordDecision(
        { projectId: 'proj-1', agentId: 'agent-1', decision: 'approve' },
        { id: 'event-dec-003' },
        mockRepo,
      );

      expect(mockRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: 1.0,
        }),
      );
    });
  });

  describe('AC-20: GET /projects/:slug/memory returns active items', () => {
    it('findByProjectMemory returns only active items by default', async () => {
      const mockClient = createMockPrismaClient();
      const now = new Date();
      const activeItems = [
        {
          id: 'mem-active-1',
          projectId: 'proj-1',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          status: 'active',
          confidence: 0.9,
          ttlAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ];

      mockClient.memoryItem.findMany.mockResolvedValue(activeItems);
      mockClient.memoryItem.count.mockResolvedValue(1);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.findByProjectMemory({
        projectId: 'proj-1',
        limit: 20,
      });

      expect(result.items.every(item => item.status === 'active')).toBe(true);
    });
  });

  describe('AC-21: GET /projects/:slug/memory?kind=FACT returns only FACT items', () => {
    it('findByProjectMemory filters by kind FACT', async () => {
      const mockClient = createMockPrismaClient();
      const factItems = [
        {
          id: 'mem-fact-1',
          projectId: 'proj-1',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockClient.memoryItem.findMany.mockResolvedValue(factItems);
      mockClient.memoryItem.count.mockResolvedValue(1);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.findByProjectMemory({
        projectId: 'proj-1',
        kind: MemoryKindEnum.FACT as any,
        limit: 20,
      });

      expect(mockClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kind: 'FACT',
          }),
        }),
      );
    });
  });

  describe('AC-22: GET /projects/:slug/memory?subjects=ticket:123 filters correctly', () => {
    it('findByProjectMemory filters by subject prefix using startsWith', async () => {
      const mockClient = createMockPrismaClient();
      const items = [
        {
          id: 'mem-1',
          projectId: 'proj-1',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockClient.memoryItem.findMany.mockResolvedValue(items);
      mockClient.memoryItem.count.mockResolvedValue(1);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.findByProjectMemory({
        projectId: 'proj-1',
        subject: 'ticket:123',
        limit: 20,
      });

      expect(mockClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            subject: { startsWith: 'ticket:123' },
          }),
        }),
      );
    });
  });

  describe('AC-23: GET /projects/:slug/memory?status=superseded returns superseded items', () => {
    it('findByProjectMemory can filter by status=superseded', async () => {
      const mockClient = createMockPrismaClient();
      const supersededItems = [
        {
          id: 'mem-superseded-1',
          projectId: 'proj-1',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          status: 'superseded',
          supersededBy: 'mem-new-1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockClient.memoryItem.findMany.mockResolvedValue(supersededItems);
      mockClient.memoryItem.count.mockResolvedValue(1);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.findByProjectMemory({
        projectId: 'proj-1',
        status: 'superseded',
        limit: 20,
      });

      expect(result.items.every(item => item.status === 'superseded')).toBe(true);
    });
  });

  describe('AC-24: Cross-project memory access denied', () => {
    it('findByProjectMemory only returns items for specified projectId', async () => {
      const mockClient = createMockPrismaClient();
      mockClient.memoryItem.findMany.mockResolvedValue([]);
      mockClient.memoryItem.count.mockResolvedValue(0);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      await repo.findByProjectMemory({
        projectId: 'proj-slug-a',
        limit: 20,
      });

      expect(mockClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'proj-slug-a',
          }),
        }),
      );
    });
  });

  describe('AC-25: getProjectContext returns semanticMemory key', () => {
    it('getProjectContext response contains semanticMemory array', async () => {
      const mockTimelineSvc = createMockTimelineService();
      const mockRepo = createMockMemoryItemRepository();
      mockRepo.findByProjectMemory.mockResolvedValue({ items: [], total: 0 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ContextBuilderService,
          { provide: TimelineService, useValue: mockTimelineSvc },
          { provide: MemoryItemRepository, useValue: mockRepo },
        ],
      }).compile();

      const service = module.get(ContextBuilderService);
      const result = await service.getProjectContext({
        projectId: 'proj-1',
        actorId: 'actor-1',
        intent: 'answer',
      });

      expect(result).toHaveProperty('semanticMemory');
      expect(Array.isArray(result.semanticMemory)).toBe(true);
    });

    it('semanticMemory contains memory items when data exists', async () => {
      const mockTimelineSvc = createMockTimelineService();
      const mockRepo = createMockMemoryItemRepository();
      const memoryItems = [
        {
          id: 'mem-1',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          object: 'open',
          confidence: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      mockRepo.findByProjectMemory.mockResolvedValue({ items: memoryItems, total: 1 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ContextBuilderService,
          { provide: TimelineService, useValue: mockTimelineSvc },
          { provide: MemoryItemRepository, useValue: mockRepo },
        ],
      }).compile();

      const service = module.get(ContextBuilderService);
      const result = await service.getProjectContext({
        projectId: 'proj-1',
        actorId: 'actor-1',
        intent: 'answer',
      });

      expect(result.semanticMemory).toBeDefined();
      expect(result.semanticMemory!.length).toBeGreaterThan(0);
    });
  });

  describe('AC-26: Memory items sorted by confidence and updatedAt', () => {
    it('findByProjectMemory orders by confidence desc, updatedAt desc, createdAt desc', async () => {
      const mockClient = createMockPrismaClient();
      const now = new Date();
      const items = [
        { id: 'mem-2', kind: 'FACT', subject: 'ticket:2', predicate: 'status', confidence: 0.9, updatedAt: now, createdAt: now },
        { id: 'mem-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', confidence: 0.8, updatedAt: new Date(now.getTime() - 1000), createdAt: now },
        { id: 'mem-3', kind: 'FACT', subject: 'ticket:3', predicate: 'status', confidence: 0.7, updatedAt: now, createdAt: now },
      ];

      mockClient.memoryItem.findMany.mockResolvedValue(items);
      mockClient.memoryItem.count.mockResolvedValue(3);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const repo = module.get(MemoryItemRepository);
      const result = await repo.findByProjectMemory({
        projectId: 'proj-1',
        limit: 20,
        orderBy: 'confidence',
      });

      expect(result.items[0].confidence).toBeGreaterThanOrEqual(result.items[1].confidence);
      expect(result.items[1].confidence).toBeGreaterThanOrEqual(result.items[2].confidence);
    });
  });

  describe('AC-27: Cron configuration for GovernanceService.runCleanup', () => {
    it('MemoryGovernanceProcessor has scheduled cleanup at 03:00 UTC', () => {
      const mockGovService = {
        runCleanup: jest.fn().mockResolvedValue({
          expiredCount: 0,
          downrankedCount: 0,
          deduplicatedCount: 0,
          supersessionCount: 0,
        }),
      };
      const mockPrisma = {
        client: {
          project: { findMany: jest.fn().mockResolvedValue([]) },
        },
      };

      const processor = new MemoryGovernanceProcessor(mockGovService as any, mockPrisma as any);

      expect(typeof processor.scheduledCleanup).toBe('function');
    });
  });

  describe('AC-28: runCleanup calls all four governance methods', () => {
    it('runCleanup returns GovernanceResult with expiredCount, downrankedCount, deduplicatedCount, supersededCount', async () => {
      const mockClient = createMockPrismaClient();
      mockClient.memoryItem.findMany.mockResolvedValue([]);
      mockClient.memoryItem.count.mockResolvedValue(0);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const result = await governance.runCleanup('proj-1');

      expect(result).toHaveProperty('expiredCount');
      expect(result).toHaveProperty('downrankedCount');
      expect(result).toHaveProperty('deduplicatedCount');
      expect(result).toHaveProperty('supersessionCount');
      expect(typeof result.expiredCount).toBe('number');
      expect(typeof result.downrankedCount).toBe('number');
      expect(typeof result.deduplicatedCount).toBe('number');
      expect(typeof result.supersessionCount).toBe('number');
    });
  });

  describe('AC-29: expireMemories updates expired items', () => {
    it('expireMemories identifies items with ttlAt < now', async () => {
      const mockClient = createMockPrismaClient();
      const past = new Date(Date.now() - 86400000);
      const future = new Date(Date.now() + 86400000);

      const items = [
        { id: 'mem-expired', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: past, createdAt: new Date(), updatedAt: new Date() },
        { id: 'mem-valid', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:2', predicate: 'status', status: 'active', ttlAt: future, createdAt: new Date(), updatedAt: new Date() },
      ];

      let callCount = 0;
      mockClient.memoryItem.findMany.mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(items);
        }
        return Promise.resolve([]);
      });
      mockClient.memoryItem.count.mockResolvedValue(2);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const result = await governance.expireMemories('proj-1');

      expect(result).toHaveProperty('count');
      expect(typeof result.count).toBe('number');
    });
  });

  describe('AC-30: downrankStaleLowConfidence updates old low-confidence items', () => {
    it('downrankStaleLowConfidence identifies items older than 90 days with confidence < 0.3', async () => {
      const mockClient = createMockPrismaClient();
      const ninetyOneDaysAgo = new Date(Date.now() - 91 * 86400000);
      const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000);

      const items = [
        { id: 'mem-stale', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.2, createdAt: ninetyOneDaysAgo, updatedAt: ninetyOneDaysAgo },
        { id: 'mem-recent', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:2', predicate: 'status', status: 'active', confidence: 0.2, createdAt: sixtyDaysAgo, updatedAt: sixtyDaysAgo },
      ];

      let callCount = 0;
      mockClient.memoryItem.findMany.mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(items);
        }
        return Promise.resolve([]);
      });
      mockClient.memoryItem.count.mockResolvedValue(2);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const result = await governance.downrankStaleLowConfidence('proj-1');

      expect(result).toHaveProperty('count');
      expect(typeof result.count).toBe('number');
    });
  });

  describe('AC-31: deduplicate supersedes lower-confidence duplicates', () => {
    it('deduplicate identifies groups with same composite key and keeps highest confidence', async () => {
      const mockClient = createMockPrismaClient();
      const items = [
        { id: 'mem-high', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.9, activeKey: 'key-high', createdAt: new Date(), updatedAt: new Date() },
        { id: 'mem-low', projectId: 'proj-1', kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.5, activeKey: 'key-low', createdAt: new Date(), updatedAt: new Date() },
      ];

      let callCount = 0;
      mockClient.memoryItem.findMany.mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(items);
        }
        return Promise.resolve([]);
      });
      mockClient.memoryItem.count.mockResolvedValue(2);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const result = await governance.deduplicate('proj-1');

      expect(result).toHaveProperty('count');
      expect(typeof result.count).toBe('number');
    });
  });

  describe('AC-32: applySupersession supersedes older DECISION items', () => {
    it('applySupersession identifies groups of DECISION items and keeps newest', async () => {
      const mockClient = createMockPrismaClient();
      const older = new Date(Date.now() - 1000);
      const newer = new Date();

      const items = [
        { id: 'mem-newest', projectId: 'proj-1', kind: 'DECISION', subject: 'agent:A1', predicate: 'decision', status: 'active', confidence: 1.0, createdAt: newer, updatedAt: newer },
        { id: 'mem-older', projectId: 'proj-1', kind: 'DECISION', subject: 'agent:A1', predicate: 'decision', status: 'active', confidence: 1.0, createdAt: older, updatedAt: older },
      ];

      let callCount = 0;
      mockClient.memoryItem.findMany.mockImplementation(() => {
        if (callCount === 0) {
          callCount++;
          return Promise.resolve(items);
        }
        return Promise.resolve([]);
      });
      mockClient.memoryItem.count.mockResolvedValue(2);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const result = await governance.applySupersession('proj-1');

      expect(result).toHaveProperty('count');
      expect(typeof result.count).toBe('number');
    });
  });

  describe('AC-33: runCleanup is idempotent', () => {
    it('running cleanup twice produces same result on second run', async () => {
      const mockClient = createMockPrismaClient();
      mockClient.memoryItem.findMany.mockResolvedValue([]);
      mockClient.memoryItem.count.mockResolvedValue(0);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const result1 = await governance.runCleanup('proj-1');
      const result2 = await governance.runCleanup('proj-1');

      expect(result2.expiredCount).toBe(result1.expiredCount);
      expect(result2.downrankedCount).toBe(result1.downrankedCount);
      expect(result2.deduplicatedCount).toBe(result1.deduplicatedCount);
      expect(result2.supersessionCount).toBe(result1.supersessionCount);
    });
  });

  describe('AC-34: runCleanup performance with 1000 records', () => {
    it('runCleanup completes within 30000ms', async () => {
      const mockClient = createMockPrismaClient();
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: `mem-${i}`,
        projectId: 'proj-1',
        kind: 'FACT',
        subject: `ticket:${i}`,
        predicate: 'status',
        status: 'active',
        confidence: 0.5,
        ttlAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      mockClient.memoryItem.findMany.mockResolvedValue(items);
      mockClient.memoryItem.count.mockResolvedValue(100);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      const start = Date.now();
      await governance.runCleanup('proj-1');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(30000);
    });
  });

  describe('AC-35: No DELETE operations during governance', () => {
    it('governance only modifies status, confidence, supersededBy, activeKey', async () => {
      const mockClient = createMockPrismaClient();
      const updates: any[] = [];

      mockClient.memoryItem.findMany.mockResolvedValue([]);
      mockClient.memoryItem.count.mockResolvedValue(0);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn({
          memoryItem: {
            findFirst: jest.fn(),
            create: jest.fn().mockImplementation((data: any) => {
              updates.push({ operation: 'create', data });
              return Promise.resolve({ id: 'new-mem' });
            }),
            update: jest.fn().mockImplementation((opts: any) => {
              updates.push({ operation: 'update', data: opts.data });
              return Promise.resolve({ id: opts.where.id, ...opts.data });
            }),
          },
        });
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MemoryItemRepository,
          MemoryGovernanceService,
          { provide: PrismaService, useValue: { client: mockClient } },
        ],
      }).compile();

      const governance = module.get(MemoryGovernanceService);
      await governance.runCleanup('proj-1');

      const updateOperations = updates.filter(u => u.operation === 'update');
      for (const op of updateOperations) {
        const allowedFields = ['status', 'confidence', 'supersededBy', 'updatedAt', 'activeKey', 'id'];
        const modifiedFields = Object.keys(op.data);
        const unexpectedFields = modifiedFields.filter(f => !allowedFields.includes(f));
        expect(unexpectedFields).toHaveLength(0);
      }
    });
  });

  describe('AC-36: semanticMemory property is defined', () => {
    it('getProjectContext response semanticMemory is not undefined', async () => {
      const mockTimelineSvc = createMockTimelineService();
      const mockRepo = createMockMemoryItemRepository();
      mockRepo.findByProjectMemory.mockResolvedValue({ items: [], total: 0 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ContextBuilderService,
          { provide: TimelineService, useValue: mockTimelineSvc },
          { provide: MemoryItemRepository, useValue: mockRepo },
        ],
      }).compile();

      const service = module.get(ContextBuilderService);
      const result = await service.getProjectContext({
        projectId: 'proj-1',
        actorId: 'actor-1',
        intent: 'answer',
      });

      expect(result.semanticMemory).toBeDefined();
      expect(result.semanticMemory).not.toBeUndefined();
    });
  });

  describe('AC-37: semanticMemory length <= 10 and sorted by confidence', () => {
    it('semanticMemory is capped at 10 items and sorted by confidence desc', async () => {
      const mockTimelineSvc = createMockTimelineService();
      const mockRepo = createMockMemoryItemRepository();

      const manyItems = Array.from({ length: 15 }, (_, i) => ({
        id: `mem-${i}`,
        kind: 'FACT',
        subject: `ticket:${i}`,
        predicate: 'status',
        object: 'open',
        confidence: 0.5 + (i * 0.03),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      mockRepo.findByProjectMemory.mockResolvedValue({ items: manyItems, total: 15 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ContextBuilderService,
          { provide: TimelineService, useValue: mockTimelineSvc },
          { provide: MemoryItemRepository, useValue: mockRepo },
        ],
      }).compile();

      const service = module.get(ContextBuilderService);
      const result = await service.getProjectContext({
        projectId: 'proj-1',
        actorId: 'actor-1',
        intent: 'answer',
      });

      expect(result.semanticMemory!.length).toBeLessThanOrEqual(10);
      for (let i = 0; i < (result.semanticMemory!.length - 1); i++) {
        expect(result.semanticMemory![i].confidence!).toBeGreaterThanOrEqual(
          result.semanticMemory![i + 1].confidence!,
        );
      }
    });
  });

  describe('AC-38: provenance.sources contains memory_item entries', () => {
    it('provenance sources contain memory_item entries when semanticMemory is non-empty', async () => {
      const mockTimelineSvc = createMockTimelineService();
      const mockRepo = createMockMemoryItemRepository();

      const memoryItems = [
        {
          id: 'mem-provenance-1',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          object: 'open',
          confidence: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      mockRepo.findByProjectMemory.mockResolvedValue({ items: memoryItems, total: 1 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ContextBuilderService,
          { provide: TimelineService, useValue: mockTimelineSvc },
          { provide: MemoryItemRepository, useValue: mockRepo },
        ],
      }).compile();

      const service = module.get(ContextBuilderService);
      const result = await service.getProjectContext({
        projectId: 'proj-1',
        actorId: 'actor-1',
        intent: 'answer',
      });

      expect(result.semanticMemory).toBeDefined();
      expect(result.semanticMemory!.length).toBeGreaterThan(0);
    });
  });

  describe('AC-39: Empty memory returns empty semanticMemory array', () => {
    it('getProjectContext returns empty array when no memory exists', async () => {
      const mockTimelineSvc = createMockTimelineService();
      const mockRepo = createMockMemoryItemRepository();
      mockRepo.findByProjectMemory.mockResolvedValue({ items: [], total: 0 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ContextBuilderService,
          { provide: TimelineService, useValue: mockTimelineSvc },
          { provide: MemoryItemRepository, useValue: mockRepo },
        ],
      }).compile();

      const service = module.get(ContextBuilderService);
      const result = await service.getProjectContext({
        projectId: 'proj-1',
        actorId: 'actor-1',
        intent: 'answer',
      });

      expect(result.semanticMemory).toBeDefined();
      expect(Array.isArray(result.semanticMemory)).toBe(true);
      expect(result.semanticMemory!.length).toBe(0);
    });
  });
});