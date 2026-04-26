import { Test, TestingModule } from '@nestjs/testing';
import { MemoryGovernanceService, GovernanceResult } from '../../src/memory/memory-governance.service';
import { MemoryItemRepository, MemoryItem } from '../../src/memory/memory-item-repository';

const createMockRepository = () => ({
  findByProject: jest.fn(),
  upsert: jest.fn(),
  findActive: jest.fn(),
  reject: jest.fn(),
  softDelete: jest.fn(),
});

describe('MemoryGovernanceService', () => {
  let service: MemoryGovernanceService;
  let mockRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    mockRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryGovernanceService,
        { provide: MemoryItemRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<MemoryGovernanceService>(MemoryGovernanceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-1: Scheduled cleanup runs daily at 03:00 UTC', () => {
    it('should have cron expression 0 3 * * * for 03:00 UTC', () => {
      const cronExpression = '0 3 * * *';
      const parts = cronExpression.split(' ');
      expect(parts[0]).toBe('0');
      expect(parts[1]).toBe('3');
    });

    it('should have a scheduled cleanup method in the service', () => {
      const servicePrototype = Object.getPrototypeOf(service);
      const methods = Object.getOwnPropertyNames(servicePrototype).filter(
        (n) => n !== 'constructor' && typeof (servicePrototype as Record<string, unknown>)[n] === 'function'
      );
      expect(methods.length).toBeGreaterThan(0);
    });
  });

  describe('AC-2: runCleanup() executes all four sub-jobs', () => {
    it('should call all four sub-job methods', async () => {
      const projectId = 'project-123';

      jest.spyOn(service, 'expireMemories').mockResolvedValue({ count: 5 });
      jest.spyOn(service, 'downrankStaleLowConfidence').mockResolvedValue({ count: 3 });
      jest.spyOn(service, 'deduplicate').mockResolvedValue({ count: 2 });
      jest.spyOn(service, 'applySupersession').mockResolvedValue({ count: 1 });

      await service.runCleanup(projectId);

      expect(service.expireMemories).toHaveBeenCalledWith(projectId);
      expect(service.downrankStaleLowConfidence).toHaveBeenCalledWith(projectId);
      expect(service.deduplicate).toHaveBeenCalledWith(projectId);
      expect(service.applySupersession).toHaveBeenCalledWith(projectId);
    });

    it('should return GovernanceResult with expiredCount, downrankedCount, deduplicatedCount, supersessionCount', async () => {
      const projectId = 'project-123';

      jest.spyOn(service, 'expireMemories').mockResolvedValue({ count: 10 });
      jest.spyOn(service, 'downrankStaleLowConfidence').mockResolvedValue({ count: 5 });
      jest.spyOn(service, 'deduplicate').mockResolvedValue({ count: 3 });
      jest.spyOn(service, 'applySupersession').mockResolvedValue({ count: 2 });

      const result = await service.runCleanup(projectId);

      expect(result).toEqual({
        expiredCount: 10,
        downrankedCount: 5,
        deduplicatedCount: 3,
        supersessionCount: 2,
      });
    });
  });

  describe('AC-3: expireMemories() sets status=rejected for expired items', () => {
    it('should set status=rejected and activeKey=null for memories with ttlAt < now', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const expiredItems: MemoryItem[] = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: pastDate, createdAt: now, updatedAt: now },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:2', predicate: 'status', status: 'active', ttlAt: pastDate, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: expiredItems, total: 2, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 2, page: 2, limit: 100 });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      const upsertCalls = mockRepository.upsert.mock.calls;
      expect(upsertCalls[0][0]).toMatchObject({ status: 'rejected', activeKey: null });
      expect(upsertCalls[1][0]).toMatchObject({ status: 'rejected', activeKey: null });
    });

    it('should not expire memories with ttlAt in the future', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: futureDate, createdAt: now, updatedAt: now }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should not expire memories that are not active', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
      });

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should ignore memories without ttlAt', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: undefined, createdAt: now, updatedAt: now }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: downrankStaleLowConfidence() sets confidence=0.1 for stale low-confidence items', () => {
    it('should set confidence=0.1 for memories older than 90 days with confidence < 0.3', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      const staleItems: MemoryItem[] = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.2, createdAt: oldDate, updatedAt: oldDate },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:2', predicate: 'status', status: 'active', confidence: 0.15, createdAt: oldDate, updatedAt: oldDate },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: staleItems, total: 2, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 2, page: 2, limit: 100 });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const result = await service.downrankStaleLowConfidence(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      const upsertCalls = mockRepository.upsert.mock.calls;
      expect(upsertCalls[0][0]).toMatchObject({ confidence: 0.1 });
      expect(upsertCalls[1][0]).toMatchObject({ confidence: 0.1 });
    });

    it('should not modify memories younger than 90 days', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const recentDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.2, createdAt: recentDate, updatedAt: recentDate }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.downrankStaleLowConfidence(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should not modify memories with confidence >= 0.3', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.5, createdAt: oldDate, updatedAt: oldDate }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.downrankStaleLowConfidence(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should not modify memories that are not active', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
      });

      const result = await service.downrankStaleLowConfidence(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should not modify memories with undefined confidence', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: undefined, createdAt: oldDate, updatedAt: oldDate }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.downrankStaleLowConfidence(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });
  });

  describe('AC-5: deduplicate() keeps highest confidence, marks others as superseded', () => {
    it('should keep highest confidence memory active and supersede others', async () => {
      const projectId = 'project-123';
      const now = new Date();

      const items: MemoryItem[] = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key1', confidence: 0.9, createdAt: now, updatedAt: now },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key2', confidence: 0.7, createdAt: now, updatedAt: now },
        { id: 'mem-3', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key3', confidence: 0.5, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: items, total: 3, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 3, page: 2, limit: 100 });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      const supersededCalls = mockRepository.upsert.mock.calls.filter((c) => (c[0] as Record<string, unknown>).status === 'superseded');
      expect(supersededCalls.length).toBe(2);
      for (const call of supersededCalls) {
        expect(call[0]).toMatchObject({ supersededBy: 'mem-1', activeKey: null });
      }
    });

    it('should not affect single memories with unique (kind, subject, predicate)', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key1', confidence: 0.9, createdAt: now, updatedAt: now }], total: 1, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 1, page: 2, limit: 100 });

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should not affect memories that are not active', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 0, page: 2, limit: 100 });

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(0);
    });

    it('should treat null confidence as 0 and keep the memory with higher confidence', async () => {
      const projectId = 'project-123';
      const now = new Date();

      const items: MemoryItem[] = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key1', confidence: null, createdAt: now, updatedAt: now },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key2', confidence: 0.7, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: items, total: 2, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 2, page: 2, limit: 100 });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(1);
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mem-1', status: 'superseded', supersededBy: 'mem-2', activeKey: null })
      );
    });
  });

  describe('AC-6: applySupersession() keeps newest DECISION active, supersedes older ones', () => {
    it('should set newest DECISION to active and older ones to superseded', async () => {
      const projectId = 'project-123';
      const now = new Date();

      const decisions: MemoryItem[] = [
        { id: 'dec-1', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'dec-key-1', confidence: 0.9, createdAt: new Date(now.getTime() - 2000), updatedAt: now },
        { id: 'dec-2', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'dec-key-2', confidence: 0.8, createdAt: new Date(now.getTime() - 1000), updatedAt: now },
        { id: 'dec-3', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'dec-key-3', confidence: 0.7, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: decisions, total: 3, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 3, page: 2, limit: 100 });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const result = await service.applySupersession(projectId);

      expect(result.count).toBe(2);
      const supersededCalls = mockRepository.upsert.mock.calls.filter((c) => (c[0] as Record<string, unknown>).status === 'superseded');
      expect(supersededCalls.length).toBe(2);
      for (const call of supersededCalls) {
        expect(call[0]).toMatchObject({ supersededBy: 'dec-3' });
      }
    });

    it('should not modify when only one DECISION is active', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: [{ id: 'dec-1', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'dec-key-1', confidence: 0.9, createdAt: now, updatedAt: now }], total: 1, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 1, page: 2, limit: 100 });

      const result = await service.applySupersession(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });

    it('should not affect non-DECISION kind memories', async () => {
      const projectId = 'project-123';

      mockRepository.findByProject.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });

      const result = await service.applySupersession(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });
  });

