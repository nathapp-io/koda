import { Test, TestingModule } from '@nestjs/testing';
import { MemoryController } from './memory.controller';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryKind, ActorRole } from '../common/enums';
import { MemoryItem } from './memory-item-repository';
import type { KodaPrincipal, UserPrincipal, AgentPrincipal } from '../auth/principal/koda-principal.types';

const makeMemoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: MemoryKind.FACT,
  subject: 'ticket:1',
  predicate: 'status',
  object: 'active',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeUserPrincipal = (role: string): UserPrincipal => ({
  actorType: 'user',
  id: 'user-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  role: role as UserPrincipal['role'],
  email: 'test@example.com',
});

const makeAgentPrincipal = (): AgentPrincipal => ({
  actorType: 'agent',
  id: 'agent-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  slug: 'my-agent',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
});

describe('MemoryController', () => {
  let controller: MemoryController;
  let extractionService: jest.Mocked<Partial<ExtractionService>>;
  let repository: jest.Mocked<Partial<PrismaMemoryItemRepository>>;

  beforeEach(async () => {
    extractionService = {
      extractFromEvent: jest.fn().mockReturnValue([]),
      recordDecision: jest.fn(),
    };

    repository = {
      upsert: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryController,
        { provide: ExtractionService, useValue: extractionService },
        { provide: PrismaMemoryItemRepository, useValue: repository },
      ],
    }).compile();

    controller = module.get<MemoryController>(MemoryController);

    jest.clearAllMocks();
  });

  describe('extractFromEvent', () => {
    it('returns empty items when projectId is missing', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const result = await controller.extractFromEvent({}, principal);
      expect(result).toEqual({ items: [] });
    });

    it('returns empty items when actor role is not permitted', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);
      const result = await controller.extractFromEvent({ projectId: 'project-123' }, principal);
      expect(result).toEqual({ items: [] });
    });

    it('returns empty items when role is VIEWER', async () => {
      const principal = makeUserPrincipal(ActorRole.VIEWER);
      const result = await controller.extractFromEvent({ projectId: 'project-123' }, principal);
      expect(result).toEqual({ items: [] });
    });

    it('extracts and upserts items for ADMIN user', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const extracted = [
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          object: 'active',
          confidence: 0.9,
        },
      ];
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue(extracted);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const event = {
        type: 'ticket_event',
        id: 'evt-1',
        projectId: 'project-123',
        actorId: 'actor-1',
        action: 'status_changed',
        data: { newStatus: 'active' },
      };

      const result = await controller.extractFromEvent(event, principal);

      expect(extractionService.extractFromEvent).toHaveBeenCalledWith(event);
      expect(repository.upsert).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(1);
    });

    it('extracts and upserts items for DEVELOPER user', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.9,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent({ projectId: 'project-123' }, principal);
      expect(result.items).toHaveLength(1);
    });

    it('allows agent principals to extract', async () => {
      const principal = makeAgentPrincipal();
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.9,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent({ projectId: 'project-123' }, principal);
      expect(result.items).toHaveLength(1);
    });

    it('returns empty items array when extraction yields no items', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([]);

      const result = await controller.extractFromEvent({ projectId: 'project-123' }, principal);
      expect(result).toEqual({ items: [] });
      expect(repository.upsert).not.toHaveBeenCalled();
    });
  });

  describe('recordDecision', () => {
    it('delegates to extractionService.recordDecision and returns the result', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const writeResult = { canonicalId: 'src-1', memoryId: 'mem-1' };
      (extractionService.recordDecision as jest.Mock).mockResolvedValue(writeResult);

      const input = {
        projectId: 'project-123',
        actorId: 'actor-1',
        topic: 'architecture',
        decision: 'use microservices',
        rationale: 'scalability',
        sourceId: 'src-1',
      };

      const result = await controller.recordDecision(input, principal);

      expect(extractionService.recordDecision).toHaveBeenCalledWith(
        {
          projectId: 'project-123',
          actorId: 'actor-1',
          topic: 'architecture',
          decision: 'use microservices',
          rationale: 'scalability',
          sourceId: 'src-1',
        },
        repository,
      );
      expect(result).toEqual(writeResult);
    });
  });

  describe('createMemory', () => {
    it('creates a memory item for ADMIN user', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const created = makeMemoryItem();
      (repository.upsert as jest.Mock).mockResolvedValue(created);

      const input = {
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'active',
      };

      const result = await controller.createMemory(input, principal);

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          object: 'active',
          sourceType: 'manual',
          confidence: 0.8,
          ownerId: 'user-1',
        }),
      );
      expect(result).toEqual(created);
    });

    it('returns ACCESS_DENIED for MEMBER user', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);

      const result = await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
        },
        principal,
      );

      expect(result).toEqual({ error: 'ACCESS_DENIED' });
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('returns ACCESS_DENIED for VIEWER user', async () => {
      const principal = makeUserPrincipal(ActorRole.VIEWER);

      const result = await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
        },
        principal,
      );

      expect(result).toEqual({ error: 'ACCESS_DENIED' });
    });

    it('uses provided ownerId over principal id', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          ownerId: 'custom-owner',
        },
        principal,
      );

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'custom-owner' }),
      );
    });

    it('uses provided confidence over default 0.8', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.5,
        },
        principal,
      );

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ confidence: 0.5 }),
      );
    });

    it('allows agent principals to create memory', async () => {
      const principal = makeAgentPrincipal();
      const created = makeMemoryItem();
      (repository.upsert as jest.Mock).mockResolvedValue(created);

      const result = await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
        },
        principal,
      );

      expect(result).toEqual(created);
    });
  });
});
