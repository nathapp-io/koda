import { SloDashboardService, MemoryQueryMetricInput, SloMetrics } from './slo-dashboard.service';
import { PrismaMonitoringRepository } from './prisma-monitoring.repository';

function createMockRepository(): jest.Mocked<PrismaMonitoringRepository> {
  return {
    createQueryMetric: jest.fn(),
    findQueryMetrics: jest.fn(),
    countMemoryItems: jest.fn(),
  } as unknown as jest.Mocked<PrismaMonitoringRepository>;
}

function makeMetric(overrides: Partial<MemoryQueryMetricInput> = {}): MemoryQueryMetricInput {
  return {
    projectId: 'proj-1',
    intent: 'answer',
    latencyMs: 120,
    tokensUsed: 500,
    hadProvenance: true,
    staleHitCount: 1,
    resultCount: 5,
    leakageIncidentCount: 0,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    latencyMs: 120,
    hadProvenance: true,
    staleHitCount: 1,
    resultCount: 5,
    leakageIncidentCount: 0,
    ...overrides,
  };
}

describe('SloDashboardService', () => {
  let service: SloDashboardService;
  let repo: jest.Mocked<PrismaMonitoringRepository>;

  beforeEach(() => {
    repo = createMockRepository();
    service = new SloDashboardService(repo);
  });

  describe('recordQueryMetric', () => {
    // AC-1: recordQueryMetric() persists a MemoryQueryMetric record with fields:
    // projectId, latencyMs, intent, tokensUsed, hadProvenance, staleHitCount, resultCount, and createdAt
    it('persists all required fields via repository createQueryMetric', async () => {
      const input = makeMetric();
      repo.createQueryMetric.mockResolvedValue(undefined);

      await service.recordQueryMetric(input);

      expect(repo.createQueryMetric).toHaveBeenCalledTimes(1);
      const callData = repo.createQueryMetric.mock.calls[0][0];
      expect(callData.projectId).toBe('proj-1');
      expect(callData.intent).toBe('answer');
      expect(callData.latencyMs).toBe(120);
      expect(callData.tokensUsed).toBe(500);
      expect(callData.hadProvenance).toBe(true);
      expect(callData.staleHitCount).toBe(1);
      expect(callData.resultCount).toBe(5);
      expect(callData.leakageIncidentCount).toBe(0);
    });

    it('accepts optional tokensUsed as undefined', async () => {
      const input = makeMetric({ tokensUsed: undefined });
      repo.createQueryMetric.mockResolvedValue(undefined);

      await service.recordQueryMetric(input);

      const callData = repo.createQueryMetric.mock.calls[0][0];
      expect(callData.tokensUsed).toBeNull();
    });

    it('defaults staleHitCount to 0 when not provided', async () => {
      const input = makeMetric({ staleHitCount: undefined as unknown as number });
      repo.createQueryMetric.mockResolvedValue(undefined);

      await service.recordQueryMetric(input);

      const callData = repo.createQueryMetric.mock.calls[0][0];
      expect(callData.staleHitCount).toBe(0);
    });

    it('defaults resultCount to 0 when not provided', async () => {
      const input = makeMetric({ resultCount: undefined as unknown as number });
      repo.createQueryMetric.mockResolvedValue(undefined);

      await service.recordQueryMetric(input);

      const callData = repo.createQueryMetric.mock.calls[0][0];
      expect(callData.resultCount).toBe(0);
    });

    it('defaults leakageIncidentCount to 0 when not provided', async () => {
      const input = makeMetric({ leakageIncidentCount: undefined as unknown as number });
      repo.createQueryMetric.mockResolvedValue(undefined);

      await service.recordQueryMetric(input);

      const callData = repo.createQueryMetric.mock.calls[0][0];
      expect(callData.leakageIncidentCount).toBe(0);
    });
  });

  describe('getSloMetrics', () => {
    const timeWindow = { from: new Date('2026-05-01T00:00:00Z'), to: new Date('2026-05-08T00:00:00Z') };

    // AC-2: getSloMetrics computes p50, p95, and p99 latency percentiles
    it('computes p50, p95, p99 latency percentiles from records in time window', async () => {
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const records = latencies.map((ms) => makeRecord({ latencyMs: ms }));
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(35);

      const result = await service.getSloMetrics(timeWindow);

      expect(repo.findQueryMetrics).toHaveBeenCalledWith(timeWindow);
      expect(result.retrievalLatency.sampleCount).toBe(10);
      expect(result.retrievalLatency.p50).toBe(55);
      expect(result.retrievalLatency.p95).toBe(95.5);
      expect(result.retrievalLatency.p99).toBe(99.1);
    });

    it('returns p50 <= p95 <= p99 for any dataset', async () => {
      const records = [makeRecord({ latencyMs: 300 }), makeRecord({ latencyMs: 100 }), makeRecord({ latencyMs: 200 })];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(10);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.retrievalLatency.p50).toBeLessThanOrEqual(result.retrievalLatency.p95);
      expect(result.retrievalLatency.p95).toBeLessThanOrEqual(result.retrievalLatency.p99);
    });

    it('returns all zeros when no records in time window', async () => {
      repo.findQueryMetrics.mockResolvedValue([]);
      repo.countMemoryItems.mockResolvedValue(0);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.retrievalLatency.sampleCount).toBe(0);
      expect(result.retrievalLatency.p50).toBe(0);
      expect(result.retrievalLatency.p95).toBe(0);
      expect(result.retrievalLatency.p99).toBe(0);
      expect(result.staleHitRate).toBe(0);
      expect(result.provenanceCoverage).toBe(0);
      expect(result.leakageIncidents).toBe(0);
      expect(result.memoryGrowthRate).toBe(0);
    });

    // AC-3: staleHitRate = sum(staleHitCount) / sum(resultCount), returns 0 when sum(resultCount) == 0
    it('computes staleHitRate as sum(staleHitCount) / sum(resultCount)', async () => {
      const records = [
        makeRecord({ staleHitCount: 2, resultCount: 10 }),
        makeRecord({ staleHitCount: 3, resultCount: 10 }),
      ];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(14);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.staleHitRate).toBe(5 / 20); // 2+3 / 10+10
    });

    it('returns staleHitRate 0 when resultCount sum is 0', async () => {
      const records = [
        makeRecord({ staleHitCount: 5, resultCount: 0 }),
        makeRecord({ staleHitCount: 10, resultCount: 0 }),
      ];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(7);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.staleHitRate).toBe(0);
    });

    it('clamps staleHitRate to [0, 1]', async () => {
      // edge case: staleHitCount > resultCount
      const records = [
        makeRecord({ staleHitCount: 100, resultCount: 10 }),
      ];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(7);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.staleHitRate).toBe(1);
    });

    // AC-4: provenanceCoverage = count(hadProvenance=true) / count(total queries)
    it('computes provenanceCoverage as ratio of queries with provenance', async () => {
      const records = [
        makeRecord({ hadProvenance: true }),
        makeRecord({ hadProvenance: false }),
        makeRecord({ hadProvenance: true }),
        makeRecord({ hadProvenance: true }),
      ];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(21);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.provenanceCoverage).toBe(3 / 4);
    });

    it('returns provenanceCoverage 0 when no queries in window', async () => {
      repo.findQueryMetrics.mockResolvedValue([]);
      repo.countMemoryItems.mockResolvedValue(0);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.provenanceCoverage).toBe(0);
    });

    it('clamps provenanceCoverage to [0, 1]', async () => {
      // should never happen for a ratio of booleans, but test the clamp exists
      const records = [
        makeRecord({ hadProvenance: true }),
      ];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(7);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.provenanceCoverage).toBe(1);
    });

    // AC-6: leakageIncidents = sum(leakageIncidentCount)
    it('computes leakageIncidents as sum of leakageIncidentCount', async () => {
      const records = [
        makeRecord({ leakageIncidentCount: 3 }),
        makeRecord({ leakageIncidentCount: 0 }),
        makeRecord({ leakageIncidentCount: 2 }),
      ];
      repo.findQueryMetrics.mockResolvedValue(records as any);
      repo.countMemoryItems.mockResolvedValue(14);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.leakageIncidents).toBe(5);
    });

    it('computes memoryGrowthRate from MemoryItem.createdAt (7-day rolling average)', async () => {
      repo.findQueryMetrics.mockResolvedValue([]);
      repo.countMemoryItems.mockResolvedValue(70);

      const result = await service.getSloMetrics(timeWindow);

      expect(result.memoryGrowthRate).toBe(10); // 70 / 7
      expect(repo.countMemoryItems).toHaveBeenCalledWith({
        from: expect.any(Date),
        to: expect.any(Date),
      });
    });
  });

  describe('recordStaleHit', () => {
    it('creates a minimal metric record with staleHitCount=1', async () => {
      repo.createQueryMetric.mockResolvedValue(undefined);

      await service.recordStaleHit('proj-1', 'doc-42');

      expect(repo.createQueryMetric).toHaveBeenCalledTimes(1);
      const callData = repo.createQueryMetric.mock.calls[0][0];
      expect(callData.projectId).toBe('proj-1');
      expect(callData.intent).toBe('search');
      expect(callData.staleHitCount).toBe(1);
      expect(callData.resultCount).toBe(1);
      expect(callData.hadProvenance).toBe(true);
      expect(callData.latencyMs).toBe(0);
    });
  });
});
