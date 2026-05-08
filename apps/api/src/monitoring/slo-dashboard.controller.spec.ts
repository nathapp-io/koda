import { SloDashboardController } from './slo-dashboard.controller';
import { SloDashboardService, SloMetrics } from './slo-dashboard.service';

function createMockSloDashboardService() {
  return {
    getSloMetrics: jest.fn(),
    recordQueryMetric: jest.fn(),
    recordStaleHit: jest.fn(),
  } as unknown as jest.Mocked<SloDashboardService>;
}

const sampleMetrics: SloMetrics = {
  retrievalLatency: {
    p50: 45,
    p95: 200,
    p99: 480,
    sampleCount: 150,
  },
  staleHitRate: 0.03,
  provenanceCoverage: 0.99,
  leakageIncidents: 0,
  memoryGrowthRate: 12.5,
};

describe('SloDashboardController', () => {
  let controller: SloDashboardController;
  let service: ReturnType<typeof createMockSloDashboardService>;

  beforeEach(() => {
    service = createMockSloDashboardService();
    controller = new SloDashboardController(service);
  });

  describe('GET /admin/slos', () => {
    // AC-7: GET /admin/slos?from=X&to=Y returns the full SloMetrics object as JSON
    it('calls getSloMetrics with parsed from/to dates and returns full SloMetrics', async () => {
      service.getSloMetrics.mockResolvedValue(sampleMetrics);

      const result = await controller.getSloMetrics('2026-05-01T00:00:00Z', '2026-05-08T00:00:00Z');

      expect(service.getSloMetrics).toHaveBeenCalledWith({
        from: new Date('2026-05-01T00:00:00Z'),
        to: new Date('2026-05-08T00:00:00Z'),
      });
      expect(result.ret).toBe(0);
      expect(result.data).toEqual(sampleMetrics);
    });

    it('supports missing from query param', async () => {
      service.getSloMetrics.mockResolvedValue(sampleMetrics);

      const result = await controller.getSloMetrics(undefined, '2026-05-08T00:00:00Z');

      expect(service.getSloMetrics).toHaveBeenCalledWith({
        from: expect.any(Date),
        to: new Date('2026-05-08T00:00:00Z'),
      });
      expect(result.ret).toBe(0);
    });

    it('supports missing to query param', async () => {
      service.getSloMetrics.mockResolvedValue(sampleMetrics);

      const result = await controller.getSloMetrics('2026-05-01T00:00:00Z', undefined);

      expect(service.getSloMetrics).toHaveBeenCalledWith({
        from: new Date('2026-05-01T00:00:00Z'),
        to: expect.any(Date),
      });
      expect(result.ret).toBe(0);
    });

    it('defaults to 7-day window when no params provided', async () => {
      service.getSloMetrics.mockResolvedValue(sampleMetrics);

      const before = Date.now();
      const result = await controller.getSloMetrics(undefined, undefined);
      const after = Date.now();

      const callArgs = service.getSloMetrics.mock.calls[0][0];
      expect(callArgs.to.getTime()).toBeGreaterThanOrEqual(before);
      expect(callArgs.to.getTime()).toBeLessThanOrEqual(after + 1000);
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      expect(callArgs.to.getTime() - callArgs.from.getTime()).toBe(weekMs);
      expect(result.ret).toBe(0);
    });

    it('wraps result with JsonResponse.Ok', async () => {
      service.getSloMetrics.mockResolvedValue(sampleMetrics);

      const result = await controller.getSloMetrics(undefined, undefined);

      expect(result.ret).toBe(0);
      expect(result.data).toBeDefined();
    });
  });
});
