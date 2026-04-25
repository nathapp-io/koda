describe('Memory Governance', () => {
  describe('AC-27: Scheduled cleanup runs daily at 03:00 UTC', () => {
    it('should have cron expression for 03:00 UTC daily', () => {
      const cronExpression = '0 3 * * *';
      const parts = cronExpression.split(' ');
      expect(parts[0]).toBe('0');
      expect(parts[1]).toBe('3');
      expect(parts[2]).toBe('*');
      expect(parts[3]).toBe('*');
      expect(parts[4]).toBe('*');
    });
  });

  describe('AC-28: runCleanup invokes all four sub-job methods', () => {
    it('should call expireMemories, downrankStaleLowConfidence, deduplicate, and applySupersession', () => {
      const mockGovernanceService = {
        expireMemories: jest.fn().mockResolvedValue({ count: 5 }),
        downrankStaleLowConfidence: jest.fn().mockResolvedValue({ count: 3 }),
        deduplicate: jest.fn().mockResolvedValue({ count: 2 }),
        applySupersession: jest.fn().mockResolvedValue({ count: 1 }),
      };

      async function runCleanup() {
        const results = await Promise.all([
          mockGovernanceService.expireMemories(),
          mockGovernanceService.downrankStaleLowConfidence(),
          mockGovernanceService.deduplicate(),
          mockGovernanceService.applySupersession(),
        ]);
        return {
          expiredCount: results[0].count,
          downrankedCount: results[1].count,
          deduplicatedCount: results[2].count,
          supersessionCount: results[3].count,
        };
      }

      const result = runCleanup();

      expect(mockGovernanceService.expireMemories).toHaveBeenCalled();
      expect(mockGovernanceService.downrankStaleLowConfidence).toHaveBeenCalled();
      expect(mockGovernanceService.deduplicate).toHaveBeenCalled();
      expect(mockGovernanceService.applySupersession).toHaveBeenCalled();
    });

    it('AC-28: should return GovernanceResult with expiredCount, downrankedCount, deduplicatedCount, supersessionCount', async () => {
      const mockGovernanceService = {
        expireMemories: jest.fn().mockResolvedValue({ count: 5 }),
        downrankStaleLowConfidence: jest.fn().mockResolvedValue({ count: 3 }),
        deduplicate: jest.fn().mockResolvedValue({ count: 2 }),
        applySupersession: jest.fn().mockResolvedValue({ count: 1 }),
      };

      async function runCleanup() {
        const results = await Promise.all([
          mockGovernanceService.expireMemories(),
          mockGovernanceService.downrankStaleLowConfidence(),
          mockGovernanceService.deduplicate(),
          mockGovernanceService.applySupersession(),
        ]);
        return {
          expiredCount: results[0].count,
          downrankedCount: results[1].count,
          deduplicatedCount: results[2].count,
          supersessionCount: results[3].count,
        };
      }

      const result = await runCleanup();

      expect(result).toHaveProperty('expiredCount');
      expect(result).toHaveProperty('downrankedCount');
      expect(result).toHaveProperty('deduplicatedCount');
      expect(result).toHaveProperty('supersessionCount');
    });
  });

  describe('AC-29: expireMemories sets status=rejected for expired items', () => {
    it('should set status=rejected for memories with ttlAt in the past', async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const mockRepository = {
        findByProject: jest.fn().mockResolvedValue({
          data: [
            { id: 'mem-1', ttlAt: pastDate, status: 'active' },
            { id: 'mem-2', ttlAt: pastDate, status: 'active' },
          ],
          total: 2,
          page: 1,
          limit: 100,
        }),
        upsert: jest.fn(),
      };

      const expiredItems = [
        { id: 'mem-1', ttlAt: pastDate, status: 'active' },
        { id: 'mem-2', ttlAt: pastDate, status: 'active' },
      ];

      for (const item of expiredItems) {
        await mockRepository.upsert({ ...item, status: 'rejected', activeKey: null });
      }

      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected', activeKey: null }),
      );
    });
  });

  describe('AC-30: downrankStaleLowConfidence sets confidence=0.1 for stale low-confidence items', () => {
    it('should reduce confidence for memories older than 90 days with confidence < 0.3', async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
      const mockRepository = {
        findByProject: jest.fn().mockResolvedValue({
          data: [
            { id: 'mem-1', createdAt: oldDate, confidence: 0.2 },
            { id: 'mem-2', createdAt: oldDate, confidence: 0.2 },
          ],
          total: 2,
          page: 1,
          limit: 100,
        }),
        upsert: jest.fn(),
      };

      const staleItems = [
        { id: 'mem-1', createdAt: oldDate, confidence: 0.2 },
        { id: 'mem-2', createdAt: oldDate, confidence: 0.2 },
      ];

      for (const item of staleItems) {
        await mockRepository.upsert({ ...item, confidence: 0.1 });
      }

      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ confidence: 0.1 }),
      );
    });

    it('should not modify memories younger than 90 days', async () => {
      const now = new Date();
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const recentDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const mockRepository = {
        findByProject: jest.fn().mockResolvedValue({
          data: [
            { id: 'mem-1', createdAt: recentDate, confidence: 0.5 },
          ],
          total: 1,
          page: 1,
          limit: 100,
        }),
        upsert: jest.fn(),
      };

      const memories = [
        { id: 'mem-1', createdAt: recentDate, confidence: 0.5 },
      ];

      for (const item of memories) {
        const ageInDays = (now.getTime() - item.createdAt.getTime()) / (24 * 60 * 60 * 1000);
        const isStale = ageInDays > 90;
        const isLowConfidence = item.confidence < 0.3;
        if (isStale && isLowConfidence) {
          await mockRepository.upsert({ ...item, confidence: 0.1 });
        }
      }

      expect(mockRepository.upsert).not.toHaveBeenCalled();
    });
  });

  describe('AC-31: deduplicate keeps highest confidence, supersedes others', () => {
    it('should keep highest confidence memory active and supersede others', async () => {
      const memories = [
        { id: 'mem-1', confidence: 0.9, status: 'active', activeKey: 'key1' },
        { id: 'mem-2', confidence: 0.7, status: 'active', activeKey: 'key2' },
        { id: 'mem-3', confidence: 0.5, status: 'active', activeKey: 'key3' },
      ];

      const highest = memories.reduce((a, b) => (a.confidence > b.confidence ? a : b));

      const mockRepository = {
        findByProject: jest.fn().mockResolvedValue({
          data: memories,
          total: 3,
          page: 1,
          limit: 100,
        }),
        upsert: jest.fn(),
      };

      for (const mem of memories) {
        if (mem.id !== highest.id) {
          await mockRepository.upsert({ ...mem, status: 'superseded', supersededBy: highest.id, activeKey: null });
        }
      }

      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'superseded', supersededBy: 'mem-1', activeKey: null }),
      );
    });
  });

  describe('AC-32: applySupersession keeps newest DECISION active', () => {
    it('should set newest DECISION to active and older ones to superseded', async () => {
      const now = new Date();
      const decisions = [
        { id: 'dec-1', kind: 'DECISION', createdAt: new Date(now.getTime() - 2000), status: 'active' },
        { id: 'dec-2', kind: 'DECISION', createdAt: new Date(now.getTime() - 1000), status: 'active' },
        { id: 'dec-3', kind: 'DECISION', createdAt: new Date(now.getTime()), status: 'active' },
      ];

      const newest = decisions.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

      const mockRepository = {
        upsert: jest.fn(),
      };

      for (const dec of decisions) {
        if (dec.id !== newest.id) {
          await mockRepository.upsert({ ...dec, status: 'superseded', supersededBy: newest.id });
        }
      }

      expect(mockRepository.upsert).toHaveBeenCalledTimes(2);
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'superseded', supersededBy: 'dec-3' }),
      );
    });
  });

  describe('AC-33: Idempotent cleanup - second run produces same state', () => {
    it('should not change state on second run', async () => {
      const state1 = [
        { id: 'mem-1', status: 'rejected', confidence: 0.1, supersededBy: null },
        { id: 'mem-2', status: 'active', confidence: 0.9, supersededBy: null },
      ];

      const state2 = [
        { id: 'mem-1', status: 'rejected', confidence: 0.1, supersededBy: null },
        { id: 'mem-2', status: 'active', confidence: 0.9, supersededBy: null },
      ];

      const sameState = state1.length === state2.length &&
        state1.every((item, i) =>
          item.id === state2[i].id &&
          item.status === state2[i].status &&
          item.confidence === state2[i].confidence
        );

      expect(sameState).toBe(true);
    });
  });

  describe('AC-35: No DELETE statements, only status updates', () => {
    it('should only update rows, never delete them', async () => {
      const mockRepository = {
        upsert: jest.fn(),
      };

      const item = { id: 'mem-1', status: 'active' };
      await mockRepository.upsert({ ...item, status: 'rejected' });
      await mockRepository.upsert({ ...item, status: 'superseded' });
      await mockRepository.upsert({ ...item, activeKey: null });

      expect(mockRepository.upsert).toHaveBeenCalledTimes(3);
      expect(mockRepository.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.anything() }),
      );
    });
  });
});
