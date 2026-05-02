import { Test, TestingModule } from '@nestjs/testing';
import { MemoryGovernanceService, GovernanceResult } from './memory-governance.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItem } from './memory-item-repository';

const createMockRepository = () => ({
  findByProject: jest.fn(),
  findByProjectMemory: jest.fn(),
  upsert: jest.fn(),
  findActive: jest.fn(),
  updateDirect: jest.fn(),
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
        { provide: PrismaMemoryItemRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<MemoryGovernanceService>(MemoryGovernanceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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

    it('should return GovernanceResult with all counts and durationMs', async () => {
      const projectId = 'project-123';

      jest.spyOn(service, 'expireMemories').mockResolvedValue({ count: 10 });
      jest.spyOn(service, 'downrankStaleLowConfidence').mockResolvedValue({ count: 5 });
      jest.spyOn(service, 'deduplicate').mockResolvedValue({ count: 3 });
      jest.spyOn(service, 'applySupersession').mockResolvedValue({ count: 2 });

      const result = await service.runCleanup(projectId);

      expect(result).toMatchObject({
        expiredCount: 10,
        downrankedCount: 5,
        deduplicatedCount: 3,
        supersessionCount: 2,
      });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AC-3: expireMemories() sets status=rejected for expired items', () => {
    it('should set status=rejected and activeKey=null for memories with ttlAt < now', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const expiredItems: MemoryItem[] = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.8, ttlAt: pastDate, activeKey: 'FACT:ticket:1:status', createdAt: now, updatedAt: now },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:2', predicate: 'status', status: 'active', confidence: 0.8, ttlAt: pastDate, activeKey: 'FACT:ticket:2:status', createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: expiredItems, total: 2, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 2, page: 2, limit: 100 });
      mockRepository.updateDirect.mockResolvedValue(undefined);

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledTimes(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-1', expect.objectContaining({ status: 'rejected', activeKey: null }));
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-2', expect.objectContaining({ status: 'rejected', activeKey: null }));
    });

    it('should not expire memories with ttlAt in the future', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.8, ttlAt: futureDate, createdAt: now, updatedAt: now }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });

    it('should not expire memories that are not active', async () => {
      const projectId = 'project-123';

      mockRepository.findByProject.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
      });

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });

    it('should ignore memories without ttlAt', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.8, ttlAt: undefined as unknown as null, createdAt: now, updatedAt: now }],
        total: 1,
        page: 1,
        limit: 100,
      });

      const result = await service.expireMemories(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: downrankStaleLowConfidence() sets confidence=0.1', () => {
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
      mockRepository.updateDirect.mockResolvedValue(undefined);

      const result = await service.downrankStaleLowConfidence(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledTimes(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-1', expect.objectContaining({ confidence: 0.1 }));
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-2', expect.objectContaining({ confidence: 0.1 }));
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
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
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
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });
  });

  describe('AC-5: deduplicate() keeps highest confidence, marks others as superseded', () => {
    it('should keep highest confidence memory active and supersede others', async () => {
      const projectId = 'project-123';
      const now = new Date();

      const items: MemoryItem[] = [
        { id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'FACT:ticket:1:status', confidence: 0.9, createdAt: now, updatedAt: now },
        { id: 'mem-2', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'FACT:ticket:1:status-2', confidence: 0.7, createdAt: now, updatedAt: now },
        { id: 'mem-3', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'FACT:ticket:1:status-3', confidence: 0.5, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: items, total: 3, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 3, page: 2, limit: 100 });
      mockRepository.updateDirect.mockResolvedValue(undefined);

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledTimes(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-2', expect.objectContaining({ status: 'superseded', supersededBy: 'mem-1', activeKey: null }));
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-3', expect.objectContaining({ status: 'superseded', supersededBy: 'mem-1', activeKey: null }));
    });

    it('should not affect single memories with unique (kind, subject, predicate)', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', activeKey: 'key1', confidence: 0.9, createdAt: now, updatedAt: now }], total: 1, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 1, page: 2, limit: 100 });

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });

    it('should not supersede items without activeKey', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 0, page: 2, limit: 100 });

      const result = await service.deduplicate(projectId);

      expect(result.count).toBe(0);
    });
  });

  describe('AC-6: applySupersession() keeps newest DECISION active', () => {
    it('should set newest DECISION active and supersede older ones', async () => {
      const projectId = 'project-123';
      const now = new Date();

      const decisions: MemoryItem[] = [
        { id: 'dec-1', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'DECISION:topic:a:resolution', confidence: 0.9, createdAt: new Date(now.getTime() - 2000), updatedAt: now },
        { id: 'dec-2', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'DECISION:topic:a:resolution-2', confidence: 0.8, createdAt: new Date(now.getTime() - 1000), updatedAt: now },
        { id: 'dec-3', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'DECISION:topic:a:resolution-3', confidence: 0.7, createdAt: now, updatedAt: now },
      ];

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: decisions, total: 3, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 3, page: 2, limit: 100 });
      mockRepository.updateDirect.mockResolvedValue(undefined);

      const result = await service.applySupersession(projectId);

      expect(result.count).toBe(2);
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'superseded', supersededBy: 'dec-3', activeKey: null }));
      expect(mockRepository.updateDirect).toHaveBeenCalledWith('dec-2', expect.objectContaining({ status: 'superseded', supersededBy: 'dec-3', activeKey: null }));
    });

    it('should not modify when only one DECISION is active', async () => {
      const projectId = 'project-123';
      const now = new Date();

      mockRepository.findByProject
        .mockResolvedValueOnce({ data: [{ id: 'dec-1', projectId, kind: 'DECISION', subject: 'topic:a', predicate: 'resolution', status: 'active', activeKey: 'dec-key-1', confidence: 0.9, createdAt: now, updatedAt: now }], total: 1, page: 1, limit: 100 })
        .mockResolvedValueOnce({ data: [], total: 1, page: 2, limit: 100 });

      const result = await service.applySupersession(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });

    it('should not affect non-DECISION kind memories', async () => {
      const projectId = 'project-123';

      mockRepository.findByProject.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });

      const result = await service.applySupersession(projectId);

      expect(result.count).toBe(0);
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });
  });

  describe('AC-7: Idempotent cleanup', () => {
    it('should not re-supersede already superseded items (no activeKey)', async () => {
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
      expect(mockRepository.updateDirect).not.toHaveBeenCalled();
    });
  });

  describe('AC-9: No DELETE statements, only status updates', () => {
    it('should never call softDelete on the repository', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.8, ttlAt: pastDate, createdAt: pastDate, updatedAt: pastDate }],
        total: 1,
        page: 1,
        limit: 100,
      });
      mockRepository.updateDirect.mockResolvedValue(undefined);

      await service.runCleanup(projectId);

      expect(mockRepository.softDelete).not.toHaveBeenCalled();
    });

    it('should only use updateDirect to modify items', async () => {
      const projectId = 'project-123';
      const now = new Date();
      const pastDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      mockRepository.findByProject.mockResolvedValue({
        data: [{ id: 'mem-1', projectId, kind: 'FACT', subject: 'ticket:1', predicate: 'status', status: 'active', confidence: 0.8, ttlAt: pastDate, createdAt: pastDate, updatedAt: pastDate }],
        total: 1,
        page: 1,
        limit: 100,
      });
      mockRepository.updateDirect.mockResolvedValue(undefined);

      await service.runCleanup(projectId);

      expect(mockRepository.updateDirect).toHaveBeenCalled();
      const call = mockRepository.updateDirect.mock.calls[0];
      expect(call[0]).toBe('mem-1');
      expect(call[1]).toHaveProperty('status');
    });
  });
});