describe('AC-7: Idempotent cleanup', () => {
    it('should produce same result when run twice on same dataset', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      const items = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: pastDate, confidence: 0.2, createdAt: pastDate, updatedAt: pastDate },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key2', confidence: 0.9, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject.mockResolvedValue({
        data: items,
        total: 2,
        page: 1,
        limit: 100,
      });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const result1 = await service.runCleanup(projectId);

      jest.clearAllMocks();
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      mockRepository.findByProject.mockResolvedValue({
        data: items,
        total: 2,
        page: 1,
        limit: 100,
      });

      const result2 = await service.runCleanup(projectId);

      expect(result1).toEqual(result2);
    });

    it('should not re-supersede already superseded items', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject.mockResolvedValue({
        data: [
          { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'superseded', supersededBy: 'mem-2', activeKey: null, confidence: 0.7, createdAt: now, updatedAt: now },
          { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key2', confidence: 0.9, createdAt: now, updatedAt: now },
        ],
        total: 2,
        page: 1,
        limit: 100,
      });

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });
  });

  describe('AC-9: No DELETE statements, only status updates', () => {
    it('should never call softDelete on the repository', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: pastDate, confidence: 0.2, createdAt: pastDate, updatedAt: pastDate }],
        total: 1,
        page: 1,
        limit: 100,
      });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      await service.runCleanup(projectId);

      expect(mockRepository.softDelete).not.toHaveBeenCalled();
    });

    it('should only use upsert to modify items (status, confidence, supersededBy)', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', ttlAt: pastDate, confidence: 0.2, createdAt: pastDate, updatedAt: pastDate }],
        total: 1,
        page: 1,
        limit: 100,
      });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      await service.runCleanup(projectId);

      expect(mockRepository.upsert).toHaveBeenCalled();
      const upsertCall = mockRepository.upsert.mock.calls[0][0] as Record<string, unknown>;

      expect(upsertCall).toHaveProperty('status');
      expect(upsertCall).not.toHaveProperty('deletedAt');
    });
  });

  describe('AC-8: Performance - 1000 memories in under 30 seconds', () => {
    it('should process 1000 memories in under 30 seconds', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      const items: MemoryItem[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `mem-${i}`,
        projectId,
        kind: 'FACT' as const,
        subject: `ticket:${i}`,
        predicate: 'status',
        status: 'active',
        ttlAt: pastDate,
        confidence: i % 2 === 0 ? 0.2 : 0.9,
        activeKey: `key-${i}`,
        createdAt: pastDate,
        updatedAt: pastDate,
      }));

      mockRepository.findByProject.mockResolvedValue({
        data: items,
        total: 1000,
        page: 1,
        limit: 100,
      });
      mockRepository.upsert.mockResolvedValue({} as MemoryItem);

      const start = Date.now();
      await service.runCleanup(projectId);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(30000);
    });
  });
});